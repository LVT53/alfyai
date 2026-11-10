import { createHash, randomUUID } from "node:crypto";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import type { NormalChatContinuationSnapshot } from "../normal-chat-model";
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
export async function observeCompletionTurn(
	input: Parameters<typeof completionScope>[0],
) {
	const scope = completionScope(input);
	// Resolve only the segment's parent identity; scoped access and orphan settlement remain ledger-owned.
	const [{ db }, { normalChatTurns }, { and, eq }] = await Promise.all([
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
	return observeAbandonedTurn(
		{ ...scope, turnId: row?.turnId ?? scope.turnId },
		[...owners],
	);
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
			const key = JSON.stringify([
				usage,
				next.completion?.stopCause,
				next.completion?.outcome,
			]);
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
				safeStopCause: next.completion?.stopCause ?? null,
				outcome: next.completion?.outcome ?? null,
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
