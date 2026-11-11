import { AI_SMOKE_MODEL_ID } from "../../fixtures/ai/openai-compatible-scenarios";
import type {
	OpenAICompatibleStreamChunk,
	OpenAICompatibleStreamDelta,
} from "../../fixtures/ai/openai-compatible-stream-fixtures";
import {
	COMPLETION_ANSWER,
	COMPLETION_ARTIFACT_TITLE,
	COMPLETION_CALL_ID,
	COMPLETION_CHUNK_HOLD,
	COMPLETION_EVIDENCE_BODY,
	COMPLETION_EVIDENCE_TAIL,
	COMPLETION_HOLD,
	COMPLETION_MARKER,
	COMPLETION_MODES,
	COMPLETION_STEP_HOLD,
	COMPLETION_SYNTHESIS,
	COMPLETION_USEFUL_WORKING,
	COMPLETION_WORKING,
	type CompletionMode,
} from "../../fixtures/ai/turn-completion-scenarios";

type WireMessage = {
	role?: string;
	content?: unknown;
	tool_call_id?: string;
	tool_calls?: Array<{ id?: string; function?: { name?: string } }>;
};
export function completionWireMessages(body: unknown): WireMessage[] {
	if (
		!body ||
		typeof body !== "object" ||
		!("messages" in body) ||
		!Array.isArray(body.messages)
	)
		return [];
	return body.messages;
}
function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => part?.text ?? "").join("");
}
// Exact app-owned request shape, characterized by the installed-driver test.
// Never search backwards for a marker through an arbitrary newer user request.
const closingInstruction =
	"Complete the original request using the evidence and working text already present. Preserve useful completed subanswers. Do not repeat already committed answer parts. Tools are unavailable. State unresolved limitations honestly.";
/** The current request section, with only the app's exact tools-disabled closing envelope unwrapped.
 * Exported for scenario dispatch and request-ledger counts; never search recalled markers.
 * A failed HTTP attempt has no assistant response, whereas completion scenarios require one.
 */
export function currentScenarioUserText(
	body: unknown,
	requireWorkingAssistant = false,
): string | null {
	const messages = completionWireMessages(body);
	let root = messages.findLastIndex((message) => message.role === "user");
	if (root < 0) return null;
	if (text(messages[root].content) === closingInstruction) {
		if (!completionToolsOff(body) || root !== messages.length - 1) return null;
		const closing = root;
		root = messages.findLastIndex(
			(message, index) => index < closing && message.role === "user",
		);
		if (
			root < 0 ||
			(requireWorkingAssistant &&
				!messages
					.slice(root + 1, closing)
					.some((message) => message.role === "assistant"))
		)
			return null;
	}
	const source = text(messages[root].content);
	return (
		source
			.split("## Current User Message\n")
			.at(-1)
			?.split("\n\n## ")[0]
			.trim() ?? ""
	);
}
export function completionMode(body: unknown): CompletionMode | null {
	const messages = completionWireMessages(body);
	const lastUser = messages.findLast((message) => message.role === "user");
	if (
		text(lastUser?.content) !== closingInstruction &&
		completionToolsOff(body)
	)
		return null;
	const section = currentScenarioUserText(body, true);
	return (
		COMPLETION_MODES.find((mode) =>
			section?.startsWith(`${COMPLETION_MARKER}${mode}.`),
		) ?? null
	);
}
export function completionToolsOff(body: unknown): boolean {
	const tools = (body as { tools?: unknown[] } | null)?.tools;
	return !Array.isArray(tools) || tools.length === 0;
}
export type CompletionReply = {
	frames: OpenAICompatibleStreamChunk[];
	hold?: string;
	frameHolds?: Array<{ before: number; name: string }>;
	status?: number;
};
function frames(
	id: string,
	deltas: OpenAICompatibleStreamDelta[],
	finish: string,
): OpenAICompatibleStreamChunk[] {
	const base = {
		id: `chatcmpl_completion_${id}`,
		object: "chat.completion.chunk",
		created: 1_700_000_200,
		model: AI_SMOKE_MODEL_ID,
	};
	return [
		{
			...base,
			choices: [
				{
					index: 0,
					delta: { role: "assistant", content: "" },
					finish_reason: null,
				},
			],
		},
		...deltas.map((delta) => ({
			...base,
			choices: [{ index: 0, delta, finish_reason: null }],
		})),
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
		// Real include_usage shape: usage follows finish with no choices.
		{
			...base,
			choices: [],
			usage: { prompt_tokens: 31, completion_tokens: 13, total_tokens: 44 },
		},
	];
}
function answer(id: string, partial = false): CompletionReply {
	return {
		frames: frames(
			id,
			[
				{ content: "## Result" },
				{
					content: partial
						? "\n\nThe checked result is"
						: COMPLETION_ANSWER.slice("## Result".length),
				},
			],
			partial ? "length" : "stop",
		),
		hold: COMPLETION_HOLD,
	};
}
function read(step: number, vary: boolean): CompletionReply {
	return {
		frames: frames(
			`read_${step}`,
			[
				{ content: "Hello. " },
				{ content: "Let me check." },
				{
					tool_calls: [
						{
							index: 0,
							id:
								step === 0
									? COMPLETION_CALL_ID
									: `call_completion_read_${step}`,
							type: "function",
							function: {
								name: "read_generated_file",
								arguments: JSON.stringify({
									filename: vary
										? `completion-evidence-${step}.txt`
										: "completion-evidence.txt",
								}),
							},
						},
					],
				},
			],
			"tool_calls",
		),
	};
}
export function turnCompletionReply(body: unknown): CompletionReply | null {
	const mode = completionMode(body);
	if (!mode) return null;
	const messages = completionWireMessages(body);
	const results = messages.filter(
		(m) => m.role === "tool" && m.tool_call_id?.startsWith("call_completion_"),
	);
	const hasAttempt = messages.some((m) => m.role === "assistant");
	if (completionToolsOff(body)) {
		// Auxiliary prompt calls quoting the user's request must not masquerade as closing.
		if (!hasAttempt) return null;
		if (mode === "useful-partial") {
			const readResult = results.find(
				(m) => m.tool_call_id === "call_completion_read_created",
			);
			const hasEvidence = text(readResult?.content).includes(
				COMPLETION_EVIDENCE_TAIL,
			);
			const hasPartial = messages.some(
				(m) =>
					m.role === "assistant" &&
					text(m.content).includes(COMPLETION_USEFUL_WORKING),
			);
			return {
				frames: frames(
					"synthesis",
					[
						{
							content:
								hasEvidence && hasPartial
									? COMPLETION_SYNTHESIS
									: "## Result\n\nRequired evidence or useful partial was lost.",
						},
					],
					"stop",
				),
				hold: COMPLETION_HOLD,
			};
		}
		if (mode === "closing-error")
			return { frames: [], status: 500, hold: COMPLETION_HOLD };
		if (mode === "closing-empty")
			return { frames: frames("empty", [], "stop"), hold: COMPLETION_HOLD };
		return answer("closing", mode === "closing-truncated");
	}
	if (mode === "side-effect" || mode === "useful-partial") {
		if (results.length === 0)
			return {
				frames: frames(
					"create",
					[
						{
							content:
								mode === "useful-partial"
									? COMPLETION_USEFUL_WORKING
									: COMPLETION_WORKING,
						},
						{
							tool_calls: [
								{
									index: 0,
									id: "call_completion_create",
									type: "function",
									function: {
										name: "create_artifact",
										arguments: JSON.stringify({
											artifactType: "document",
											title: COMPLETION_ARTIFACT_TITLE,
											body:
												mode === "useful-partial"
													? COMPLETION_EVIDENCE_BODY
													: "# Execution evidence\n\nCreated once.",
										}),
									},
								},
							],
						},
					],
					"tool_calls",
				),
			};
		if (results.length === 1) {
			const created = results.find(
				(m) => m.tool_call_id === "call_completion_create",
			);
			const parsed = JSON.parse(text(created?.content));
			const findId = (value: unknown): string | null => {
				if (!value || typeof value !== "object") return null;
				if ("artifactId" in value && typeof value.artifactId === "string")
					return value.artifactId;
				for (const child of Object.values(value)) {
					const id = findId(child);
					if (id) return id;
				}
				return null;
			};
			const artifactId = findId(parsed);
			if (!artifactId)
				throw new Error(
					"Completion fixture did not receive the created artifact id",
				);
			return {
				frames: frames(
					"read_created",
					[
						{
							tool_calls: [
								{
									index: 0,
									id: "call_completion_read_created",
									type: "function",
									function: {
										name: "read_artifact",
										arguments: JSON.stringify({ artifactId, detail: "blocks" }),
									},
								},
							],
						},
					],
					"tool_calls",
				),
			};
		}
		// Later requested work was interrupted after delivery; closing must synthesize it.
		return {
			frames: frames(
				"unfinished_after_read",
				[
					{
						content:
							"The document is ready; I am checking the remaining result.",
					},
				],
				"length",
			),
		};
	}
	if (mode === "natural") return answer("natural");
	if (mode === "live-natural")
		return {
			...answer("live-natural"),
			hold: undefined,
			frameHolds: [
				{ before: 2, name: COMPLETION_CHUNK_HOLD },
				{ before: 3, name: COMPLETION_STEP_HOLD },
			],
		};
	if (mode === "live-tool")
		return results.length === 0
			? {
					...read(0, false),
					frameHolds: [
						{ before: 2, name: COMPLETION_CHUNK_HOLD },
						{ before: 3, name: COMPLETION_STEP_HOLD },
					],
				}
			: answer("live-tool-final");
	if (mode === "pause") {
		if (results.some((m) => m.tool_call_id === "call_completion_ask"))
			return answer("resumed");
		return {
			frames: frames(
				"ask",
				[
					{ content: COMPLETION_WORKING },
					{
						tool_calls: [
							{
								index: 0,
								id: "call_completion_ask",
								type: "function",
								function: {
									name: "ask_user",
									arguments: JSON.stringify({
										questions: [
											{
												question: "Which result should I explain?",
												options: [
													{ label: "The checked result", recommended: true },
													{ label: "The alternative" },
												],
											},
										],
									}),
								},
							},
						],
					},
				],
				"tool_calls",
			),
		};
	}
	if (mode === "reasoning-only")
		return {
			frames: frames(
				"reasoning",
				[{ reasoning_content: "Checking the available evidence." }],
				"stop",
			),
		};
	if (mode === "length")
		return {
			frames: frames("length", [{ content: COMPLETION_WORKING }], "length"),
		};
	if (results.length === 0) return read(0, mode === "budget");
	if (mode === "tool") return answer("final");
	if (mode === "budget" || mode === "stagnation")
		return read(results.length, mode === "budget");
	// Empty tool-free working exit must close, not accept commentary as an answer.
	return { frames: frames("blank", [], "stop") };
}
