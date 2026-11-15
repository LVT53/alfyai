import { describe, expect, it } from "vitest";
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import {
	filesStripTiles,
	STRIP_SLOTS_NARROW,
	STRIP_SLOTS_WIDE,
	stripPictureCards,
} from "./files-strip-view";

// The card the server builds for a Nextcloud picture: a preview URL, with the
// viewer-sized copy beside it.
function picture(name: string): ToolCallFileCard {
	return {
		name,
		path: `Photos/${name}`,
		size: 2048,
		mtime: "2026-06-13T10:00:00.000Z",
		contentType: "image/jpeg",
		previewUrl: `/api/connections/nextcloud/preview?fileId=${name}&size=192`,
		viewUrl: `/api/connections/nextcloud/preview?fileId=${name}&size=1600`,
		webUrl: `https://cloud.example.com/apps/files/?fileid=${name}`,
	};
}

// The server gives a document no preview, so the strip never draws it as a tile.
function pdf(name: string): ToolCallFileCard {
	return {
		...picture(name),
		contentType: "application/pdf",
		previewUrl: null,
		viewUrl: null,
	};
}

// An SVG is an image the server deliberately refuses to preview.
function svg(name: string): ToolCallFileCard {
	return {
		...picture(name),
		contentType: "image/svg+xml",
		previewUrl: null,
		viewUrl: null,
	};
}

describe("filesStripTiles", () => {
	it("draws every picture when they fit the slots", () => {
		const cards = ["lake", "harbour", "market"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[1], pictureIndex: 1 },
			{ kind: "picture", card: cards[2], pictureIndex: 2 },
		]);
	});

	it("draws every picture when they exactly fill the slots", () => {
		const cards = ["lake", "harbour", "market", "vineyard"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[1], pictureIndex: 1 },
			{ kind: "picture", card: cards[2], pictureIndex: 2 },
			{ kind: "picture", card: cards[3], pictureIndex: 3 },
		]);
	});

	it("counts the pictures it leaves out", () => {
		const cards = ["a", "b", "c", "d", "e", "f"].map(picture);
		const tiles = filesStripTiles(cards, STRIP_SLOTS_WIDE);

		expect(tiles).toHaveLength(STRIP_SLOTS_WIDE);
		expect(tiles.slice(0, STRIP_SLOTS_WIDE - 1)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[1], pictureIndex: 1 },
			{ kind: "picture", card: cards[2], pictureIndex: 2 },
		]);
		// The count tile's picture is the first one it hides; a press on the tile
		// opens the file list, so `pictureIndex` names that picture's place.
		expect(tiles[3]).toEqual({
			kind: "count",
			hidden: 3,
			cover: cards[3].previewUrl,
			pictureIndex: 3,
		});
	});

	it("never counts a document as a picture", () => {
		const cards = [
			picture("lake"),
			pdf("contract"),
			picture("harbour"),
			pdf("invoice"),
			picture("market"),
			pdf("letter"),
		];

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[2], pictureIndex: 1 },
			{ kind: "picture", card: cards[4], pictureIndex: 2 },
		]);
	});

	it("counts only pictures when documents overflow with them", () => {
		// Five pictures and three PDFs over four slots: the count tile hides two
		// pictures, not cards, and the documents do not shift the picture indices.
		const cards = [
			picture("a"),
			pdf("contract"),
			picture("b"),
			pdf("invoice"),
			picture("c"),
			pdf("letter"),
			picture("d"),
			picture("e"),
		];

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[2], pictureIndex: 1 },
			{ kind: "picture", card: cards[4], pictureIndex: 2 },
			{
				kind: "count",
				hidden: 2,
				cover: cards[6].previewUrl,
				pictureIndex: 3,
			},
		]);
	});

	it("draws nothing when the call found no pictures", () => {
		expect(filesStripTiles([], STRIP_SLOTS_WIDE)).toEqual([]);
		expect(filesStripTiles([pdf("contract")], STRIP_SLOTS_WIDE)).toEqual([]);
	});

	it("draws one picture as one tile", () => {
		const card = picture("lake");

		expect(filesStripTiles([card], STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card, pictureIndex: 0 },
		]);
	});

	it("covers the count tile with the first picture it hides", () => {
		// A count tile exists only past the slots, so its first hidden picture is
		// always there and covers it; `cover: null` stays the module's fallback.
		const cards = ["a", "b", "c", "d", "e"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_NARROW)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[1], pictureIndex: 1 },
			{
				kind: "count",
				hidden: 3,
				cover: cards[2].previewUrl,
				pictureIndex: 2,
			},
		]);
	});

	it("narrows to three slots", () => {
		const cards = ["a", "b", "c", "d", "e", "f"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_NARROW)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[1], pictureIndex: 1 },
			{
				kind: "count",
				hidden: 4,
				cover: cards[2].previewUrl,
				pictureIndex: 2,
			},
		]);
	});

	it("excludes an image with no preview", () => {
		const cards = [picture("lake"), svg("logo"), picture("harbour")];

		expect(stripPictureCards(cards)).toEqual([cards[0], cards[2]]);
		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "picture", card: cards[0], pictureIndex: 0 },
			{ kind: "picture", card: cards[2], pictureIndex: 1 },
		]);
	});
});
