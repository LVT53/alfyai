/**
 * Read aloud on a Document's page: what the page draws that is not its text,
 * the revision a reading stops on when the shown text changes, and where the
 * page scrolls to bring a sentence into view. `DocumentBody.svelte` builds the
 * reading source the read-aloud controller takes (`DocumentReadingSource`)
 * from these. Pure and Tiptap-free, so the body may import it.
 */

/**
 * What a Document's page draws that is not its text, and is never read: a tracker
 * chip (its label is localised, never the stored value the containment check
 * finds), Alfy's change pill and writing tag (widgets inside the editor's DOM), and
 * the hidden block markers.
 */
export const PAGE_NOT_TEXT =
	".tracker-chip, .change-pill-mount, .alfy-writing-tag, [data-block-marker]";

/** A ProseMirror doc, as far as the revision reads one. */
type TextDoc = {
	readonly content: { readonly size: number };
	textBetween(
		from: number,
		to: number,
		blockSeparator?: string,
		leafText?: string,
	): string;
};

/**
 * A counter that moves only when the text the page shows moves: the doc's text,
 * blocks apart, or the tab shown. A new doc with the same text (a mark changed:
 * Alfy's change kept; a chip's value) leaves it where it was, and a doc is read
 * once however often it is asked, since a ProseMirror doc never changes in place:
 * the reading asks every frame.
 */
export function textRevision(): (doc: TextDoc | null, tab: string) => number {
	let lastDoc: TextDoc | null | undefined;
	let lastTab = "";
	let lastText = "";
	let revision = 0;
	return (doc, tab) => {
		if (doc === lastDoc && tab === lastTab) return revision;
		const text = doc ? doc.textBetween(0, doc.content.size, "\n", " ") : "";
		if (lastDoc !== undefined && (text !== lastText || tab !== lastTab))
			revision += 1;
		lastDoc = doc;
		lastTab = tab;
		lastText = text;
		return revision;
	};
}

/**
 * Where the page's scroller goes to bring `rect` into view (the read-aloud
 * player's locate, "center"; a scrubber drag's target, "reveal"): the middle of
 * what can be seen above `covered` pixels at its foot (the review bar). "reveal"
 * moves only when part of it is out of view. Null: nothing to bring, or nothing
 * to move.
 */
export function focusScrollTop(p: {
	scroller: DOMRectReadOnly;
	scrollTop: number;
	clientHeight: number;
	scrollHeight: number;
	rect: DOMRectReadOnly | null;
	covered: number;
	mode: "center" | "reveal";
}): number | null {
	if (!p.rect) return null;
	const area = Math.max(1, p.clientHeight - p.covered);
	const top = p.rect.top - p.scroller.top;
	const bottom = p.rect.bottom - p.scroller.top;
	if (p.mode === "reveal" && top >= 0 && bottom <= area) return null;
	const target = p.scrollTop + (top + bottom) / 2 - area / 2;
	const max = Math.max(0, p.scrollHeight - p.clientHeight);
	return Math.min(max, Math.max(0, target));
}
