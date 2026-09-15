// What a chip SAYS about an attachment, a linked document or a quote —
// the pure half of the chips redesign, shared by the composer
// (MessageInput) and the stream (MessageBubble) so the same file cannot be
// described two different ways in two places.
//
// Boundary rule, per `activity-presentation.ts`: nothing Svelte-reactive and
// nothing that imports the `$t` store. A meta clause comes back as the
// numbers and a template key for the caller to localize.

import { getFileType } from "./attachment-file-type";
import type { ComposerChipKind } from "./composer-chip-kinds";

export type AttachmentChipSource = {
	name: string;
	mimeType?: string | null;
	tokenEstimate?: number | undefined;
	pageCount?: number | undefined;
};

/**
 * Which kind of chip a piece of attached material is. An image gets its own
 * kind so the pill can wear a crop of the real file instead of a glyph; a
 * document the user LINKED from the Library gets the shelf mark, which is
 * what separates it from a file they just uploaded.
 */
export function attachmentChipKind(
	source: AttachmentChipSource,
	options: { linked?: boolean } = {},
): ComposerChipKind {
	if (options.linked) return "library";
	return getFileType(source.mimeType ?? null, source.name) === "image"
		? "image"
		: "file";
}

/** "18k", "2M" — the same compaction the old two-line cost card used. */
export function formatTokenCount(value: number): string {
	if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}M`;
	if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
	return String(value);
}

export type AttachmentChipMeta =
	| { key: "composerChips.fileMeta"; pages: string; tokens: string }
	| { key: "composerChips.filePages"; pages: string }
	| { key: "composerChips.fileTokens"; tokens: string }
	| null;

/**
 * The muted clause after the middle dot: "24 pp · 18k tok".
 *
 * This is the redesign's acknowledged trade-off. The old chip was a two-line
 * card whose second line said "18k tokens per turn" in full; the pill has one
 * line, so the cost warning shrinks to "18k tok" and can be ellipsised away
 * on a narrow window. It is still the FIRST thing dropped when the row runs
 * short (see ComposerChip's shrink factors) — deliberately, because a label
 * the user can no longer read is worse than a number they have to widen the
 * window for. Returns null when the turn knows neither figure.
 */
export function attachmentChipMeta(
	source: AttachmentChipSource,
): AttachmentChipMeta {
	const pages =
		typeof source.pageCount === "number" && source.pageCount > 0
			? String(source.pageCount)
			: null;
	const tokens =
		typeof source.tokenEstimate === "number" && source.tokenEstimate > 0
			? formatTokenCount(source.tokenEstimate)
			: null;
	if (pages && tokens) return { key: "composerChips.fileMeta", pages, tokens };
	if (pages) return { key: "composerChips.filePages", pages };
	if (tokens) return { key: "composerChips.fileTokens", tokens };
	return null;
}

/**
 * The 18px crop an image chip wears. The artifact is already uploaded by the
 * time it has a chip, so the existing authenticated preview endpoint serves
 * the bytes; there is no second upload and no blob to revoke. A non-image, or
 * an artifact with no id yet, gets null and the chip falls back to its stroke
 * icon.
 */
export function attachmentThumbnailUrl(
	source: AttachmentChipSource & { id?: string | null },
): string | null {
	if (!source.id) return null;
	if (getFileType(source.mimeType ?? null, source.name) !== "image")
		return null;
	return `/api/knowledge/${encodeURIComponent(source.id)}/preview`;
}

/**
 * A quote chip's label: the section heading the user picked, which is the
 * clause before the first colon of the quote the outline built. The rest of
 * the quote is what gets expanded into the message on send, so the pill
 * stays the user's own words rather than 90 characters of the document's.
 */
export function quoteChipLabel(quote: string): string {
	const trimmed = quote.trim();
	const colon = trimmed.indexOf(":");
	const head = colon > 0 ? trimmed.slice(0, colon) : trimmed;
	return head.trim() || trimmed;
}

export type UserMessageQuoteSplit = {
	/** Section headings to draw as quote chips, in the order they were sent. */
	quoteLabels: string[];
	/** The message text with those quote blocks removed. */
	body: string;
};

/**
 * Splits a SENT user message back into its quote chips and the sentence the
 * user actually typed.
 *
 * The composer expands a quote chip into the message body on send (there is
 * no new persisted field for it — see message-provenance.ts for the same
 * rule on the assistant side), so the only honest way to draw the chip again
 * in the stream is to recognise the text it produced. That text is not
 * guessed at: `AttachmentOutline.buildQuote` builds exactly
 * `"<title>: <preview>…"` (or bare `"<title>"`) from an outline entry that is
 * PERSISTED on the attachment, so a leading block is treated as a quote only
 * when it matches an outline entry of this very message, exactly.
 *
 * Anything that does not match is left in the body untouched, which is the
 * safe direction to fail: a quote shown as prose is a cosmetic miss, but
 * prose eaten as a quote would lose the user's words.
 */
export function splitUserMessageQuotes(
	content: string,
	outlineTitles: string[],
): UserMessageQuoteSplit {
	if (outlineTitles.length === 0) return { quoteLabels: [], body: content };
	const titles = new Set(outlineTitles.map((title) => title.trim()));
	const quoteLabels: string[] = [];
	let rest = content;
	// Quotes are expanded ABOVE the typed text, separated by a blank line, in
	// pick order — so peel blocks off the front until one does not match.
	for (;;) {
		const split = rest.indexOf("\n\n");
		const block = (split === -1 ? rest : rest.slice(0, split)).trim();
		if (!block) break;
		const colon = block.indexOf(":");
		const head = (colon > 0 ? block.slice(0, colon) : block).trim();
		if (!titles.has(head)) break;
		quoteLabels.push(head);
		rest = split === -1 ? "" : rest.slice(split + 2);
	}
	return { quoteLabels, body: quoteLabels.length > 0 ? rest.trim() : content };
}
