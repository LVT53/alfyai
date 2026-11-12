import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { parseJsonRecord } from "$lib/server/utils/json";
import type {
	NormalChatCompletion,
	NormalChatFinalizationFailure,
	NormalChatStopCause,
} from "$lib/shared/normal-chat-completion";
import { parseNormalChatFinalization } from "$lib/shared/normal-chat-completion";
import { db } from "../../db";
import {
	conversations,
	messages,
	normalChatAttempts,
	normalChatTurns,
} from "../../db/schema";
import {
	linkNormalChatMessageAccounting,
	priceNormalChatAttempt,
	recordNormalChatAttemptAccounting,
} from "../analytics";
import {
	logTurnSettled,
	runLogAttemptFromLedger,
	settleRunLog,
} from "./run-log";
import {
	withTurnLedgerStorage as durable,
	TurnLedgerConflictError,
	TurnLedgerScopeError,
	TurnLedgerStorageError,
} from "./turn-ledger-errors";

export {
	TurnLedgerConflictError,
	TurnLedgerScopeError,
	TurnLedgerStorageError,
} from "./turn-ledger-errors";

export type TurnScope = {
	userId: string;
	conversationId: string;
	turnId: string;
	segmentId: string;
};
export type TurnRecord = typeof normalChatTurns.$inferSelect;
export type TurnOutcome = NormalChatCompletion["outcome"];
export type TurnStopCause = NormalChatStopCause;
export type TurnTerminal = Omit<
	NormalChatCompletion,
	"version" | "turnId" | "segmentId"
> & {
	recoveryCount: number;
	attemptIds: readonly string[];
	messageId?: string | null;
};
export type TurnAttempt = {
	attemptId: string;
	phase: "working" | "closing";
	providerId: string | null;
	modelId: string;
	/** Configured alias initially; authoritative response name may refine it before billing. */
	providerModelName: string;
	safeStopCause: TurnStopCause | null;
	outcome: TurnOutcome | null;
	/** One authoritative attempt total, never SDK cumulative plus step totals. */
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	cachedInputTokens?: number | null;
	cacheHitTokens?: number | null;
	cacheMissTokens?: number | null;
	reasoningTokens?: number | null;
	generationTimeMs?: number | null;
	/** False until usage is final. Unknown final usage still cannot become ready. */
	usageFinal: boolean;
};

/** A separate persistence fact: never rewrite a sealed model terminal or priced attempt. */
export function recordFileAssociationFailure(
	input: {
		userId: string;
		conversationId: string;
		messageId: string;
		wasStopped: boolean;
	} & (
		| { mode: "tracked"; segmentId: string; turnId: string }
		| { mode: "untracked" }
	),
): NormalChatFinalizationFailure {
	return durable(() =>
		db.transaction((tx) => {
			const chat = tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.id, input.conversationId),
						eq(conversations.userId, input.userId),
					),
				)
				.get();
			const message = tx
				.select()
				.from(messages)
				.where(
					and(
						eq(messages.id, input.messageId),
						eq(messages.conversationId, input.conversationId),
						eq(messages.role, "assistant"),
					),
				)
				.get();
			if (!chat || !message)
				throw new TurnLedgerScopeError("Finalization message scope denied");
			if (input.mode === "tracked") {
				if (!input.segmentId || !input.turnId)
					throw new TurnLedgerScopeError("Missing finalization turn identity");
				requireTurn(tx, input);
				linkNormalChatMessageAccounting(tx, {
					...input,
					segmentId: input.segmentId,
				});
			} else if (input.mode !== "untracked")
				throw new TurnLedgerScopeError("Finalization tracking mode required");
			const metadata = parseJsonRecord(message.metadataJson) ?? {};
			const old = parseNormalChatFinalization(metadata.normalChatFinalization);
			const marker: NormalChatFinalizationFailure = {
				version: 1,
				status: "failed",
				cause: "file_association_failed",
				wasStopped: input.wasStopped || old?.wasStopped === true,
			};
			tx.update(messages)
				.set({
					metadataJson: JSON.stringify({
						...metadata,
						normalChatFinalization: marker,
					}),
				})
				.where(eq(messages.id, message.id))
				.run();
			return marker;
		}),
	);
}
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
function scoped(scope: TurnScope) {
	return and(
		eq(normalChatTurns.segmentId, scope.segmentId),
		eq(normalChatTurns.turnId, scope.turnId),
		eq(normalChatTurns.conversationId, scope.conversationId),
	);
}
function requireTurn(tx: Tx, scope: TurnScope): TurnRecord {
	const row = tx.select().from(normalChatTurns).where(scoped(scope)).get();
	const chat = tx
		.select()
		.from(conversations)
		.where(
			and(
				eq(conversations.id, scope.conversationId),
				eq(conversations.userId, scope.userId),
			),
		)
		.get();
	if (!row || !chat || chat.memoryIncognito)
		throw new TurnLedgerScopeError("Turn scope denied");
	return row;
}
// Exhaustive runtime guards: adding a shared outcome/cause requires updating
// this content-free whitelist, rather than accepting free-form provider text.
const outcomes = new Set(
	Object.keys({
		answered: true,
		delivered: true,
		paused: true,
		stopped: true,
		incomplete: true,
		failed: true,
	} satisfies Record<TurnOutcome, true>),
);
const causes = new Set(
	Object.keys({
		natural_stop: true,
		tool_budget: true,
		stagnation: true,
		length: true,
		content_filter: true,
		stream_end: true,
		transport_error: true,
		deadline: true,
		user_stop: true,
		ask_pause: true,
		context_capacity: true,
		incompatible_continuation: true,
		uncertain_execution: true,
	} satisfies Record<TurnStopCause, true>),
);
function count(value: number | null | undefined) {
	if (value != null && (!Number.isSafeInteger(value) || value < 0))
		throw new TypeError("Invalid usage count");
}
function safeFacts(outcome: string | null, cause: string | null) {
	if (
		(outcome != null && !outcomes.has(outcome)) ||
		(cause != null && !causes.has(cause))
	)
		throw new TypeError("Invalid completion fact");
}
function reconcile(tx: Tx, row: TurnRecord) {
	if (!row.attemptIdsJson) return;
	const ids: string[] = JSON.parse(row.attemptIdsJson);
	const attempts = tx
		.select()
		.from(normalChatAttempts)
		.where(eq(normalChatAttempts.segmentId, row.segmentId))
		.all();
	const ready = ids.every((id) =>
		attempts.some(
			(a) => a.attemptId === id && a.usageFinal && a.costUsdMicros !== null,
		),
	);
	tx.update(normalChatTurns)
		.set({ accountingStatus: ready ? "ready" : "pending" })
		.where(eq(normalChatTurns.segmentId, row.segmentId))
		.run();
}

/** Allocate once for a fresh requested turn; reuse turnId with a new segmentId for an explicit resume. */
export function allocateTurnIdentity(
	turnId: string = randomUUID(),
): Pick<TurnScope, "turnId" | "segmentId"> {
	return { turnId, segmentId: randomUUID() };
}
/** Only `admitted` authorizes the caller to start generation. Existing never does. */
export function admitTurn(
	input: TurnScope & { ownerId: string },
):
	| { status: "admitted" | "existing"; turn: TurnRecord }
	| { status: "untracked" } {
	return durable(() =>
		db.transaction((tx) => {
			const chat = tx
				.select()
				.from(conversations)
				.where(
					and(
						eq(conversations.id, input.conversationId),
						eq(conversations.userId, input.userId),
					),
				)
				.get();
			if (!chat) throw new TurnLedgerScopeError("Turn scope denied");
			if (chat.memoryIncognito) return { status: "untracked" as const };
			const existing = tx
				.select()
				.from(normalChatTurns)
				.where(eq(normalChatTurns.segmentId, input.segmentId))
				.get();
			if (existing)
				return { status: "existing" as const, turn: requireTurn(tx, input) };
			tx.insert(normalChatTurns)
				.values({
					segmentId: input.segmentId,
					turnId: input.turnId,
					conversationId: input.conversationId,
					ownerId: input.ownerId,
				})
				.run();
			return { status: "admitted" as const, turn: requireTurn(tx, input) };
		}),
	);
}
export function observeTurn(scope: TurnScope): TurnRecord | null {
	return durable(
		() =>
			db
				.select()
				.from(normalChatTurns)
				.innerJoin(
					conversations,
					eq(conversations.id, normalChatTurns.conversationId),
				)
				.where(
					and(
						scoped(scope),
						eq(conversations.userId, scope.userId),
						eq(conversations.memoryIncognito, false),
					),
				)
				.get()?.normal_chat_turns ?? null,
	);
}
/** Terminal manifests are immutable, but listed late usage may still reconcile. */
export function settleTurn(
	scope: TurnScope,
	terminal: TurnTerminal,
): TurnRecord {
	if (
		(terminal.phase !== "working" && terminal.phase !== "closing") ||
		typeof terminal.closingAttempted !== "boolean"
	)
		throw new TypeError("Invalid terminal phase");
	safeFacts(terminal.outcome, terminal.stopCause);
	safeFacts(null, terminal.workingStopCause);
	count(terminal.recoveryCount);
	const attemptIdsJson = JSON.stringify(
		[...new Set(terminal.attemptIds)].sort(),
	);
	if (terminal.attemptIds.length !== JSON.parse(attemptIdsJson).length)
		throw new TypeError("Duplicate attempt IDs");
	const { settled, written } = durable(() =>
		db.transaction((tx) => {
			let row = requireTurn(tx, scope);
			if (terminal.messageId) {
				linkNormalChatMessageAccounting(tx, {
					...scope,
					messageId: terminal.messageId,
				});
				row = requireTurn(tx, scope);
			}
			const fields = {
				outcome: terminal.outcome,
				phase: terminal.phase,
				closingAttempted: terminal.closingAttempted,
				stopCause: terminal.stopCause,
				workingStopCause: terminal.workingStopCause,
				recoveryCount: terminal.recoveryCount,
				attemptIdsJson,
			};
			if (row.outcome) {
				if (
					Object.entries(fields).some(
						([key, value]) => row[key as keyof TurnRecord] !== value,
					)
				)
					throw new TurnLedgerConflictError("Terminal conflict");
				return { settled: row, written: null };
			}
			const attempts = tx
				.select()
				.from(normalChatAttempts)
				.where(eq(normalChatAttempts.segmentId, scope.segmentId))
				.all();
			if (attempts.some((a) => !terminal.attemptIds.includes(a.attemptId)))
				throw new TurnLedgerConflictError("Terminal manifest conflict");
			tx.update(normalChatTurns)
				.set({ ...fields, settledAt: new Date() })
				.where(scoped(scope))
				.run();
			reconcile(tx, requireTurn(tx, scope));
			return { settled: requireTurn(tx, scope), written: attempts };
		}),
	);
	// Only the call that wrote the outcome reports it, and only once it is
	// committed: a replay (idempotent) or a refused conflict logs nothing.
	if (written) {
		logTurnSettled({
			segmentId: settled.segmentId,
			outcome: settled.outcome,
			stopCause: settled.stopCause,
			workingStopCause: settled.workingStopCause,
			phase: settled.phase,
			closingAttempted: settled.closingAttempted,
			recoveryCount: settled.recoveryCount,
			accountingStatus: settled.accountingStatus,
			attempts: written,
		});
		// The anonymous run record settles with the ledger, whoever wrote the
		// outcome: the lifetime's finish, or an abandoned turn found afterwards.
		settleRunLog(
			{ segmentId: settled.segmentId },
			{
				outcome: settled.outcome,
				stopCause: settled.stopCause,
				workingStopCause: settled.workingStopCause,
				phase: settled.phase,
				closingAttempted: settled.closingAttempted,
				recoveryCount: settled.recoveryCount,
				saved: settled.messageId !== null,
				attempts: written.map(runLogAttemptFromLedger),
			},
		);
	}
	return settled;
}
/** Caller supplies authoritative currently live process/run owners. This operation never generates. */
export function observeAbandonedTurn(
	scope: TurnScope,
	liveOwnerIds: readonly string[],
): TurnRecord | null {
	return durable(() =>
		db.transaction((tx) => {
			const row = tx.select().from(normalChatTurns).where(scoped(scope)).get();
			if (!row) return null;
			requireTurn(tx, scope);
			if (row.outcome || liveOwnerIds.includes(row.ownerId)) return row;
			const attempts = tx
				.select()
				.from(normalChatAttempts)
				.where(eq(normalChatAttempts.segmentId, scope.segmentId))
				.all();
			return settleTurn(scope, {
				outcome: "incomplete",
				phase: attempts.some((a) => a.phase === "closing")
					? "closing"
					: "working",
				closingAttempted: attempts.some((a) => a.phase === "closing"),
				stopCause: "uncertain_execution",
				workingStopCause: "uncertain_execution",
				recoveryCount: row.recoveryCount,
				attemptIds: attempts.map((a) => a.attemptId),
			});
		}),
	);
}

/** Upsert a single authoritative snapshot, not an increment. Final billed facts are immutable. */
export async function recordTurnAttempt(
	scope: TurnScope,
	input: TurnAttempt,
): Promise<void> {
	safeFacts(input.outcome, input.safeStopCause);
	if (input.phase !== "working" && input.phase !== "closing")
		throw new TypeError("Invalid attempt phase");
	for (const key of [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"cachedInputTokens",
		"cacheHitTokens",
		"cacheMissTokens",
		"reasoningTokens",
		"generationTimeMs",
	] as const)
		count(input[key]);
	const row = durable(() => db.transaction((tx) => requireTurn(tx, scope)));
	const old = durable(() =>
		db
			.select()
			.from(normalChatAttempts)
			.where(eq(normalChatAttempts.attemptId, input.attemptId))
			.get(),
	);
	// Price windows use durable call start, not delayed reconciliation time.
	const startedAt = old?.startedAt ?? new Date();
	let price: Awaited<ReturnType<typeof priceNormalChatAttempt>>;
	try {
		price = await priceNormalChatAttempt(input, startedAt);
	} catch (error) {
		throw new TurnLedgerStorageError(error);
	}
	durable(() =>
		db.transaction((tx) => {
			const turn = requireTurn(tx, scope);
			if (
				turn.attemptIdsJson &&
				!(JSON.parse(turn.attemptIdsJson) as string[]).includes(input.attemptId)
			)
				throw new TurnLedgerConflictError("Sealed attempt manifest conflict");
			const existing = tx
				.select()
				.from(normalChatAttempts)
				.where(eq(normalChatAttempts.attemptId, input.attemptId))
				.get();
			const facts = {
				segmentId: row.segmentId,
				phase: input.phase,
				providerId: input.providerId,
				modelId: input.modelId,
				providerModelName: input.providerModelName,
				safeStopCause: input.safeStopCause,
				outcome: input.outcome,
				inputTokens: input.inputTokens,
				outputTokens: input.outputTokens,
				totalTokens: input.totalTokens,
				cachedInputTokens: input.cachedInputTokens ?? null,
				cacheHitTokens: input.cacheHitTokens ?? null,
				cacheMissTokens: input.cacheMissTokens ?? null,
				reasoningTokens: input.reasoningTokens ?? null,
				usageFinal: input.usageFinal,
				generationTimeMs: input.generationTimeMs ?? null,
			};
			if (existing) {
				for (const key of [
					"segmentId",
					"phase",
					"providerId",
					"modelId",
				] as const) {
					if (existing[key] !== facts[key])
						throw new TurnLedgerConflictError("Attempt identity conflict");
				}
				for (const key of ["safeStopCause", "outcome"] as const) {
					if (existing[key] !== null && existing[key] !== facts[key])
						throw new TurnLedgerConflictError("Final attempt outcome conflict");
				}
				if (existing.usageFinal) {
					if (
						!facts.usageFinal ||
						Object.entries(facts).some(
							([key, value]) =>
								// Terminal facts can arrive after final usage/pricing.
								!(
									(key === "safeStopCause" || key === "outcome") &&
									existing[key] === null
								) &&
								// The configured alias may resolve before billing. The call identity
								// (provider/model/phase/segment/attempt) remains immutable.
								!(
									key === "providerModelName" && existing.costUsdMicros === null
								) &&
								(existing.costUsdMicros !== null ||
									existing[key as keyof typeof existing] !== null) &&
								existing[key as keyof typeof existing] !== value,
						)
					)
						throw new TurnLedgerConflictError("Final attempt usage conflict");
				}
			}
			const costUsdMicros =
				existing?.costUsdMicros ??
				(input.usageFinal ? price.costUsdMicros : null);
			const priceRuleId =
				existing && existing.costUsdMicros !== null
					? existing.priceRuleId
					: price.priceRuleId;
			tx.insert(normalChatAttempts)
				.values({
					attemptId: input.attemptId,
					...facts,
					startedAt,
					costUsdMicros,
					priceRuleId,
				})
				.onConflictDoUpdate({
					target: normalChatAttempts.attemptId,
					set: { ...facts, costUsdMicros, priceRuleId },
				})
				.run();
			const saved = tx
				.select()
				.from(normalChatAttempts)
				.where(eq(normalChatAttempts.attemptId, input.attemptId))
				.get();
			if (!saved) throw new Error("Attempt write was not durable");
			recordNormalChatAttemptAccounting(tx, scope, saved);

			reconcile(tx, turn);
		}),
	);
}
