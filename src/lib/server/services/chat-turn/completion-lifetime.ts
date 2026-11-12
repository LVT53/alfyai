import { createHash, randomUUID } from "node:crypto";
import { parseJsonRecord } from "$lib/server/utils/json";
import {
	type NormalChatTurnObservation,
	readNormalChatOutputEvent,
} from "$lib/services/ai-sdk-ui-stream-contract";
import {
	type NormalChatCompletion,
	parseNormalChatFinalization,
	projectNormalChatFinalization,
} from "$lib/shared/normal-chat-completion";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";
import { isStreamActive } from "./active-streams";
import {
	completeRunLog,
	logTurnSettled,
	openRunLog,
	type RunLogAttempt,
	type RunLogOutcome,
	type RunLogTiming,
	recordRunLogAttempts,
	settleRunLog,
} from "./run-log";
import {
	admitTurn,
	observeAbandonedTurn,
	recordTurnAttempt,
	settleTurn,
	type TurnAttempt,
	type TurnScope,
} from "./turn-ledger";

const bootId = randomUUID();
const owners = new Set<string>();
const liveDeadlines = new Map<string, number>();
function completionScope(input: {
	userId: string;
	conversationId: string;
	requestId?: string;
	turnId?: string;
}): TurnScope {
	const segmentId = input.requestId
		? createHash("sha256")
				.update(
					JSON.stringify([input.userId, input.conversationId, input.requestId]),
				)
				.digest("hex")
		: randomUUID();
	return {
		userId: input.userId,
		conversationId: input.conversationId,
		turnId: input.turnId ?? segmentId,
		segmentId,
	};
}
/** Incognito retains the receipt on its saved reply, never in accounting tables. */
async function readIncognitoReceipt(scope: TurnScope) {
	const [{ db }, { conversations, messages }, { and, eq, sql }] =
		await Promise.all([
			import("../../db"),
			import("../../db/schema"),
			import("drizzle-orm"),
		]);
	const row = db
		.select({ id: messages.id, metadataJson: messages.metadataJson })
		.from(messages)
		.innerJoin(conversations, eq(conversations.id, messages.conversationId))
		.where(
			and(
				eq(conversations.id, scope.conversationId),
				eq(conversations.userId, scope.userId),
				eq(conversations.memoryIncognito, true),
				eq(messages.role, "assistant"),
				sql`json_extract(case when json_valid(${messages.metadataJson}) then ${messages.metadataJson} else '{}' end, '$.normalChatOutput.events[#-1].segmentId') = ${scope.segmentId}`,
			),
		)
		.limit(1)
		.get();
	if (!row) return null;
	const metadata = parseJsonRecord(row.metadataJson);
	const output = metadata?.normalChatOutput as
		| { version?: unknown; events?: unknown }
		| undefined;
	if (output?.version !== 1 || !Array.isArray(output.events)) return null;
	const event = readNormalChatOutputEvent(output.events.at(-1));
	if (event?.type !== "completion" || event.segmentId !== scope.segmentId)
		return null;
	return {
		row,
		modelCompletion: event.completion,
		normalChatFinalization: parseNormalChatFinalization(
			metadata?.normalChatFinalization,
		),
	};
}

async function saveIncognitoReceipt(
	scope: TurnScope,
	messageId: string,
	completion: NormalChatCompletion,
) {
	const [{ db }, { conversations, messages }, { and, eq }] = await Promise.all([
		import("../../db"),
		import("../../db/schema"),
		import("drizzle-orm"),
	]);
	db.transaction((tx) => {
		const row = tx
			.select({ id: messages.id, metadataJson: messages.metadataJson })
			.from(messages)
			.innerJoin(conversations, eq(conversations.id, messages.conversationId))
			.where(
				and(
					eq(messages.id, messageId),
					eq(conversations.id, scope.conversationId),
					eq(conversations.userId, scope.userId),
					eq(conversations.memoryIncognito, true),
					eq(messages.role, "assistant"),
				),
			)
			.get();
		if (!row) throw new Error("Incognito completion receipt scope denied");
		const metadata = parseJsonRecord(row.metadataJson) ?? {};
		const output = metadata.normalChatOutput as
			| { version?: unknown; events?: unknown }
			| undefined;
		const events =
			output?.version === 1 && Array.isArray(output.events)
				? output.events
				: [];
		const terminal = readNormalChatOutputEvent(events.at(-1));
		if (terminal?.type === "completion") {
			if (
				terminal.turnId !== scope.turnId ||
				terminal.segmentId !== scope.segmentId
			)
				throw new Error("Incognito completion receipt identity mismatch");
			return;
		}
		const receipt = {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			attemptId: `${scope.segmentId}:terminal`,
			stepId: `${scope.segmentId}:terminal`,
			phase: completion.phase,
			sequence:
				events.reduce(
					(highest: number, e: unknown) =>
						Math.max(highest, readNormalChatOutputEvent(e)?.sequence ?? 0),
					0,
				) + 1,
			type: "completion",
			completion,
		};
		tx.update(messages)
			.set({
				metadataJson: JSON.stringify({
					...metadata,
					normalChatOutput: { version: 1, events: [...events, receipt] },
				}),
			})
			.where(eq(messages.id, row.id))
			.run();
	});
}

export async function observeCompletionTurn(
	input: Parameters<typeof completionScope>[0],
): Promise<NormalChatTurnObservation> {
	const scope = completionScope(input);
	const deadlineAt = liveDeadlines.get(scope.segmentId);
	const identity = {
		version: 1 as const,
		streamId: input.requestId ?? "",
		conversationId: input.conversationId,
	};
	// A turn still running. The deadline is an instant on this server's clock; the
	// browser's may differ, so the model time left by this clock goes with it and
	// the browser waits that long from the moment it hears (`remainingMs`).
	const pending = (turnId: string, segmentId: string) =>
		({
			...identity,
			state: "pending",
			...(deadlineAt === undefined
				? {}
				: { deadlineAt, remainingMs: Math.max(0, deadlineAt - Date.now()) }),
			turnId,
			segmentId,
		}) satisfies NormalChatTurnObservation;
	// Resolve only the segment's parent identity; scoped access and orphan settlement remain ledger-owned.
	const [{ db }, { normalChatTurns, messages }, { and, eq }] =
		await Promise.all([
			import("../../db"),
			import("../../db/schema"),
			import("drizzle-orm"),
		]);
	const row = db
		.select({ turnId: normalChatTurns.turnId })
		.from(normalChatTurns)
		.where(
			and(
				eq(normalChatTurns.segmentId, scope.segmentId),
				eq(normalChatTurns.conversationId, scope.conversationId),
			),
		)
		.get();
	const record = observeAbandonedTurn(
		{ ...scope, turnId: row?.turnId ?? scope.turnId },
		[...owners],
	);
	if (!record) {
		const saved = await readIncognitoReceipt(scope);
		if (
			saved &&
			(!input.turnId || saved.modelCompletion.turnId === input.turnId)
		) {
			return {
				...identity,
				state: "terminal",
				assistantMessageId: saved.row.id,
				completion:
					projectNormalChatFinalization(
						saved.modelCompletion,
						saved.normalChatFinalization,
					) ?? saved.modelCompletion,
				...(saved.normalChatFinalization
					? {
							normalChatFinalization: saved.normalChatFinalization,
							modelCompletion: saved.modelCompletion,
						}
					: {}),
			};
		}
		// Registry scope also covers setup and incognito lifetimes without a ledger row.
		return isStreamActive({
			streamId: identity.streamId,
			userId: input.userId,
			conversationId: input.conversationId,
		})
			? pending(scope.turnId, scope.segmentId)
			: { ...identity, state: "unavailable" };
	}
	if (!record.outcome) return pending(record.turnId, record.segmentId);
	// Model settlement precedes saved-turn finalization. A live owner with no
	// linked receipt is still finalizing, even if generation already answered.
	if (
		!record.messageId &&
		(owners.has(record.ownerId) ||
			isStreamActive({
				streamId: identity.streamId,
				userId: input.userId,
				conversationId: input.conversationId,
			}))
	) {
		return pending(record.turnId, record.segmentId);
	}
	if (!record.phase || !record.stopCause || !record.workingStopCause)
		throw new Error("Incomplete durable terminal facts");
	// A terminal survives deletion of its reply; never promise an unavailable saved row.
	const message = record.messageId
		? db
				.select({ id: messages.id, metadataJson: messages.metadataJson })
				.from(messages)
				.where(
					and(
						eq(messages.id, record.messageId),
						eq(messages.conversationId, input.conversationId),
						eq(messages.role, "assistant"),
					),
				)
				.get()
		: undefined;
	const modelCompletion: NormalChatCompletion = {
		version: 1,
		turnId: record.turnId,
		segmentId: record.segmentId,
		phase: record.phase,
		outcome: record.outcome,
		stopCause: record.stopCause,
		workingStopCause: record.workingStopCause,
		closingAttempted: record.closingAttempted,
	};
	const normalChatFinalization = parseNormalChatFinalization(
		parseJsonRecord(message?.metadataJson ?? null)?.normalChatFinalization,
	);
	// Model settlement alone cannot certify that an answer, or the file a turn
	// delivered, survived persistence: `answered` and `delivered` are the two
	// successful outcomes, and either one with no saved reply left the person
	// with neither the reply nor its file card. Keep the model fact intact while
	// reporting the missing receipt as failure.
	const missingSuccessfulReceipt =
		!message &&
		(modelCompletion.outcome === "answered" ||
			modelCompletion.outcome === "delivered");
	return {
		...identity,
		state: "terminal",
		assistantMessageId: message?.id ?? null,
		completion: missingSuccessfulReceipt
			? {
					...modelCompletion,
					outcome: "failed",
					stopCause: "uncertain_execution",
				}
			: (projectNormalChatFinalization(
					modelCompletion,
					normalChatFinalization,
				) ?? modelCompletion),
		...(missingSuccessfulReceipt ? { modelCompletion } : {}),
		...(normalChatFinalization
			? { normalChatFinalization, modelCompletion }
			: {}),
	};
}
export function beginCompletionLifetime(
	input: Parameters<typeof completionScope>[0] & { deadlineAt?: number },
) {
	const scope = completionScope(input);
	const ownerId = `${bootId}:${randomUUID()}`;
	const admission = admitTurn({ ...scope, ownerId });
	if (admission.status === "existing")
		throw new Error("Existing completion turn may only be observed");
	owners.add(ownerId);
	const admissionDeadline =
		input.deadlineAt &&
		Number.isFinite(input.deadlineAt) &&
		input.deadlineAt > 0
			? input.deadlineAt
			: Number.POSITIVE_INFINITY;
	if (Number.isFinite(admissionDeadline))
		liveDeadlines.set(scope.segmentId, admissionDeadline);
	const tracked = admission.status !== "untracked";
	// The anonymous run record opens for every run, incognito ones included.
	const runLogId = openRunLog({ tracked, segmentId: scope.segmentId });
	const cancellation = new AbortController();
	const registered = new Map<string, TurnAttempt>();
	let snapshot: NormalChatContinuationSnapshot | null = null;
	let pending: Promise<void> = Promise.resolve();
	let failure: unknown;
	let sealed: NormalChatCompletion | null = null;
	let linkedMessageId: string | null = null;
	const lastUsage = new Map<string, string>();
	// When each attempt's model call began: the moment its durable registration
	// completed, because the engine dispatches as soon as `register` returns.
	const requestStartedAt = new Map<string, number>();
	// What the anonymous run record keeps of the attempts. An incognito run has no
	// ledger row, so this is what the lifetime holds in memory, and it carries no
	// attempt ids.
	const runLogAttempts = (): RunLogAttempt[] =>
		[...registered.values()].map((a) => ({
			attemptId: tracked ? a.attemptId : null,
			phase: a.phase,
			providerId: a.providerId,
			modelId: a.modelId,
			providerModelName: a.providerModelName,
			outcome: a.outcome,
			safeStopCause: a.safeStopCause,
			inputTokens: a.inputTokens,
			outputTokens: a.outputTokens,
			reasoningTokens: a.reasoningTokens ?? null,
			totalTokens: a.totalTokens,
			usageFinal: a.usageFinal,
			generationTimeMs: a.generationTimeMs ?? null,
		}));
	const recoveryCount = () =>
		snapshot
			? Math.max(
					0,
					snapshot.usage.filter((u) => u.segmentId === scope.segmentId).length -
						1,
				)
			: 0;
	const unreported = (): NormalChatCompletion =>
		sealed ??
		snapshot?.completion ?? {
			version: 1,
			turnId: scope.turnId,
			segmentId: scope.segmentId,
			phase: "working",
			outcome: "incomplete",
			stopCause: "uncertain_execution",
			workingStopCause: "uncertain_execution",
			closingAttempted: false,
		};
	// A run with no ledger row (incognito, or a ledger that failed) reports its
	// own end from memory: the record, and for incognito the status line. Once.
	let reportedFromMemory = false;
	const reportFromMemory = (
		completion: NormalChatCompletion,
		line: boolean,
	) => {
		if (reportedFromMemory) return;
		reportedFromMemory = true;
		const facts: RunLogOutcome = {
			outcome: completion.outcome,
			stopCause: completion.stopCause,
			workingStopCause: completion.workingStopCause,
			phase: completion.phase,
			closingAttempted: completion.closingAttempted,
			recoveryCount: recoveryCount(),
			saved: linkedMessageId !== null,
			attempts: runLogAttempts(),
		};
		if (runLogId) settleRunLog({ id: runLogId }, facts);
		if (line)
			logTurnSettled({ ...facts, segmentId: null, accountingStatus: null });
	};
	const enqueue = (operation: () => Promise<void>) => {
		const next = pending.then(() => {
			if (failure) throw failure;
			return operation();
		});
		pending = next.catch((error) => {
			failure = error;
			cancellation.abort(error);
		});
		return next;
	};
	const capture = (next: NormalChatContinuationSnapshot) => {
		snapshot = next;
		if (!sealed && Number.isFinite(next.deadlineAt) && next.deadlineAt > 0)
			liveDeadlines.set(
				scope.segmentId,
				Math.min(admissionDeadline, next.deadlineAt),
			);
		// Snapshot totals belong to Model Run. Prior segments already have their own admission/accounting.
		for (const usage of next.usage) {
			if (usage.turnId !== scope.turnId || usage.segmentId !== scope.segmentId)
				continue;
			const key = JSON.stringify(usage);
			if (lastUsage.get(usage.attemptId) === key) continue;
			lastUsage.set(usage.attemptId, key);
			const original = registered.get(usage.attemptId);
			if (!original) {
				if (tracked)
					failure = new Error("Unregistered completion attempt usage");
				continue;
			}
			// The attempt's own model-call time (a working attempt includes its tool
			// steps), from its registration to the first capture that shows the call
			// ended: usage complete, or the terminal outcome set (the engine sets
			// both in the same tick, right after the call returns or fails). It is
			// taken once and kept: a final attempt's facts are immutable, and the
			// capture that completes the usage is the one that is billed. Date is
			// the clock for every deadline here; a clock set back reads as zero.
			const startedAtMs = requestStartedAt.get(usage.attemptId);
			const generationTimeMs =
				original.generationTimeMs ??
				(startedAtMs !== undefined && (usage.complete || usage.outcome != null)
					? Math.max(0, Date.now() - startedAtMs)
					: null);
			const attempt: TurnAttempt = {
				...original,
				...usage,
				providerModelName: usage.responseModelId ?? original.providerModelName,
				// An attempt settles independently of a later working/closing result.
				// Legacy captures may omit these facts; keep already known values.
				safeStopCause: usage.safeStopCause ?? original.safeStopCause,
				outcome: usage.outcome ?? original.outcome,
				usageFinal: usage.complete,
				generationTimeMs,
			};
			registered.set(attempt.attemptId, attempt);
			if (tracked)
				void enqueue(() => recordTurnAttempt(scope, attempt)).catch(
					() => undefined,
				);
		}
	};
	return {
		scope,
		tracked,
		signal: cancellation.signal,
		getSnapshot: () => snapshot,
		capture,
		async register(
			attempt: Pick<
				TurnAttempt,
				"attemptId" | "phase" | "providerId" | "modelId" | "providerModelName"
			>,
		) {
			if (sealed) throw new Error("Completion lifetime already sealed");
			const entry: TurnAttempt = {
				...attempt,
				safeStopCause: null,
				outcome: null,
				inputTokens: null,
				outputTokens: null,
				totalTokens: null,
				usageFinal: false,
			};
			registered.set(entry.attemptId, entry);
			if (tracked) await enqueue(() => recordTurnAttempt(scope, entry));
			requestStartedAt.set(entry.attemptId, Date.now());
			recordRunLogAttempts(runLogId, runLogAttempts());
		},
		/**
		 * Seals the run and settles it. Called more than once by design (the model
		 * run ends it, finalize ends it again with the saved reply and the turn's
		 * timing): the outcome is written by the first call only, and the saved
		 * reply and the timing are filled into the anonymous run record once.
		 */
		async finish(messageId?: string, timing?: RunLogTiming) {
			try {
				if (messageId) linkedMessageId = messageId;
				await pending;
				if (failure) {
					reportFromMemory(unreported(), false);
					throw failure;
				}
				sealed ??= unreported();
				if (!tracked) {
					reportFromMemory(sealed, true);
					if (linkedMessageId)
						await saveIncognitoReceipt(scope, linkedMessageId, sealed);
				}
				if (tracked)
					try {
						settleTurn(scope, {
							...sealed,
							recoveryCount: recoveryCount(),
							attemptIds: [...registered.keys()],
							messageId: linkedMessageId,
						});
					} catch (error) {
						// The ledger row can be gone (the chat was deleted while the run went
						// on). The run still ended, and its record says how.
						reportFromMemory(unreported(), false);
						throw error;
					}
				if (runLogId)
					completeRunLog(
						{ id: runLogId },
						{ saved: linkedMessageId !== null, timing },
					);
			} finally {
				owners.delete(ownerId);
				liveDeadlines.delete(scope.segmentId);
			}
		},
	};
}
