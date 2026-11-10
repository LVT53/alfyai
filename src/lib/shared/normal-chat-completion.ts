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
