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

/** Turns a conversation title into a safe attachment filename stem. */
export function conversationExportFilename(conversationTitle: string): string {
	const trimmed = conversationTitle.trim() || "conversation";
	const slug =
		trimmed
			.replace(/[^a-zA-Z0-9-_ ]/g, "")
			.trim()
			.replace(/\s+/g, "-")
			.slice(0, 80) || "conversation";
	return `${slug}.md`;
}
