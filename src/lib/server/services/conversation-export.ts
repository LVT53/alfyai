// Renders a conversation's user/assistant turns to plain Markdown for the
// composer's `/export` command (see `GET /api/conversations/[id]/export.md`).
// Tool-call activity is summarized from each assistant turn's persisted
// Interim Thought Step rail (ADR-0056) — the only durable record of what a
// turn actually did that survives a page reload.
import type { ChatMessage } from "$lib/server/services/messages-types";

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function renderToolCallSummaries(message: ChatMessage): string[] {
	const steps = message.thoughtSteps;
	if (!steps || steps.length === 0) return [];

	return steps
		.filter((step) => step.impliesExternalAction)
		.map((step) => {
			const label = step.entity ?? step.activityClass;
			return step.summary
				? `- Tool call: ${label} — ${step.summary}`
				: `- Tool call: ${label}`;
		});
}

function renderMessage(message: ChatMessage): string[] {
	const heading = message.role === "user" ? "User" : "Assistant";
	const lines = [`## ${heading} — ${formatTimestamp(message.timestamp)}`, ""];

	const toolCallSummaries = renderToolCallSummaries(message);
	if (toolCallSummaries.length > 0) {
		lines.push(...toolCallSummaries, "");
	}

	lines.push(message.content?.trim() || "_(no content)_", "");
	return lines;
}

export function renderConversationMarkdown(
	conversationTitle: string,
	messages: ChatMessage[],
): string {
	const lines = [`# ${conversationTitle.trim() || "Conversation"}`, ""];
	for (const message of messages) {
		lines.push(...renderMessage(message));
	}
	return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Turns a conversation title into a safe attachment filename. Unicode
 * letters and digits survive (`\p{L}\p{N}`) so a Hungarian, Greek or
 * Japanese title keeps its own characters instead of degrading to a stub;
 * every other run of characters — separators, punctuation, emoji, path
 * separators — collapses to a single `-`.
 */
export function conversationExportFilename(conversationTitle: string): string {
	const trimmed = conversationTitle.trim() || "conversation";
	const stem =
		[...trimmed.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "")]
			.slice(0, 80)
			.join("")
			.replace(/-+$/, "") || "conversation";
	return `${stem}.md`;
}

/**
 * An ASCII-only spelling of the same filename, for the Content-Disposition
 * `filename=` parameter that clients too old for RFC 5987 fall back to.
 * Accents are folded rather than dropped (Árvíztűrő -> Arvizturo) so the
 * fallback stays recognizable.
 */
function asciiExportFilename(filename: string): string {
	const stem =
		filename
			.slice(0, -".md".length)
			.normalize("NFD")
			.replace(/\p{M}+/gu, "")
			.replace(/[^A-Za-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "conversation";
	return `${stem}.md`;
}

/**
 * The full Content-Disposition value for a Markdown export: the RFC 5987
 * `filename*=UTF-8''…` form carries the real (possibly non-ASCII) filename,
 * preceded by a plain ASCII `filename=` fallback.
 */
export function conversationExportContentDisposition(
	conversationTitle: string,
): string {
	const filename = conversationExportFilename(conversationTitle);
	return `attachment; filename="${asciiExportFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
