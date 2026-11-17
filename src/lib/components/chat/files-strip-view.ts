// Which tiles a files call draws: its files, and the count tile that stands in
// for the rest. Pure, like reply-segments.ts and ask-card-view.ts: no Svelte, no
// DOM, tested without a browser. FilesStrip draws exactly what this returns.
//
// A tile is a FILE, not a picture: a card the server could preview draws its
// picture, and a document (or an SVG, which the server deliberately refuses to
// preview) draws its type. The count tile therefore counts files, so `+N` agrees
// with the list behind the chevron.
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import { formatByteSize } from "$lib/utils/format";
import { formatRelativeTime } from "$lib/utils/time";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

/** Four 78px tiles fit a wide chat. */
export const STRIP_SLOTS_WIDE = 4;

/** Three fit at 480px and below. */
export const STRIP_SLOTS_NARROW = 3;

/**
 * One tile of the strip: a file, or the count tile that says how many files the
 * strip leaves out. `pictureIndex` is the file's place in the call's picture
 * list (the viewer's order) for a file with a picture, and null for a document,
 * which opens in Nextcloud instead of the viewer.
 */
export type FilesStripTile =
	| { kind: "file"; card: ToolCallFileCard; pictureIndex: number | null }
	| { kind: "count"; hidden: number; cover: string | null };

/** Whether a card draws a picture: the server built it a preview. */
function isStripPicture(card: ToolCallFileCard): boolean {
	return card.previewUrl != null;
}

/**
 * The cards the strip and the viewer draw as pictures, in card order. A document
 * — and an SVG the server refuses to preview — has no preview and is not one.
 */
export function stripPictureCards(
	cards: ToolCallFileCard[],
): ToolCallFileCard[] {
	return cards.filter(isStripPicture);
}

/**
 * The tiles for a call's cards: every file when they fit `slots`, else the first
 * `slots - 1` files and one count tile for the rest. `slots` must be at least 1.
 * The count tile's `cover` is the next file's picture when it has one.
 */
export function filesStripTiles(
	cards: ToolCallFileCard[],
	slots: number,
): FilesStripTile[] {
	const pictureIndexes = new Map<string, number>();
	stripPictureCards(cards).forEach((card, index) => {
		pictureIndexes.set(card.path, index);
	});

	const tileOf = (card: ToolCallFileCard): FilesStripTile => ({
		kind: "file",
		card,
		pictureIndex: pictureIndexes.get(card.path) ?? null,
	});

	if (cards.length <= slots) {
		return cards.map(tileOf);
	}

	const drawn = slots - 1;
	const tiles: FilesStripTile[] = cards.slice(0, drawn).map(tileOf);
	// The count tile's face is the first picture it hides, so a mixed result still
	// shows a photograph behind the number; a set of documents alone leaves it bare.
	const cover =
		cards.slice(drawn).find((card) => card.previewUrl != null)?.previewUrl ??
		null;
	tiles.push({ kind: "count", hidden: cards.length - drawn, cover });
	return tiles;
}

/**
 * A card's size and, when the provider reported one, how long ago it changed —
 * the app's own formatters, said the way every other surface says them. The date
 * carries its year when it is not the current one, so a 2015 report and a 2025
 * one cannot read alike, and a file with no mtime shows its size alone, never a
 * dangling dot.
 *
 * This is the ONE copy of those facts: both the strip's single card and its
 * list rows read it, so the two cannot word the same file differently.
 */
export function fileCardFacts(
	card: ToolCallFileCard,
	translate: Translate,
): string {
	const when = card.mtime ? Date.parse(card.mtime) : Number.NaN;
	const dated = Number.isFinite(when)
		? formatRelativeTime(when, { t: translate, yearWhenNotCurrent: true })
		: null;
	return [formatByteSize(card.size, { trimWholeUnits: true }), dated]
		.filter((part): part is string => Boolean(part))
		.join(" · ");
}
