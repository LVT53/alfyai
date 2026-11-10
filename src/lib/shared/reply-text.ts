import type { NormalChatCompletion } from "./normal-chat-completion";
import type { NormalChatOutputEvent } from "./normal-chat-output";

// The words of a reply, as Copy takes them and as "Open as document" keeps them.
//
// A reply that paused to ask ("Ask me first") is stored as segments: consecutive
// assistant rows, each an ordinary turn. What a person means by the reply is all of
// its segments' words, one after the other, so Copy (in the browser, on the last
// segment) and the Document the last segment keeps (on the server) read them with
// this one definition and cannot drift: each row's words without the model's
// thinking text, the rows with nothing left of them left out, a blank line between.
//
// A leaf with type-only imports: the chat components and the artifacts service
// both import it, and anything it pulled in would travel to both.

/** Backward-compatible single-row outward projection. */
export function getClipboardText(content: string | ReplyTextRow): string {
	return joinReplyText([content]);
}

function legacyClipboardText(content: string): string {
	return content
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<\/?thinking>/gi, "")
		.trim();
}

export type ReplyTextRow = {
	content: string;
	normalChatOutput?: { version: 1; events: readonly NormalChatOutputEvent[] };
	normalChatOutputView?: { completion?: Pick<NormalChatCompletion, "outcome"> };
	completionWarningCodes?: readonly string[];
};

/** One outward status owner for Copy, kept replies and Markdown exports. */
export function joinReplyText(
	rows: readonly (ReplyTextRow | string)[],
	options: { legacy?: "copy" | "markdown" } = {},
): string {
	return rows
		.map((part) => {
			const row: ReplyTextRow =
				typeof part === "string" ? { content: part } : part;
			const structural = Boolean(
				row.normalChatOutput || row.normalChatOutputView,
			);
			const text = structural
				? row.content
				: options.legacy === "markdown"
					? row.content.trim()
					: legacyClipboardText(row.content);
			if (!text.trim()) return "";
			const terminal = row.normalChatOutput?.events.findLast(
				(event) => event.type === "completion",
			);
			const outcome =
				row.normalChatOutputView?.completion?.outcome ??
				(terminal?.type === "completion"
					? terminal.completion.outcome
					: undefined);
			const interrupted =
				structural &&
				!outcome &&
				row.completionWarningCodes?.some((code) =>
					[
						"stream_closed_without_finish",
						"provider_error",
						"output_truncated",
					].includes(code),
				);
			return interrupted ||
				outcome === "incomplete" ||
				outcome === "stopped" ||
				outcome === "failed"
				? `_Incomplete answer._\n\n${text}`
				: text;
		})
		.filter((text) => text !== "")
		.join("\n\n");
}
