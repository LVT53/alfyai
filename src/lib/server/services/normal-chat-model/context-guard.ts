import type { ToolResultOutput } from "@ai-sdk/provider-utils";
import type { ModelMessage, PrepareStepFunction, ToolSet } from "ai";
import { estimateTokenCount } from "$lib/utils/tokens";
import { estimateHistoryMessagesTokens } from "../chat-turn/conversation-history";
import { deriveToolResultDigest } from "../normal-chat-tools/tool-result-digest";

// Per-step context guard (spec: docs/plans/context-budget-guards-spec.md,
// Slice 3).
//
// A single live tool result can own the whole model context window: one `files
// list` of a large folder was 237,569 input tokens, and with max_tokens fixed
// at 24,576 the request summed to 262,145 against a 262,144-token window. The
// provider answered HTTP 400 and the turn failed again on every retry, because
// the tool-result cache replayed the same payload.
//
// This step function runs before every provider step and re-checks the whole
// prompt, so accumulation across steps is bounded by construction. The
// guarantee it enforces is:
//
//   estimate(messages) + systemPromptTokens + maxOutputTokens + margin
//     <= maxModelContext
//
// When that fails, the largest tool results are replaced by their digest
// (largest first) until it holds; if no tool result can free enough, the
// largest text part is truncated as a last resort. The step then still runs
// instead of dying on the provider's 400. Everything written into the request
// is English (ruling 79).

/** Room a step keeps for the answer plus the error in our token estimate. */
export const CONTEXT_GUARD_MARGIN_TOKENS = 4_096;

const TOOL_RESULT_TRUNCATION_SUFFIX =
	"\n\n[truncated to fit the context window]";

/** What replaces a tool result whose payload cannot be digested at all. */
const OMITTED_TOOL_RESULT_TEXT =
	"Result omitted: it was too large for this step's context window.";

/**
 * How many times the last-resort text truncation may re-measure and shrink the
 * currently largest text part. The first pass is normally enough; the bound
 * only stops a pathological estimate from looping (each pass strictly reduces
 * a text, so this cannot ping-pong).
 */
const MAX_TEXT_TRUNCATION_PASSES = 8;

type ToolResultSlot = {
	messageIndex: number;
	partIndex: number;
	tokens: number;
};

type TextSlot = {
	messageIndex: number;
	/** -1 when the message's content is a plain string rather than parts. */
	partIndex: number;
	tokens: number;
	/**
	 * What the last resort may cut, in order: 0 is the model's own text and
	 * anything that is not the person's words, 1 an older user message, 2 the
	 * person's newest user message. The newest message is cut only when nothing
	 * else can be freed, so a tool step never silently answers half of what the
	 * person just asked.
	 */
	protection: 0 | 1 | 2;
};

const NOT_THE_PERSONS_WORDS = 0;
const OLDER_USER_MESSAGE = 1;
const NEWEST_USER_MESSAGE = 2;

function cloneMessage(message: ModelMessage): ModelMessage {
	// The step functions only ever replace parts, never mutate them, so a
	// shallow copy of every message and part is enough. The model's input list
	// is the SDK's, and is never written to.
	switch (message.role) {
		case "system":
			return { ...message };
		case "user":
			return typeof message.content === "string"
				? { ...message }
				: {
						...message,
						content: message.content.map((part) => ({ ...part })),
					};
		case "assistant":
			return typeof message.content === "string"
				? { ...message }
				: {
						...message,
						content: message.content.map((part) => ({ ...part })),
					};
		case "tool":
			return {
				...message,
				content: message.content.map((part) => ({ ...part })),
			};
	}
}

function withStringContent(message: ModelMessage, text: string): ModelMessage {
	switch (message.role) {
		case "system":
			return { ...message, content: text };
		case "user":
			return { ...message, content: text };
		case "assistant":
			return { ...message, content: text };
		case "tool":
			return message;
	}
}

function toolResultSlots(messages: ModelMessage[]): ToolResultSlot[] {
	const slots: ToolResultSlot[] = [];
	for (const [messageIndex, message] of messages.entries()) {
		if (typeof message.content === "string") continue;
		if (message.role !== "assistant" && message.role !== "tool") continue;
		for (const [partIndex, part] of message.content.entries()) {
			if (part.type !== "tool-result") continue;
			slots.push({
				messageIndex,
				partIndex,
				tokens: estimateTokenCount(JSON.stringify(part.output)),
			});
		}
	}
	return slots.sort(
		(a, b) =>
			b.tokens - a.tokens ||
			a.messageIndex - b.messageIndex ||
			a.partIndex - b.partIndex,
	);
}

/**
 * The payload a digest can describe. Our tools return their model payload as a
 * JSON tool result (`{ type: "json", value: payload }`), which is what the
 * digest was written for; `content` results carry text, which the digest keeps
 * as its content. Text, error and denied results have no payload to describe,
 * so they fall back to the omission notice rather than being left empty.
 */
function toolResultPayload(output: ToolResultOutput): unknown {
	switch (output.type) {
		case "json":
			return output.value;
		case "content": {
			const text = output.value
				.map((part) => (part.type === "text" ? part.text : ""))
				.filter(Boolean)
				.join("\n");
			return text ? { content: text } : null;
		}
		default:
			return null;
	}
}

function toolResultDigestText(output: ToolResultOutput): string {
	const payload = toolResultPayload(output);
	const digest = payload === null ? null : deriveToolResultDigest(payload);
	return digest
		? `${digest}${TOOL_RESULT_TRUNCATION_SUFFIX}`
		: OMITTED_TOOL_RESULT_TEXT;
}

function currentText(message: ModelMessage, partIndex: number): string | null {
	if (typeof message.content === "string") {
		return partIndex === -1 ? message.content : null;
	}
	if (partIndex < 0) return null;
	const part = message.content[partIndex];
	return part && part.type === "text" ? part.text : null;
}

/**
 * The person's newest message in the list this step sends. History turns and
 * the step image messages a tool queued are always `user` messages too, so this
 * is the last `user` message that carries words of its own — an image-only
 * message costs no text and has nothing to cut.
 */
function newestUserMessageIndex(messages: ModelMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message || message.role !== "user") continue;
		if (typeof message.content === "string") {
			if (message.content.trim()) return index;
			continue;
		}
		if (
			message.content.some(
				(part) => part.type === "text" && part.text.trim() !== "",
			)
		) {
			return index;
		}
	}
	return -1;
}

function textProtection(
	message: ModelMessage,
	messageIndex: number,
	newestUserIndex: number,
): 0 | 1 | 2 {
	if (message.role !== "user") return NOT_THE_PERSONS_WORDS;
	return messageIndex === newestUserIndex
		? NEWEST_USER_MESSAGE
		: OLDER_USER_MESSAGE;
}

function textSlots(messages: ModelMessage[]): TextSlot[] {
	const slots: TextSlot[] = [];
	const newestUserIndex = newestUserMessageIndex(messages);
	for (const [messageIndex, message] of messages.entries()) {
		const protection = textProtection(message, messageIndex, newestUserIndex);
		if (typeof message.content === "string") {
			slots.push({
				messageIndex,
				partIndex: -1,
				tokens: estimateTokenCount(message.content),
				protection,
			});
			continue;
		}
		for (const [partIndex, part] of message.content.entries()) {
			if (part.type !== "text") continue;
			slots.push({
				messageIndex,
				partIndex,
				tokens: estimateTokenCount(part.text),
				protection,
			});
		}
	}
	// The model's own text first, then older user messages, the newest last;
	// within a tier the largest first, so a cut frees the most room.
	return slots.sort(
		(a, b) =>
			a.protection - b.protection ||
			b.tokens - a.tokens ||
			a.messageIndex - b.messageIndex ||
			a.partIndex - b.partIndex,
	);
}

function replaceToolResultAt(
	messages: ModelMessage[],
	slot: ToolResultSlot,
	text: string,
): void {
	const message = messages[slot.messageIndex];
	if (!message) return;
	if (message.role === "tool") {
		messages[slot.messageIndex] = {
			...message,
			content: message.content.map((part, index) =>
				index === slot.partIndex && part.type === "tool-result"
					? { ...part, output: { type: "text" as const, value: text } }
					: part,
			),
		};
		return;
	}
	if (message.role === "assistant" && typeof message.content !== "string") {
		messages[slot.messageIndex] = {
			...message,
			content: message.content.map((part, index) =>
				index === slot.partIndex && part.type === "tool-result"
					? { ...part, output: { type: "text" as const, value: text } }
					: part,
			),
		};
	}
}

function replaceTextAt(
	messages: ModelMessage[],
	slot: TextSlot,
	text: string,
): void {
	const message = messages[slot.messageIndex];
	if (!message) return;
	if (typeof message.content === "string") {
		messages[slot.messageIndex] = withStringContent(message, text);
		return;
	}
	if (message.role === "user") {
		messages[slot.messageIndex] = {
			...message,
			content: message.content.map((part, index) =>
				index === slot.partIndex && part.type === "text"
					? { ...part, text }
					: part,
			),
		};
		return;
	}
	if (message.role === "assistant") {
		messages[slot.messageIndex] = {
			...message,
			content: message.content.map((part, index) =>
				index === slot.partIndex && part.type === "text"
					? { ...part, text }
					: part,
			),
		};
	}
}

/**
 * Cuts one text slot toward the room the step is over by. Returns whether it
 * changed the messages; the caller re-measures, because the token estimate is
 * not linear in characters and one cut can leave a sliver over.
 */
function shrinkTextSlot(
	messages: ModelMessage[],
	slot: TextSlot,
	excessTokens: number,
): boolean {
	const message = messages[slot.messageIndex];
	if (!message) return false;
	const text = currentText(message, slot.partIndex);
	if (!text) return false;
	const tokens = estimateTokenCount(text);
	if (tokens <= 1) return false;
	const targetTokens = Math.max(0, tokens - excessTokens);
	const keepChars = Math.min(
		text.length - 1,
		Math.floor((text.length * targetTokens) / tokens),
	);
	const shortened = keepChars > 0 ? `${text.slice(0, keepChars)}…` : "…";
	if (shortened === text) return false;
	replaceTextAt(messages, slot, shortened);
	return true;
}

/**
 * The `prepareStep` that keeps one model step inside the provider's window.
 *
 * Built for one provider attempt from that attempt's own numbers: the model's
 * context window and the output tokens the request will ask for. Returns
 * `undefined` when the provider does not say both, so a model whose window is
 * unknown is left exactly as it was.
 *
 * A step that fits is left untouched (`undefined`). A step that does not is
 * shrunk deterministically: largest tool results first, to their digest plus a
 * truncation notice; then, if nothing else can be freed, text is cut starting
 * with the model's own prose and older turns, and the person's newest message
 * only when nothing else is left. The caller's message list is never mutated.
 *
 * One content-free line is logged per shrink, and only the numbers and the
 * count: no prompt text, no tool payload, no message content.
 */
export function buildContextGuardPrepareStep(input: {
	maxModelContext?: number;
	maxOutputTokens?: number;
	systemPromptTokens?: number;
}): PrepareStepFunction<ToolSet> | undefined {
	const { maxModelContext, maxOutputTokens } = input;
	if (maxModelContext === undefined || maxOutputTokens === undefined) {
		return undefined;
	}
	const margin = CONTEXT_GUARD_MARGIN_TOKENS;
	const systemPromptTokens = input.systemPromptTokens ?? 0;

	const promptTokens = (messages: ModelMessage[]) =>
		estimateHistoryMessagesTokens(messages, estimateTokenCount) +
		systemPromptTokens;
	const requiredTokens = (prompt: number) => prompt + maxOutputTokens + margin;

	return ({ messages, stepNumber }) => {
		const promptBefore = promptTokens(messages);
		const requiredBefore = requiredTokens(promptBefore);
		if (requiredBefore <= maxModelContext) return undefined;

		const next = messages.map(cloneMessage);
		let prompt = promptBefore;
		let shrunk = 0;

		// Largest tool results first: each is what most likely owns the window.
		for (const slot of toolResultSlots(next)) {
			if (requiredTokens(prompt) <= maxModelContext) break;
			const message = next[slot.messageIndex];
			if (!message || typeof message.content === "string") continue;
			const part = message.content[slot.partIndex];
			if (part?.type !== "tool-result") continue;
			const replacement = toolResultDigestText(part.output);
			const replacementTokens = estimateTokenCount(
				JSON.stringify({ type: "text", value: replacement }),
			);
			// A replacement that would not free anything (a result already
			// smaller than its notice) is left alone; the last resort below
			// still has a say.
			if (replacementTokens >= slot.tokens) continue;
			replaceToolResultAt(next, slot, replacement);
			shrunk += 1;
			prompt = promptTokens(next);
		}

		// Last resort: no tool result could free enough, so cut text down to the
		// room that is actually left, in the order `textSlots` set: the model's
		// own prose and older turns before the person's newest message. A slot
		// is re-cut until the step fits or it cannot shrink further, because the
		// token estimate is not linear in characters and a sliver left over must
		// not fall through to a newer text.
		let passes = 0;
		while (
			requiredTokens(prompt) > maxModelContext &&
			passes < MAX_TEXT_TRUNCATION_PASSES
		) {
			passes += 1;
			let changed = false;
			for (const slot of textSlots(next)) {
				for (let cut = 0; cut < MAX_TEXT_TRUNCATION_PASSES; cut += 1) {
					if (requiredTokens(prompt) <= maxModelContext) break;
					const excess = requiredTokens(prompt) - maxModelContext;
					if (!shrinkTextSlot(next, slot, excess)) break;
					shrunk += 1;
					prompt = promptTokens(next);
					changed = true;
				}
				if (requiredTokens(prompt) <= maxModelContext) break;
			}
			if (!changed) break;
		}

		if (shrunk === 0) return undefined;

		console.warn(
			`[NORMAL_CHAT_MODEL] context guard step=${stepNumber} prompt=${promptBefore} required=${requiredBefore} budget=${maxModelContext} shrunk=${shrunk} after=${prompt}`,
		);
		return { messages: next };
	};
}
