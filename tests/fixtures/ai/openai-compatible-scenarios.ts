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

/**
 * The fake provider has no per-request scenario header on the app path (the
 * provider row carries a base URL and a key, nothing else), so a browser test
 * that needs a scripted tool call asks for it in the message itself. The marker
 * is deliberately long and odd: no other spec's message may contain it, or that
 * spec would get this scenario's tool call instead of its own text.
 */
export const AI_SMOKE_STANDING_INSTRUCTION_MARKER =
	"Please remember this standing rule for all of our chats from now on.";
export const AI_SMOKE_SUGGEST_INSTRUCTION_TOOL_NAME = "suggest_instruction";
export const AI_SMOKE_STANDING_INSTRUCTION_TEXT =
	"Always start every summary with the heading Next Steps.";
export const AI_SMOKE_SUGGEST_INSTRUCTION_FINAL_TEXT =
	"Noted — I will start summaries with Next Steps.";

/**
 * A turn that reads a project file with the real `read_generated_file` tool
 * although the user never named it: the fake model finds the file in the
 * prompt's project file list by this name prefix, and reads it by the name it
 * found there. The marker asks for the scenario, the same way the standing
 * instruction marker does, and shares no word with the file's name or text so
 * the turn's own evidence selection has nothing to match it on.
 */
export const AI_SMOKE_READ_PROJECT_FILE_MARKER =
	"Fake model step: look up the listed catalogue entry.";
export const AI_SMOKE_PROJECT_FILE_PROBE_PREFIX = "ai-smoke-probe-";
export const AI_SMOKE_READ_PROJECT_FILE_TOOL_NAME = "read_generated_file";
export const AI_SMOKE_READ_PROJECT_FILE_FINAL_TEXT =
	"Looked it up in the project's catalogue.";

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
	mimoRejectsMaxTokens: "mimo-rejects-max-tokens",
	mimoReasoningToolRoundtrip: "mimo-reasoning-tool-roundtrip",
} as const;
