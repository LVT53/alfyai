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
	admitTurn,
	observeAbandonedTurn,
	recordTurnAttempt,
	settleTurn,
	type TurnAttempt,
	type TurnScope,
} from "./turn-ledger";

const bootId = randomUUID();
const owners = new Set<string>();
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
	const identity = {
		version: 1 as const,
		streamId: input.requestId ?? "",
		conversationId: input.conversationId,
	};
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
			? {
					...identity,
					state: "pending",
					turnId: scope.turnId,
					segmentId: scope.segmentId,
				}
			: { ...identity, state: "unavailable" };
	}
	if (!record.outcome)
		return {
			...identity,
			state: "pending",
			turnId: record.turnId,
			segmentId: record.segmentId,
		};
	// Model settlement precedes saved-turn finalization. A live owner with no
	// linked receipt is still finalizing, even if generation already answered.
	if (
		!record.messageId &&
		isStreamActive({
			streamId: identity.streamId,
			userId: input.userId,
			conversationId: input.conversationId,
		})
	) {
		return {
			...identity,
			state: "pending",
			turnId: record.turnId,
			segmentId: record.segmentId,
		};
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
	// Model settlement alone cannot certify an answer survived persistence. Keep
	// the model fact intact while reporting the missing receipt as failure.
	const missingAnsweredReceipt =
		!message && modelCompletion.outcome === "answered";
	return {
		...identity,
		state: "terminal",
		assistantMessageId: message?.id ?? null,
		completion: missingAnsweredReceipt
			? {
					...modelCompletion,
					outcome: "failed",
					stopCause: "uncertain_execution",
				}
			: (projectNormalChatFinalization(
					modelCompletion,
					normalChatFinalization,
				) ?? modelCompletion),
		...(missingAnsweredReceipt ? { modelCompletion } : {}),
		...(normalChatFinalization
			? { normalChatFinalization, modelCompletion }
			: {}),
	};
}
export function beginCompletionLifetime(
	input: Parameters<typeof completionScope>[0],
) {
	const scope = completionScope(input);
	const ownerId = `${bootId}:${randomUUID()}`;
	const admission = admitTurn({ ...scope, ownerId });
	if (admission.status === "existing")
		throw new Error("Existing completion turn may only be observed");
	owners.add(ownerId);
	const tracked = admission.status !== "untracked";
	const cancellation = new AbortController();
	const registered = new Map<string, TurnAttempt>();
	let snapshot: NormalChatContinuationSnapshot | null = null;
	let pending: Promise<void> = Promise.resolve();
	let failure: unknown;
	let sealed: NormalChatCompletion | null = null;
	let linkedMessageId: string | null = null;
	const lastUsage = new Map<string, string>();
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
		if (!tracked) return;
		// Snapshot totals belong to Model Run. Prior segments already have their own admission/accounting.
		for (const usage of next.usage) {
			if (usage.turnId !== scope.turnId || usage.segmentId !== scope.segmentId)
				continue;
			const key = JSON.stringify(usage);
			if (lastUsage.get(usage.attemptId) === key) continue;
			lastUsage.set(usage.attemptId, key);
			const original = registered.get(usage.attemptId);
			if (!original) {
				failure = new Error("Unregistered completion attempt usage");
				continue;
			}
			const attempt: TurnAttempt = {
				...original,
				...usage,
				providerModelName: usage.responseModelId ?? original.providerModelName,
				// Usage is attempt-scoped; completion is segment-scoped. The model
				// does not report attempt outcome/cause in this interface. Keep those
				// unknown instead of rewriting priced facts with a later closing result.
				safeStopCause: original.safeStopCause,
				outcome: original.outcome,
				usageFinal: usage.complete,
			};
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
		},
		async finish(messageId?: string) {
			try {
				if (messageId) linkedMessageId = messageId;
				await pending;
				if (failure) throw failure;
				sealed ??= snapshot?.completion ?? {
					version: 1,
					turnId: scope.turnId,
					segmentId: scope.segmentId,
					phase: "working",
					outcome: "incomplete",
					stopCause: "uncertain_execution",
					workingStopCause: "uncertain_execution",
					closingAttempted: false,
				};
				if (!tracked && linkedMessageId)
					await saveIncognitoReceipt(scope, linkedMessageId, sealed);
				if (tracked)
					settleTurn(scope, {
						...sealed,
						recoveryCount: snapshot
							? Math.max(
									0,
									snapshot.usage.filter((u) => u.segmentId === scope.segmentId)
										.length - 1,
								)
							: 0,
						attemptIds: [...registered.keys()],
						messageId: linkedMessageId,
					});
			} finally {
				owners.delete(ownerId);
			}
		},
	};
}
