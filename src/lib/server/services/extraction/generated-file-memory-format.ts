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
 * The wrapper's two identifying lines, and the heading of its version list.
 *
 * They are named here for the same reason the label above is: `chat-files.ts`
 * writes them and `read-generated-file.ts` has to be able to take them back
 * out before the wrapper reaches a model, and two private copies of a prefix
 * only ever match by luck.
 */
const CHAT_FILE_ID_LINE_PREFIX = "Chat file id: ";
const ORIGIN_CONVERSATION_LINE_PREFIX = "Generated in conversation: ";
const RECENT_VERSIONS_HEADING = "Recent prior versions:";
/** `- v3 from <iso>[ in conversation <id>][: excerpt]` */
const RECENT_VERSION_LINE = /^- v(\d+) from /;
/** The clause a prior version carries when it lives in a DIFFERENT chat. */
const RECENT_VERSION_LOCATION = / in conversation [^\s:]+/;

/**
 * Any UUID, anywhere in the text. Every id the wrapper can carry — a chat file's,
 * a conversation's — is one of these, and `randomUUID()` is where they all come
 * from.
 */
const UUID_ANYWHERE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

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

/**
 * The wrapper with everything a model must not be shown taken out.
 *
 * The wrapper is bookkeeping written for the memory pipeline, but the artifact
 * SUMMARY is derived from its head, and the summary is handed to the model by
 * `read_generated_file`. Two things in it stopped being harmless the day that
 * tool learned to reach into another conversation:
 *
 *  - the chat-file id and the origin conversation id, which are now ANOTHER
 *    conversation's ids — the origin clause was written to disclose nothing
 *    beyond "from an earlier conversation", and the summary was undoing that;
 *  - the prior-version list, which names versions by number and sometimes by
 *    the conversation they live in, and kept listing versions whose
 *    conversation has since been deleted — directly contradicting the
 *    `earlier versions no longer available` label built from the reachable
 *    ones.
 *
 * `reachableVersions` is that same reachable set, so the list and the label
 * cannot disagree; `null` means it could not be established, and then no
 * version line is dropped. `hideOrigin` is set when the file did not come from
 * the conversation being read.
 *
 * `ownIds` is the defence in depth the line-prefix rules above could not be:
 * every id the CURRENT conversation may legitimately show — its own id and its
 * own chat files' — so that any OTHER uuid left anywhere in the text can be
 * taken out wherever it sits. The prefix rules only ever matched an id on a
 * line of its own, and a wrapper nests: a prior version's excerpt was built
 * from that version's own wrapper and carried both of its ids flattened onto
 * one `- v1 from …` line, where no prefix reaches them. That hole is closed
 * structurally at the writer (`chat-files.ts`), and closed again here for
 * everything the writer never controlled — the assistant-response snippet, an
 * older wrapper written before the fix, a future section nobody thought about.
 * `null` disables the sweep, for a caller that cannot establish the set.
 *
 * Returns the text unchanged when nothing had to go, which is what keeps the
 * ordinary same-conversation answer byte-for-byte what it always was.
 */
export function redactGeneratedFileMemoryWrapper(
	text: string,
	options: {
		hideOrigin: boolean;
		reachableVersions: ReadonlySet<number> | null;
		ownIds?: ReadonlySet<string> | null;
	},
): string {
	const lines = text.split("\n");
	const kept: string[] = [];
	let inVersionList = false;
	for (const line of lines) {
		if (
			options.hideOrigin &&
			(line.startsWith(CHAT_FILE_ID_LINE_PREFIX) ||
				line.startsWith(ORIGIN_CONVERSATION_LINE_PREFIX))
		) {
			continue;
		}
		if (line === RECENT_VERSIONS_HEADING) {
			inVersionList = true;
			kept.push(line);
			continue;
		}
		if (inVersionList) {
			const match = RECENT_VERSION_LINE.exec(line);
			if (!match) {
				inVersionList = false;
			} else {
				const version = Number.parseInt(match[1], 10);
				if (
					options.reachableVersions &&
					!options.reachableVersions.has(version)
				)
					continue;
				// A surviving line still names the chat the version lives in, which
				// is another conversation's id by definition — the clause is only
				// written when it differs from the wrapper's own conversation.
				kept.push(line.replace(RECENT_VERSION_LOCATION, ""));
				continue;
			}
		}
		kept.push(line);
	}
	return scrubForeignUuids(
		dropEmptyVersionList(kept).join("\n"),
		options.ownIds ?? null,
	);
}

/** A bookkeeping line whose id has just been taken out of it. */
const EMPTY_ID_LINE = /^(?:Chat file id|Generated in conversation):\s*$/;

/**
 * Every uuid that is not one of this conversation's own, removed wherever it
 * sits — in a version line's excerpt, in the assistant-response snippet, in a
 * section that did not exist when this was written.
 *
 * Deletion rather than a placeholder: the id is the disclosure, and a marker
 * where one used to be still tells the model that the file it is reading came
 * from a chat it cannot see. The tidy-up afterwards runs ONLY when something
 * was actually removed, so a wrapper with nothing foreign in it comes back
 * byte-for-byte.
 */
function scrubForeignUuids(
	text: string,
	ownIds: ReadonlySet<string> | null,
): string {
	if (!ownIds) return text;
	let removed = false;
	const scrubbed = text.replace(UUID_ANYWHERE, (uuid) => {
		if (ownIds.has(uuid.toLowerCase())) return uuid;
		removed = true;
		return "";
	});
	if (!removed) return text;
	return scrubbed
		.split("\n")
		.map((line) => line.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+$/, ""))
		.filter((line) => !EMPTY_ID_LINE.test(line))
		.join("\n");
}

/**
 * A heading with nothing under it says a list exists and then withholds it,
 * which reads worse than no list. Drops it, and the blank line that separated
 * it from the section above.
 */
function dropEmptyVersionList(lines: string[]): string[] {
	const heading = lines.indexOf(RECENT_VERSIONS_HEADING);
	if (heading < 0) return lines;
	const next = lines[heading + 1];
	if (next !== undefined && RECENT_VERSION_LINE.test(next)) return lines;
	const from = heading > 0 && lines[heading - 1] === "" ? heading - 1 : heading;
	return [...lines.slice(0, from), ...lines.slice(heading + 1)];
}
