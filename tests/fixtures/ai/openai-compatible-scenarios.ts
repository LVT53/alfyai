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

/**
 * T8 live: a real `edit_artifact` call, scripted with the exact block ids
 * and hashes a REAL seeded Document has (the test's own setup calls
 * `runReadArtifactTool` directly, the same snapshot-writing side effect a
 * live `read_artifact` call would have, and reads the result's per-block
 * hashes) — the fake model cannot know those ahead of time, so the test
 * embeds them in the message itself and this marker's payload encoder makes
 * that embedding round-trip cleanly through a JSON request body (colons and
 * pipes need no escaping, unlike quotes would).
 */
export const AI_SMOKE_EDIT_ARTIFACT_MARKER =
	"Fake model step: apply the scripted patch below.";
export const AI_SMOKE_EDIT_ARTIFACT_FINAL_TEXT =
	"Applied the patch — one block changed, one left alone.";

export interface EditArtifactScenarioPayload {
	artifactId: string;
	/** Its hash is CORRECT (matches the snapshot AND the current block) — this op applies. */
	applyBlockId: string;
	applyBaseHash: string;
	/** Its hash is deliberately wrong — this op is refused as `block_changed`. */
	refuseBlockId: string;
}

export function encodeEditArtifactScenarioPayload(
	payload: EditArtifactScenarioPayload,
): string {
	return [
		`aid:${payload.artifactId}`,
		`applyId:${payload.applyBlockId}`,
		`applyHash:${payload.applyBaseHash}`,
		`refuseId:${payload.refuseBlockId}`,
	].join("|");
}

export function decodeEditArtifactScenarioPayload(
	text: string,
): EditArtifactScenarioPayload | null {
	const match = text.match(
		/aid:([\w-]+)\|applyId:([\w-]+)\|applyHash:([\w-]+)\|refuseId:([\w-]+)/,
	);
	if (!match) return null;
	return {
		artifactId: match[1],
		applyBlockId: match[2],
		applyBaseHash: match[3],
		refuseBlockId: match[4],
	};
}

/**
 * The in-chat card (Feature 2, the cross-kind task): a real `create_artifact`
 * call, unlike T8 live's `edit_artifact`, needs no real block ids/hashes
 * scripted in advance — the model supplies `artifactType`/`title`/`body`
 * itself, and the real `create_artifact` handler does the rest — so this
 * scenario carries no encoded payload, just a marker.
 */
export const AI_SMOKE_CREATE_ARTIFACT_MARKER =
	"Fake model step: create the scripted document below.";
export const AI_SMOKE_CREATE_ARTIFACT_TITLE = "Weekend plan";
export const AI_SMOKE_CREATE_ARTIFACT_MARKDOWN =
	"# Weekend plan\n\nBook the museum tickets.";
export const AI_SMOKE_CREATE_ARTIFACT_FINAL_TEXT = "Made the document.";

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
