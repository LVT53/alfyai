// Which tiles a files call draws: its pictures, and the count tile that stands in
// for the rest. Pure, like reply-segments.ts and ask-card-view.ts: no Svelte, no
// DOM, tested without a browser. FilesStrip draws exactly what this returns.
import type { ToolCallFileCard } from "$lib/server/services/messages-types";

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
