import { MARATHON_UNJUDGED_THRESHOLD } from "./config";

/**
 * Post-turn memory intake dispatch — the single entry point the chat-turn
 * finalizer calls after an assistant message is persisted.
 *
 * This function OWNS the three-tier trigger policy that used to live inline in
 * `chat-turn/finalize.ts`:
 *
 *   - the master-gate check (`isMemoryActiveForConversation`) that keeps
 *     memory-disabled users and incognito conversations out of intake entirely;
 *   - the explicit "remember that…" path, including the crash-safety dirty-ledger
 *     trail left BEFORE the synchronous judge and the D2 conditional-advance
 *     threading (`overrideHighestSequence`);
 *   - the marathon escalation once `MARATHON_UNJUDGED_THRESHOLD` messages sit
 *     unjudged (its safety-net dirty mark included);
 *   - the debounced idle schedule for ordinary turns below the threshold.
 *
 * The leaf functions it composes (`detectExplicitMemoryRequest`,
 * `scheduleConversationJudge`, `runMemoryJudgeOnSegment`, `countUnjudgedMessages`,
 * `getMaxJudgedMessageSequence`, `markMemoryDirty`) are internal details of the
 * memory-judge module; callers depend only on this dispatch surface.
 *
 * Behaviour is intentionally identical to the pre-refactor finalize.ts block —
 * this relocates WHERE the tier decision is made, not WHAT it decides. The D1
 * (oldest-first drain, watermark never past unseen messages) and D2 (explicit
 * conditional advance) invariants are preserved because they live in the leaf
 * functions this composes.
 */
export type JudgeFinishedTurnParams = {
	userId: string;
	conversationId: string;
	/** The normalized user message for this turn (drives explicit detection). */
	userMessage: string;
	/** Persisted id of this turn's user message, if any. */
	userMessageId: string | null;
	/** Persisted id of this turn's assistant message, if any. */
	assistantMessageId: string | null;
	/** The visible assistant response for this turn. */
	assistantResponse: string;
	/**
	 * The assistant text to judge on the explicit path. Falls back to
	 * `assistantResponse` when omitted (mirror content strips control markup).
	 */
	assistantMirrorContent?: string;
};

export type JudgeFinishedTurnResult = {
	status: "skipped" | "explicit" | "marathon" | "idle";
};

export async function judgeFinishedTurn(
	params: JudgeFinishedTurnParams,
): Promise<JudgeFinishedTurnResult> {
	// Respect the user's master memory toggle and per-conversation incognito
	// mode: neither should ever contribute to memory. This is the same gate the
	// judge chokepoint enforces defensively; owning it here means a disabled
	// conversation never even marks the dirty ledger or schedules a timer.
	const { isMemoryActiveForConversation } = await import("../memory-controls");
	const memoryActive = await isMemoryActiveForConversation({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => true);
	if (!memoryActive) return { status: "skipped" };

	const { detectExplicitMemoryRequest, scheduleConversationJudge } =
		await import("./runner");
	const { markMemoryDirty } = await import("../memory-profile/dirty-ledger");
	const { countUnjudgedMessages, getMaxJudgedMessageSequence } = await import(
		"./segment"
	);
	const { runMemoryJudgeOnSegment } = await import("./index");

	if (detectExplicitMemoryRequest(params.userMessage)) {
		// Crash-safety: leave a dirty-ledger trail BEFORE the synchronous explicit
		// judge (mirroring the marathon branch below). If the judge call throws/fails
		// or the process dies mid-run, a later sweep/idle pass retries this
		// conversation. On success the explicit judge advances the watermark, so that
		// later pass finds nothing unjudged and simply completes this row.
		await markMemoryDirty({
			userId: params.userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: params.conversationId },
		});
		// Advance the watermark to the newest message of THIS exchange so the
		// explicitly-judged messages are marked judged and never re-counted by a
		// later marathon/idle/sweep pass. The persisted turn's message ids carry the
		// real sequences the synthesised segmentOverride lacks. The judge only
		// advances when no older backlog sits below the exchange (D2).
		const overrideHighestSequence = await getMaxJudgedMessageSequence({
			conversationId: params.conversationId,
			messageIds: [params.userMessageId, params.assistantMessageId].filter(
				(id): id is string => Boolean(id),
			),
		});
		await runMemoryJudgeOnSegment({
			userId: params.userId,
			conversationId: params.conversationId,
			trigger: "explicit",
			segmentOverride: [
				{ role: "user", content: params.userMessage },
				{
					role: "assistant",
					content: params.assistantMirrorContent ?? params.assistantResponse,
				},
			],
			overrideHighestSequence,
		});
		return { status: "explicit" };
	}

	await markMemoryDirty({
		userId: params.userId,
		reason: "deferred_intake",
		scope: { type: "conversation", id: params.conversationId },
	});
	if (
		(await countUnjudgedMessages({
			userId: params.userId,
			conversationId: params.conversationId,
		})) >= MARATHON_UNJUDGED_THRESHOLD
	) {
		await runMemoryJudgeOnSegment({
			userId: params.userId,
			conversationId: params.conversationId,
			trigger: "marathon",
		});
		return { status: "marathon" };
	}
	scheduleConversationJudge({
		userId: params.userId,
		conversationId: params.conversationId,
	});
	return { status: "idle" };
}
