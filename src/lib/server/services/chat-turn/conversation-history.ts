// Native conversation history for the chat model.
//
// Prior turns used to be flattened into one "Session Context" text block
// inside the current user message (`USER: … / ASSISTANT: …`). That hid the
// model's own earlier answers and tool use behind prose, put meta text in the
// user turn, and re-rendered the whole history every turn so the token prefix
// never matched between turns (no prefix-cache reuse).
//
// This module rebuilds the history as real `ModelMessage`s from the stored
// rows: user text, assistant text plus its tool calls, and the tool results
// as compact digests. Emitting stored rows verbatim (oldest → newest, never
// re-rendered) keeps `system + turn1 … turnN` byte-identical between
// consecutive turns, which is what makes the prefix cache hit.

import type { ModelMessage } from "ai";
import type {
	ChatAttachment,
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";

export type HistoryMessage = {
	id?: string;
	role: "user" | "assistant";
	content: string;
	attachments?: Pick<ChatAttachment, "name">[];
	thinkingSegments?: ThinkingSegment[];
	// Rendered provenance prefix (fork copies), already computed by the caller.
	contentPrefix?: string;
};

export type HistoryTurn = { messages: HistoryMessage[] };

export type HistoryToolMessagesMode = "native" | "flatten";

export type HistoryToolDigest = {
	ok: boolean;
	summary: string;
	detail?: string;
	sources?: Array<{ title: string; url?: string }>;
};

export type BuildHistoryResult = {
	messages: ModelMessage[];
	includedTurnCount: number;
	omittedTurnCount: number;
	estimatedTokens: number;
};

const MAX_DIGEST_SOURCES = 6;
const MAX_FLATTENED_TOOL_LINE_CHARS = 400;

type ToolCallSegment = Extract<ThinkingSegment, { type: "tool_call" }>;

function toolCallSegments(message: HistoryMessage): ToolCallSegment[] {
	return (message.thinkingSegments ?? []).filter(
		(segment): segment is ToolCallSegment => segment.type === "tool_call",
	);
}

// Stored `callId` when present, else a deterministic id scoped to the
// message and the index within its tool_call subsequence, so the tool-call
// part and its tool-result part always pair up on replay.
export function historyToolCallId(
	message: HistoryMessage,
	segment: ToolCallSegment,
	index: number,
): string {
	if (segment.callId?.trim()) return segment.callId.trim();
	return `hist_${message.id ?? "msg"}_${index}`;
}

export function buildHistoryToolDigest(
	segment: Pick<
		ToolCallEntry,
		"status" | "outputSummary" | "candidates" | "resultDigest"
	>,
): HistoryToolDigest {
	if (segment.status !== "done") {
		return {
			ok: false,
			summary:
				segment.status === "failed"
					? segment.outputSummary?.trim() || "The tool call failed."
					: "The tool call was interrupted before it completed.",
		};
	}
	const sources = (segment.candidates ?? [])
		.slice(0, MAX_DIGEST_SOURCES)
		.map((candidate) => ({
			title: candidate.title,
			...(candidate.url ? { url: candidate.url } : {}),
		}))
		.filter((source) => source.title?.trim());
	const detail = segment.resultDigest?.trim();
	return {
		ok: true,
		summary: segment.outputSummary?.trim() || "Completed.",
		...(detail ? { detail } : {}),
		...(sources.length > 0 ? { sources } : {}),
	};
}

function userText(message: HistoryMessage): string {
	const attachmentLines = (message.attachments ?? [])
		.map((attachment) => attachment.name?.trim())
		.filter((name): name is string => Boolean(name))
		.map((name) => `[attachment: ${name}]`);
	return [
		message.contentPrefix?.trim(),
		message.content.trim(),
		...attachmentLines,
	]
		.filter((part): part is string => Boolean(part))
		.join("\n");
}

function flattenToolLine(segment: ToolCallSegment): string {
	const digest = buildHistoryToolDigest(segment);
	const detail = digest.detail ? ` ${digest.detail}` : "";
	return `[used ${segment.name}: ${digest.summary}${detail}]`.slice(
		0,
		MAX_FLATTENED_TOOL_LINE_CHARS,
	);
}

// Render one stored turn as model messages. Returns [] when the turn has no
// usable content (e.g. an assistant row with neither text nor tool calls).
export function renderHistoryTurn(
	turn: HistoryTurn,
	mode: HistoryToolMessagesMode,
): ModelMessage[] {
	const out: ModelMessage[] = [];
	for (const message of turn.messages) {
		if (message.role === "user") {
			const text = userText(message);
			if (text) out.push({ role: "user", content: text });
			continue;
		}
		const text = message.content.trim();
		const calls = toolCallSegments(message);
		if (!text && calls.length === 0) continue;

		if (mode === "flatten" || calls.length === 0) {
			const lines = [
				...(mode === "flatten" ? calls.map(flattenToolLine) : []),
				text,
			].filter(Boolean);
			out.push({ role: "assistant", content: lines.join("\n") });
			continue;
		}

		const ids = calls.map((segment, index) =>
			historyToolCallId(message, segment, index),
		);
		out.push({
			role: "assistant",
			content: [
				...(text ? [{ type: "text" as const, text }] : []),
				...calls.map((segment, index) => ({
					type: "tool-call" as const,
					toolCallId: ids[index],
					toolName: segment.name,
					input: segment.input ?? {},
				})),
			],
		});
		out.push({
			role: "tool",
			content: calls.map((segment, index) => ({
				type: "tool-result" as const,
				toolCallId: ids[index],
				toolName: segment.name,
				output: {
					type: "json" as const,
					value: buildHistoryToolDigest(segment),
				},
			})),
		});
	}
	return out;
}

function messageText(message: ModelMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => {
			switch (part.type) {
				case "text":
					return part.text;
				case "tool-call":
					return JSON.stringify(part.input ?? {});
				case "tool-result":
					return JSON.stringify(part.output);
				default:
					return "";
			}
		})
		.join("\n");
}

export function estimateHistoryMessagesTokens(
	messages: ModelMessage[],
	estimateTokens: (text: string) => number,
): number {
	// Small per-message overhead for role/framing tokens.
	return messages.reduce(
		(sum, message) => sum + estimateTokens(messageText(message)) + 4,
		0,
	);
}

// Walk newest → oldest, keeping whole turns while they fit the budget. The
// newest completed turn is always kept so a follow-up never loses the turn
// it refers to.
export function buildHistoryModelMessages(params: {
	turns: HistoryTurn[];
	maxTokens: number;
	toolMessages: HistoryToolMessagesMode;
	estimateTokens: (text: string) => number;
}): BuildHistoryResult {
	const rendered = params.turns.map((turn) =>
		renderHistoryTurn(turn, params.toolMessages),
	);
	const kept: ModelMessage[][] = [];
	let used = 0;
	let included = 0;
	for (let i = rendered.length - 1; i >= 0; i--) {
		const turnMessages = rendered[i];
		if (turnMessages.length === 0) continue;
		const cost = estimateHistoryMessagesTokens(
			turnMessages,
			params.estimateTokens,
		);
		if (included > 0 && used + cost > params.maxTokens) break;
		kept.unshift(turnMessages);
		used += cost;
		included += 1;
	}
	const nonEmptyTurns = rendered.filter((turn) => turn.length > 0).length;
	return {
		messages: kept.flat(),
		includedTurnCount: included,
		omittedTurnCount: Math.max(0, nonEmptyTurns - included),
		estimatedTokens: used,
	};
}

// Flat text rendering for consumers that need a single string instead of the
// native message list.
export function renderHistoryAsText(messages: ModelMessage[]): string {
	return messages
		.map((message) => {
			if (message.role === "tool") {
				return `TOOL RESULT: ${messageText(message)}`;
			}
			return `${message.role.toUpperCase()}: ${messageText(message)}`;
		})
		.join("\n\n");
}
