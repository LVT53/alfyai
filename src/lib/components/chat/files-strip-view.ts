// Which tiles a files call draws: its pictures, and the count tile that stands in
// for the rest. Pure, like reply-segments.ts and ask-card-view.ts: no Svelte, no
// DOM, tested without a browser. FilesStrip draws exactly what this returns.
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import { formatByteSize } from "$lib/utils/format";
import { formatRelativeTime } from "$lib/utils/time";
import type { Translate } from "$lib/utils/tool-evidence-presentation";

/** Four 78px tiles fit a wide chat. */
export const STRIP_SLOTS_WIDE = 4;

/** Three fit at 480px and below. */
export const STRIP_SLOTS_NARROW = 3;

/**
 * One tile of the strip: a picture, or the count tile that says how many pictures
 * the strip leaves out. `pictureIndex` is the picture's place in the call's picture
 * list, so a viewer opened from the tile starts at the picture drawn there.
 */
export type FilesStripTile =
	| { kind: "picture"; card: ToolCallFileCard; pictureIndex: number }
	| {
			kind: "count";
			hidden: number;
			cover: string | null;
			pictureIndex: number;
	  };

/**
 * The cards the strip draws as pictures, in card order. A picture is a card the
 * server could preview (`previewUrl`): a document, and an SVG the server
 * deliberately refuses to preview, has none and appears only in the list.
 */
export function stripPictureCards(
	cards: ToolCallFileCard[],
): ToolCallFileCard[] {
	return cards.filter((card) => card.previewUrl != null);
}

/**
 * The tiles for a call's cards: every picture when they fit `slots`, else the
 * first `slots - 1` pictures and one count tile for the rest. `slots` must be at
 * least 1. The count tile's `cover` is the first picture it hides, and
 * `pictureIndex` is that picture's place in the call's picture list.
 */
export function filesStripTiles(
	cards: ToolCallFileCard[],
	slots: number,
): FilesStripTile[] {
	const pictures = stripPictureCards(cards);
	if (pictures.length <= slots) {
		return pictures.map((card, pictureIndex) => ({
			kind: "picture",
			card,
			pictureIndex,
		}));
	}

	const drawn = slots - 1;
	const tiles: FilesStripTile[] = pictures
		.slice(0, drawn)
		.map((card, pictureIndex) => ({ kind: "picture", card, pictureIndex }));
	tiles.push({
		kind: "count",
		hidden: pictures.length - drawn,
		cover: pictures[drawn]?.previewUrl ?? null,
		pictureIndex: drawn,
	});
	return tiles;
}

/**
 * A card's size and, when the provider reported one, how long ago it changed —
 * the app's own formatters, said the way every other surface says them. The date
 * carries its year when it is not the current one, so a 2015 report and a 2025
 * one cannot read alike, and a file with no mtime shows its size alone, never a
 * dangling dot.
 *
 * This is the ONE copy of those facts: the strip's card, the strip's list rows
 * and (before the strip replaced it) the old file-card row all read it.
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
