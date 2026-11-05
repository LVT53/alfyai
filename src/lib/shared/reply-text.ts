// The words of a reply, as Copy takes them and as "Open as document" keeps them.
//
// A reply that paused to ask ("Ask me first") is stored as segments: consecutive
// assistant rows, each an ordinary turn. What a person means by the reply is all of
// its segments' words, one after the other, so Copy (in the browser, on the last
// segment) and the Document the last segment keeps (on the server) read them with
// this one definition and cannot drift: each row's words without the model's
// thinking text, the rows with nothing left of them left out, a blank line between.
//
// A leaf on purpose, with no imports: the chat components and the artifacts service
// both import it, and anything it pulled in would travel to both.

/**
 * The words of a row: its content without the model's thinking text, trimmed.
 * The one definition, for a row alone and for every row of a reply.
 */
export function getClipboardText(content: string): string {
	return content
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/<\/?thinking>/gi, "")
		.trim();
}

/**
 * The words of a reply of one or more rows, in order: each row's words
 * (`getClipboardText`), the empty ones left out, joined by a blank line. A reply of
 * one row is that row's words alone.
 */
export function joinReplyText(contents: readonly string[]): string {
	return contents
		.map(getClipboardText)
		.filter((words) => words !== "")
		.join("\n\n");
}
