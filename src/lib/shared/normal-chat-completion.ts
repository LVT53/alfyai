type NormalChatOutputPhase = "working" | "closing";

export type NormalChatStopCause =
	| "natural_stop"
	| "tool_budget"
	| "stagnation"
	| "length"
	| "content_filter"
	| "stream_end"
	| "transport_error"
	| "deadline"
	| "user_stop"
	| "ask_pause"
	| "context_capacity"
	| "incompatible_continuation"
	| "uncertain_execution";
export type NormalChatCompletion = {
	version: 1;
	turnId: string;
	segmentId: string;
	phase: NormalChatOutputPhase;
	outcome:
		| "answered"
		| "delivered"
		| "paused"
		| "stopped"
		| "incomplete"
		| "failed";
	stopCause: NormalChatStopCause;
	workingStopCause: NormalChatStopCause;
	closingAttempted: boolean;
};
export type NormalChatExecutionState =
	| "proposed"
	| "dispatched"
	| "succeeded"
	| "failed"
	| "definitely_not_executed"
	| "uncertain";
export type NormalChatAttemptUsage = {
	/** Attempt-local terminal facts; absent in legacy captures, never inferred from a later segment. */
	outcome?: NormalChatCompletion["outcome"] | null;
	safeStopCause?: NormalChatStopCause | null;
	turnId: string;
	segmentId: string;
	attemptId: string;
	phase: NormalChatOutputPhase;
	providerId: string;
	modelId: string;
	responseModelId: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	totalTokens: number | null;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
	lastStepInputTokens?: number;
	complete: boolean;
};

/** Application persistence truth, independent of immutable model settlement. */
export type NormalChatFinalizationFailure = {
	version: 1;
	status: "failed";
	cause: "file_association_failed";
	wasStopped: boolean;
};

export function parseNormalChatFinalization(
	value: unknown,
): NormalChatFinalizationFailure | undefined {
	if (!value || typeof value !== "object") return undefined;
	const fact = value as Record<string, unknown>;
	if (
		fact.version !== 1 ||
		fact.status !== "failed" ||
		fact.cause !== "file_association_failed" ||
		typeof fact.wasStopped !== "boolean"
	)
		return undefined;
	return {
		version: 1,
		status: "failed",
		cause: "file_association_failed",
		wasStopped: fact.wasStopped,
	};
}

/** Effective outward completion only; never mutate model events or attempt facts. */
export function projectNormalChatFinalization(
	completion: NormalChatCompletion | undefined,
	marker: NormalChatFinalizationFailure | undefined,
): NormalChatCompletion | undefined {
	if (!completion || !marker) return completion;
	const stopped = marker.wasStopped || completion.outcome === "stopped";
	return {
		...completion,
		outcome: stopped ? "stopped" : "failed",
		stopCause: stopped ? "user_stop" : "uncertain_execution",
	};
}

/**
 * The time a Normal Chat turn keeps for finalization after its model deadline.
 *
 * The model work (preparation, tools, the closing allowance) ends at
 * `requestStartTime + requestTimeoutMs`, and the engine is given exactly that
 * instant: it must never get more model time than `requestTimeoutMs`. What
 * happens after the model work ends is the language call that names the
 * conversation's language (cut short after 4 s), the follow-up chips (cut short
 * after 6 s) and the save, whose reads and writes go to local SQLite. The two
 * model calls bound themselves, so a finalization that is not hung takes about
 * 10 s; the window is three times that. A reply whose model work legally ran
 * until the deadline (a clean answer a moment before it, or a closing allowance
 * cut at it) is therefore still saved, and a finalization that really hangs
 * still ends in an explicit failure when the window closes.
 *
 * Both transports' watchdogs (`chat-turn/stream-orchestrator.ts`,
 * `chat-turn/plain-turn-lifetime.ts`) cut a turn off at the model deadline plus
 * this window. Change it in one place.
 */
export const TURN_FINALIZATION_WINDOW_MS = 30_000;
