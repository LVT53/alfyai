export const AI_SMOKE_MODEL_ID = "alfyai-fake-chat-model";
export const AI_SMOKE_API_KEY = "fake-ai-smoke-key";

export const AI_SMOKE_PLAIN_TEXT = "Plain fake provider response.";
export const AI_SMOKE_REASONING_TEXT = "Reasoning fake provider trace.";
export const AI_SMOKE_STREAM_TEXT = "Streaming fake provider response.";
export const AI_SMOKE_STREAM_REASONING_TEXT =
	"Streaming fake provider reasoning.";
export const AI_SMOKE_SLOW_CHUNK_DELAY_MS = 25;
export const AI_SMOKE_ABORT_DELAY_MS = 25;
export const AI_SMOKE_TOOL_NAME = "fake_report_tool";
export const AI_SMOKE_TOOL_FINAL_TEXT = "Fake tool roundtrip completed.";

export const AI_SMOKE_SCENARIOS = {
	text: "text",
	plain: "plain",
	streaming: "streaming",
	reasoning: "reasoning",
	toolRoundtrip: "tool-roundtrip",
	toolRoundtripMissingToolCallId: "tool-roundtrip-missing-tool-call-id",
	slowChunks: "slow-chunks",
	emptyOutput: "empty-output",
	timeoutAbort: "timeout-abort",
	rateLimit: "rate-limit",
	serverError: "server-error",
} as const;
