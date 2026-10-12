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
 * F6 (ruling 77): a real turn on the open Document, shaped like a real model's: it
 * reads the document (`read_artifact`), takes `delayMs` to write what it will change
 * (the provider holds its answer: a real model streams the patch for seconds, and
 * the browser hears nothing about the call until the whole of it is there), then
 * applies one block (`edit_artifact`) and says so. The test puts the real block id
 * and hash in the message, as the T8 scenario does; the delay and the replacement
 * text travel with them.
 */
export const AI_SMOKE_EDIT_DOCUMENT_SLOWLY_MARKER =
	"Fake model step: read the document, think for a while, then apply the scripted patch below.";
export const AI_SMOKE_EDIT_DOCUMENT_SLOWLY_FINAL_TEXT =
	"Read the document and applied the change after a while.";

export interface EditDocumentSlowlyPayload {
	artifactId: string;
	blockId: string;
	baseHash: string;
	/** What the fake model's turn waits between the document's text and its patch. */
	delayMs: number;
	text: string;
}

export function encodeEditDocumentSlowlyPayload(
	payload: EditDocumentSlowlyPayload,
): string {
	const json = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `slowdoc:${json}`;
}

export function decodeEditDocumentSlowlyPayload(
	text: string,
): EditDocumentSlowlyPayload | null {
	const match = [...text.matchAll(/slowdoc:([A-Za-z0-9_-]+)/g)].at(-1);
	if (!match) return null;
	try {
		const decoded = JSON.parse(
			Buffer.from(match[1], "base64url").toString("utf8"),
		) as Partial<EditDocumentSlowlyPayload>;
		if (
			typeof decoded.artifactId !== "string" ||
			typeof decoded.blockId !== "string" ||
			typeof decoded.baseHash !== "string" ||
			typeof decoded.delayMs !== "number" ||
			typeof decoded.text !== "string"
		) {
			return null;
		}
		return decoded as EditDocumentSlowlyPayload;
	} catch {
		return null;
	}
}

/**
 * Slice 3 T6: a real `edit_artifact` call on a BOARD, scripted with the exact ops a
 * test wants applied. The ops are JSON with quotes and braces, so they travel in
 * the user's message as base64url (`A-Za-z0-9_-`, which a JSON request body carries
 * untouched); the fake model reads them back out of the LAST user message (a
 * conversation has earlier turns, and their markers must not answer this one) and
 * forwards them verbatim as the tool call's arguments. The real handler does the
 * rest: the ops are judged, one Alfy version is written, the panel is told.
 */
export const AI_SMOKE_CANVAS_EDIT_MARKER =
	"Fake model step: apply the scripted board change below.";
export const AI_SMOKE_CANVAS_EDIT_FINAL_TEXT = "Changed the board.";

export interface CanvasEditScenarioPayload {
	artifactId: string;
	summary: string;
	/** The model's own JSON: whatever the test wants the handler to judge, refused ops included. */
	ops: unknown[];
}

export function encodeCanvasEditScenarioPayload(
	payload: CanvasEditScenarioPayload,
): string {
	const json = Buffer.from(
		JSON.stringify({ summary: payload.summary, ops: payload.ops }),
	).toString("base64url");
	return `aid:${payload.artifactId}|board:${json}`;
}

export function decodeCanvasEditScenarioPayload(
	text: string,
): CanvasEditScenarioPayload | null {
	const matches = [...text.matchAll(/aid:([\w-]+)\|board:([A-Za-z0-9_-]+)/g)];
	const match = matches.at(-1);
	if (!match) return null;
	try {
		const decoded = JSON.parse(
			Buffer.from(match[2], "base64url").toString("utf8"),
		) as { summary?: unknown; ops?: unknown };
		if (!Array.isArray(decoded.ops)) return null;
		return {
			artifactId: match[1],
			summary: typeof decoded.summary === "string" ? decoded.summary : "",
			ops: decoded.ops,
		};
	} catch {
		return null;
	}
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

/**
 * F2 (ruling 77): "change this App" in the chat. A real `edit_artifact` call on an
 * App, scripted with the App's id (a seeded one: `aid:<id>` in the message, read from
 * the LAST user message like the board edit's) and a fixed `instruction`. The real
 * handler then runs the panel's own rebuild, whose generation call reaches this same
 * fake (the spec points the `model1` provider at it): the fake recognises that
 * request by the App contract's system prompt and the instruction in its one user
 * message, and answers with a fenced app, so the whole path (instruction, generate,
 * audit, one new Alfy version, the open panel loading it) runs for real.
 */
export const AI_SMOKE_EDIT_APP_MARKER =
	"Fake model step: change the app as scripted below.";
export const AI_SMOKE_EDIT_APP_INSTRUCTION =
	"Switch the app to the dark theme (fake rebuild).";
export const AI_SMOKE_EDIT_APP_FINAL_TEXT = "Changed the app.";
export const AI_SMOKE_REBUILT_APP_HEADING = "Dark tip calculator";
export const AI_SMOKE_REBUILT_APP_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${AI_SMOKE_REBUILT_APP_HEADING}</title>
<style>body { background: #111; color: #eee; font-family: sans-serif; padding: 16px; }</style></head>
<body><h1>${AI_SMOKE_REBUILT_APP_HEADING}</h1><p>Rebuilt by the fake model.</p></body>
</html>`;

export function encodeEditAppScenarioMessage(artifactId: string): string {
	return `${AI_SMOKE_EDIT_APP_MARKER} aid:${artifactId}`;
}

export function decodeEditAppScenarioArtifactId(text: string): string | null {
	const matches = [...text.matchAll(/aid:([\w-]+)/g)];
	return matches.at(-1)?.[1] ?? null;
}

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
