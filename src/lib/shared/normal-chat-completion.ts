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
