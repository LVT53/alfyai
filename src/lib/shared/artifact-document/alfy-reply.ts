/**
 * Fixed, non-localized markers an `@Alfy` comment reply's body carries
 * instead of Alfy's own generated text (Feature 2 · Artifacts, Slice 1, Task
 * T10). The server writes one of these when there is nothing meaningful of
 * Alfy's own to show (a refusal, or an empty note on an otherwise-successful
 * change); `CommentCard.svelte` recognizes them and renders the matching
 * localized string (`artifacts.document.comment.alfyRefused` /
 * `...alfyDone`) instead of the literal marker.
 *
 * Never confused with real content: a human can never author a comment as
 * "alfy" (the create route hardcodes `author: "user"`), and a comment's body
 * never reaches an exported file (ruling 1 — comments are never part of an
 * artifact body), so these values are only ever read back through
 * `CommentCard.svelte`.
 */
export const ALFY_REFUSED_MARKER = "[[alfy:refused]]";
export const ALFY_EMPTY_REPLY_MARKER = "[[alfy:done]]";

/**
 * RV-1B, coordinator item 8: appended to (never replacing, unlike the two
 * whole-body markers above) an `@Alfy` reply's own note when the SAME
 * request applied at least one op AND refused at least one other —
 * `runAlfyCommentReply`'s `ops` array can hold more than one op against the
 * comment's anchored block, and every op in it shares the SAME `baseHash`
 * (the block as Alfy first read it), so an EARLIER op that changes the block
 * routinely leaves a LATER one refused `block_changed` in the very same
 * request. Before this, the model's own "note" only ever describes what it
 * DID change, never what it could not, so a partially-refused `@Alfy` reply
 * read in the thread as an unqualified, silent success. `CommentCard.svelte`
 * strips this suffix back off before matching the two markers above, so a
 * partial refusal on an otherwise-empty note (`ALFY_EMPTY_REPLY_MARKER`)
 * still renders its own localized text rather than the raw marker.
 */
export const ALFY_PARTIAL_REFUSAL_SUFFIX = "\n\n[[alfy:partial-refusal]]";

/**
 * A Canvas `@Alfy` reply that applied some of its ops and could not apply
 * others NAMES the ones it skipped: appended to Alfy's own note as one more
 * marker (never replacing it), so the words stay Alfy's and what was skipped is
 * shown in the reader's language. `target` is the block's own words (or the id
 * an op addressed, when there is no such block) and `reason` a board refusal
 * reason (`artifacts.canvas.refusal.*`); `CommentCard.svelte` reads it back with
 * `splitSkippedOps` and renders the localized line.
 */
export type AlfySkippedOp = { target: string; reason: string };

const SKIPPED_OPEN = "\n\n[[alfy:skipped:";
const SKIPPED_CLOSE = "]]";

export function withSkippedOps(
	note: string,
	skipped: readonly AlfySkippedOp[],
): string {
	return skipped.length === 0
		? note
		: `${note}${SKIPPED_OPEN}${JSON.stringify(skipped)}${SKIPPED_CLOSE}`;
}

function isSkippedOp(value: unknown): value is AlfySkippedOp {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.target === "string" && typeof candidate.reason === "string"
	);
}

/** The note without its marker, and the ops the marker names. A body with no readable marker is returned whole. */
export function splitSkippedOps(body: string): {
	text: string;
	skipped: AlfySkippedOp[];
} {
	const at = body.lastIndexOf(SKIPPED_OPEN);
	if (at === -1 || !body.endsWith(SKIPPED_CLOSE)) {
		return { text: body, skipped: [] };
	}
	try {
		const parsed: unknown = JSON.parse(
			body.slice(at + SKIPPED_OPEN.length, -SKIPPED_CLOSE.length),
		);
		return {
			text: body.slice(0, at),
			skipped: Array.isArray(parsed) ? parsed.filter(isSkippedOp) : [],
		};
	} catch {
		return { text: body.slice(0, at), skipped: [] };
	}
}
