import {
	type NormalChatCompletion,
	type NormalChatFinalizationFailure,
	parseNormalChatFinalization,
} from "./normal-chat-completion";
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
// Its only runtime dependency is the shared pure finalization marker parser:
// a marker identifies structural content without becoming answer text.

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
	normalChatOutputView?: {
		completion?: Pick<NormalChatCompletion, "outcome">;
		modelCompletion?: NormalChatCompletion;
		normalChatFinalization?: NormalChatFinalizationFailure;
	};
	normalChatFinalization?: NormalChatFinalizationFailure;
	completionWarningCodes?: readonly string[];
};

/** Answer words shared by Copy, kept replies and Markdown exports. */
export function joinReplyText(
	rows: readonly (ReplyTextRow | string)[],
	options: { legacy?: "copy" | "markdown" } = {},
): string {
	return rows
		.map((part) => {
			const row: ReplyTextRow =
				typeof part === "string" ? { content: part } : part;
			const marker = parseNormalChatFinalization(
				row.normalChatFinalization ??
					row.normalChatOutputView?.normalChatFinalization,
			);
			const structural = Boolean(
				row.normalChatOutput || row.normalChatOutputView || marker,
			);
			const text = structural
				? row.content
				: options.legacy === "markdown"
					? row.content.trim()
					: legacyClipboardText(row.content);
			// Completion belongs to localized status UI, never to copied answer words.
			return text.trim() ? text : "";
		})
		.filter((text) => text !== "")
		.join("\n\n");
}
