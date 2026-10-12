// The model's side of the fix round's chat turns (FX-1), as OpenAI-compatible
// stream frames. Pure: the provider harness hands over a request body and sends
// back what this returns, or carries on with its own scenarios when it returns
// null. The scenarios themselves (markers, titles, texts) are in
// tests/fixtures/ai/chat-turn-scenarios.ts.
import {
	AI_SMOKE_ITEM_TURN_BODY,
	AI_SMOKE_ITEM_TURN_EDITED_TEXT,
	AI_SMOKE_ITEM_TURN_FINAL_TEXT,
	AI_SMOKE_ITEM_TURN_TITLE,
	AI_SMOKE_PRODUCE_PDF_CONTENT,
	AI_SMOKE_PRODUCE_PDF_FILENAME,
	AI_SMOKE_PRODUCE_PDF_FINAL_TEXT,
	AI_SMOKE_PRODUCE_PDF_INTRO,
	AI_SMOKE_PRODUCE_PDF_MARKER,
	AI_SMOKE_PRODUCE_PDF_TITLE,
	decodeItemTurnMode,
	type ItemTurnMode,
} from "../../fixtures/ai/chat-turn-scenarios";
import { AI_SMOKE_MODEL_ID } from "../../fixtures/ai/openai-compatible-scenarios";

type JsonObject = Record<string, unknown>;

const PRODUCE_PDF_CALL_ID = "call_fx1_produce_pdf";
const CREATE_CALL_ID = "call_fx1_create";
const READ_CALL_ID = "call_fx1_read";
const BAD_EDIT_CALL_ID = "call_fx1_bad_edit";
const GOOD_EDIT_CALL_ID = "call_fx1_good_edit";

function isObject(value: unknown): value is JsonObject {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function messagesOf(body: unknown): JsonObject[] {
	if (!isObject(body) || !Array.isArray(body.messages)) return [];
	return body.messages.filter(isObject);
}

/** The text of the last user message: what the reader typed, with the prompt's context around it. */
function lastUserText(body: unknown): string {
	const last = messagesOf(body)
		.filter((message) => message.role === "user")
		.at(-1);
	if (!last) return "";
	const { content } = last;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) =>
			isObject(part) && typeof part.text === "string" ? part.text : "",
		)
		.join("\n");
}

/** The id of the call the last message answers, when the last message is a tool result. */
function answeredCallId(body: unknown): string | null {
	const last = messagesOf(body).at(-1);
	return last?.role === "tool" && typeof last.tool_call_id === "string"
		? last.tool_call_id
		: null;
}

/** The tool result that answers `callId`, parsed when it is JSON, else as the text it is. */
function toolResult(body: unknown, callId: string): unknown {
	const message = messagesOf(body).find(
		(candidate) =>
			candidate.role === "tool" && candidate.tool_call_id === callId,
	);
	if (!message) return null;
	const { content } = message;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content
						.map((part) =>
							isObject(part) && typeof part.text === "string" ? part.text : "",
						)
						.join("")
				: "";
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

/** Every object under `value` that has the given key, depth first: a tool result may wrap its payload. */
function collectWith(value: unknown, key: string, found: JsonObject[] = []) {
	if (Array.isArray(value)) {
		for (const item of value) collectWith(item, key, found);
	} else if (isObject(value)) {
		if (key in value) found.push(value);
		for (const item of Object.values(value)) collectWith(item, key, found);
	}
	return found;
}

function chunkBase(id: string) {
	return {
		id: `chatcmpl_fx1_${id}`,
		object: "chat.completion.chunk",
		created: 1_700_000_100,
		model: AI_SMOKE_MODEL_ID,
	};
}

/** A reply that says `text`, if any, then makes one tool call and waits for its result. */
function toolCallFrames(
	id: string,
	text: string,
	call: { callId: string; name: string; args: unknown },
): unknown[] {
	const base = chunkBase(id);
	return [
		...(text
			? [
					{
						...base,
						choices: [
							{ index: 0, delta: { content: text }, finish_reason: null },
						],
					},
				]
			: []),
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index: 0,
								id: call.callId,
								type: "function",
								function: {
									name: call.name,
									arguments: JSON.stringify(call.args),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		},
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
		},
	];
}

function textFrames(id: string, text: string): unknown[] {
	const base = chunkBase(id);
	return [
		{
			...base,
			choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
		},
		{
			...base,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 21, completion_tokens: 9, total_tokens: 30 },
		},
	];
}

/**
 * How long the model takes to write its closing sentence once the file's tool
 * returned. A real model takes seconds; a scripted one answers at once, which
 * hides the order the page meets things in: the file is made, the page reads the
 * chat again, and only later does the server link the file to the reply.
 */
const CLOSING_SENTENCE_DELAY_MS = 1500;

/** What the provider sends back, after waiting `delayMs` (the model thinking). */
export type ScriptedChatTurnReply = { frames: unknown[]; delayMs?: number };

function producePdfReply(body: unknown): ScriptedChatTurnReply {
	if (answeredCallId(body) === PRODUCE_PDF_CALL_ID) {
		return {
			frames: textFrames("produce_pdf_final", AI_SMOKE_PRODUCE_PDF_FINAL_TEXT),
			delayMs: CLOSING_SENTENCE_DELAY_MS,
		};
	}
	return {
		frames: toolCallFrames("produce_pdf", AI_SMOKE_PRODUCE_PDF_INTRO, {
			callId: PRODUCE_PDF_CALL_ID,
			name: "produce_file",
			args: {
				requestTitle: AI_SMOKE_PRODUCE_PDF_TITLE,
				filename: AI_SMOKE_PRODUCE_PDF_FILENAME,
				outputType: "pdf",
				content: AI_SMOKE_PRODUCE_PDF_CONTENT,
			},
		}),
	};
}

/** The id of the Document the turn's create call made, read out of that call's tool result. */
function madeArtifactId(body: unknown): string | null {
	const [made] = collectWith(toolResult(body, CREATE_CALL_ID), "artifactId");
	return typeof made?.artifactId === "string" ? made.artifactId : null;
}

/** The block the turn will change, read out of the read call's tool result. */
function blockToChange(
	body: unknown,
): { blockId: string; baseHash: string } | null {
	const blocks = collectWith(toolResult(body, READ_CALL_ID), "blockId");
	const block =
		blocks.find(
			(candidate) =>
				typeof candidate.text === "string" &&
				candidate.text.startsWith("Szombat"),
		) ?? blocks[0];
	return typeof block?.blockId === "string" && typeof block?.hash === "string"
		? { blockId: block.blockId, baseHash: block.hash }
		: null;
}

function itemTurnReply(
	body: unknown,
	mode: ItemTurnMode,
): ScriptedChatTurnReply {
	const answered = answeredCallId(body);
	if (answered === null) {
		return {
			frames: toolCallFrames("item_create", "Rendben, elkészítem. ", {
				callId: CREATE_CALL_ID,
				name: "create_artifact",
				args: {
					artifactType: "document",
					title: AI_SMOKE_ITEM_TURN_TITLE,
					body: AI_SMOKE_ITEM_TURN_BODY,
				},
			}),
		};
	}
	const artifactId = madeArtifactId(body) ?? "unknown";
	const block = blockToChange(body);
	const badEdit = (): ScriptedChatTurnReply => ({
		frames: toolCallFrames("item_bad_edit", "", {
			callId: BAD_EDIT_CALL_ID,
			name: "edit_artifact",
			args: {
				artifactId,
				summary: "Javította a szombati bekezdést",
				// Not one of the five ops: the tool refuses it, as it refused the audit's.
				patches: [{ op: "replace", text: AI_SMOKE_ITEM_TURN_EDITED_TEXT }],
			},
		}),
	});
	const goodEdit = (): ScriptedChatTurnReply => ({
		frames: toolCallFrames("item_good_edit", "", {
			callId: GOOD_EDIT_CALL_ID,
			name: "edit_artifact",
			args: {
				artifactId,
				summary: "Javította a szombati bekezdést",
				patches: [
					{
						op: "replaceBlock",
						blockId: block?.blockId ?? "unknown",
						baseHash: block?.baseHash ?? "unknown",
						text: AI_SMOKE_ITEM_TURN_EDITED_TEXT,
					},
				],
			},
		}),
	});
	if (answered === CREATE_CALL_ID) {
		return {
			frames: toolCallFrames("item_read", "", {
				callId: READ_CALL_ID,
				name: "read_artifact",
				args: { artifactId, detail: "blocks" },
			}),
		};
	}
	if (answered === READ_CALL_ID) {
		return mode === "edit" ? goodEdit() : badEdit();
	}
	if (answered === BAD_EDIT_CALL_ID && mode === "retry") return goodEdit();
	return { frames: textFrames("item_final", AI_SMOKE_ITEM_TURN_FINAL_TEXT) };
}

/**
 * The reply this request is scripted to get, or null when it belongs to no scenario
 * here. Only the chat's own model call is scripted (it carries the tool catalogue);
 * the title, the status line and the other internal calls that quote the message
 * are left to the provider's ordinary replies.
 */
export function scriptedChatTurnReply(
	body: unknown,
): ScriptedChatTurnReply | null {
	if (
		!isObject(body) ||
		!Array.isArray(body.tools) ||
		body.tools.length === 0
	) {
		return null;
	}
	const asked = lastUserText(body);
	if (asked.includes(AI_SMOKE_PRODUCE_PDF_MARKER)) return producePdfReply(body);
	const mode = decodeItemTurnMode(asked);
	if (mode) return itemTurnReply(body, mode);
	return null;
}
