// The generated-file memory wrapper, as a wire format between three modules.
//
// `chat-files.ts` writes the wrapper, `extraction/readback.ts` rewrites its
// last section when a binary's text arrives, and
// `normal-chat-tools/read-generated-file.ts` reads that section back out for
// the model. All three have to agree on the same bytes, and the tool module
// used to agree by keeping its own copies of the label and the "no text yet"
// sentence — two strings that only ever matched by luck.
//
// They live here rather than in `readback.ts` because `readback.ts` imports
// the extraction worker, and a chat tool that pulled that in would drag the
// extractor registry, a zip reader and a backend HTTP client into every chat
// turn's bundle. This module imports nothing at all.

/**
 * The label the memory wrapper's last section starts with. It appears in two
 * shapes, which is load-bearing:
 *
 *  - `"Extracted file content:\n<text>"` — real text arrived;
 *  - `"Extracted file content: <no-extraction sentence>"` — it has not.
 *
 * The second shape does not contain the newline, which is what lets a reader
 * tell "this file's text is pending" from "this file's text is empty".
 */
export const GENERATED_FILE_EXTRACTED_CONTENT_LABEL = "Extracted file content:";

/** What the section says while there is no text — today's "extraction failed" prose. */
export const GENERATED_FILE_NO_EXTRACTION_TEXT =
	"No readable text could be extracted from this file. Use the filename, file type, and surrounding chat context when continuing it.";

/** How much of the extracted text the wrapper carries. */
export const GENERATED_FILE_EXTRACT_PREVIEW_CHARS = 6000;

/** The marker a reader splits on: the label on its own line, text below it. */
export const GENERATED_FILE_EXTRACTED_CONTENT_MARKER = `\n${GENERATED_FILE_EXTRACTED_CONTENT_LABEL}\n`;

/**
 * True when this text is a memory WRAPPER rather than a file's own text.
 *
 * A document-source artifact stores the rendered Markdown directly, with no
 * wrapper at all, so the label is the only thing that distinguishes the two.
 */
export function isGeneratedFileMemoryWrapper(
	text: string | null | undefined,
): boolean {
	return Boolean(text?.includes(GENERATED_FILE_EXTRACTED_CONTENT_LABEL));
}

/**
 * The file's own text out of a wrapper, or `null` when the wrapper is still
 * carrying the "no text yet" sentence.
 *
 * `null` means "pending", never "empty": the caller must not fall back to the
 * wrapper itself, which is bookkeeping — the chat-file id, the conversation
 * id, the prior-version list and an excerpt of a different turn's answer.
 */
export function readGeneratedFileExtractedText(
	text: string | null | undefined,
): string | null {
	if (!text) return null;
	const markerIndex = text.lastIndexOf(GENERATED_FILE_EXTRACTED_CONTENT_MARKER);
	if (markerIndex < 0) return null;
	const extracted = text
		.slice(markerIndex + GENERATED_FILE_EXTRACTED_CONTENT_MARKER.length)
		.trim();
	if (!extracted || extracted === GENERATED_FILE_NO_EXTRACTION_TEXT) {
		return null;
	}
	return extracted;
}
