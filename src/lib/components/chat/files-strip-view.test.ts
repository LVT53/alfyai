import { get } from "svelte/store";
import { describe, expect, it } from "vitest";
import { t } from "$lib/i18n";
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import {
	fileCardFacts,
	filesStripTiles,
	STRIP_SLOTS_NARROW,
	STRIP_SLOTS_WIDE,
	stripPictureCards,
} from "./files-strip-view";

// The real English dictionary, so the facts read as the person sees them.
const translate = get(t);

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

// The server gives a document no preview: it draws its type, and opens in
// Nextcloud rather than in the picture viewer.
function pdf(name: string): ToolCallFileCard {
	return {
		...picture(name),
		path: `Invoices/${name}`,
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
	it("draws every file when they fit the slots", () => {
		const cards = ["lake", "harbour", "market"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: 1 },
			{ kind: "file", card: cards[2], pictureIndex: 2 },
		]);
	});

	it("draws every file when they exactly fill the slots", () => {
		const cards = ["lake", "harbour", "market", "vineyard"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: 1 },
			{ kind: "file", card: cards[2], pictureIndex: 2 },
			{ kind: "file", card: cards[3], pictureIndex: 3 },
		]);
	});

	it("counts the files it leaves out", () => {
		const cards = ["a", "b", "c", "d", "e", "f"].map(picture);
		const tiles = filesStripTiles(cards, STRIP_SLOTS_WIDE);

		expect(tiles).toHaveLength(STRIP_SLOTS_WIDE);
		expect(tiles.slice(0, STRIP_SLOTS_WIDE - 1)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: 1 },
			{ kind: "file", card: cards[2], pictureIndex: 2 },
		]);
		// The count tile counts files, so `+N` agrees with the list behind it.
		expect(tiles[3]).toEqual({
			kind: "count",
			hidden: 3,
			cover: cards[3].previewUrl,
		});
	});

	it("gives a document a tile of its own, and no picture place", () => {
		const cards = [pdf("contract")];

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: null },
		]);
		// An SVG draws its type too, for the same reason: no preview to show.
		expect(filesStripTiles([svg("logo")], STRIP_SLOTS_WIDE)[0]).toMatchObject({
			kind: "file",
			pictureIndex: null,
		});
	});

	it("keeps pictures and documents in the order the call returned them", () => {
		const cards = [picture("lake"), pdf("contract"), picture("harbour")];

		expect(filesStripTiles(cards, STRIP_SLOTS_WIDE)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: null },
			{ kind: "file", card: cards[2], pictureIndex: 1 },
		]);
	});

	it("counts a mixed overflow by files, covering with the first hidden picture", () => {
		// Five files over three slots: two tiles and a count of three, faced with
		// the first hidden file that has a picture.
		const cards = [
			picture("a"),
			pdf("contract"),
			picture("b"),
			pdf("invoice"),
			picture("c"),
		];

		expect(filesStripTiles(cards, STRIP_SLOTS_NARROW)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: null },
			{ kind: "count", hidden: 3, cover: cards[2].previewUrl },
		]);
	});

	it("leaves the count tile bare when every hidden file is a document", () => {
		const cards = [pdf("a"), pdf("b"), pdf("c"), pdf("d"), pdf("e")];

		expect(filesStripTiles(cards, STRIP_SLOTS_NARROW)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: null },
			{ kind: "file", card: cards[1], pictureIndex: null },
			{ kind: "count", hidden: 3, cover: null },
		]);
	});

	it("draws nothing when the call found nothing", () => {
		expect(filesStripTiles([], STRIP_SLOTS_WIDE)).toEqual([]);
	});

	it("narrows to three slots", () => {
		const cards = ["a", "b", "c", "d", "e", "f"].map(picture);

		expect(filesStripTiles(cards, STRIP_SLOTS_NARROW)).toEqual([
			{ kind: "file", card: cards[0], pictureIndex: 0 },
			{ kind: "file", card: cards[1], pictureIndex: 1 },
			{ kind: "count", hidden: 4, cover: cards[2].previewUrl },
		]);
	});

	it("still reports which files the viewer can open", () => {
		const cards = [picture("lake"), svg("logo"), pdf("contract")];

		expect(stripPictureCards(cards)).toEqual([cards[0]]);
	});
});

// The one copy of a card's size-and-date line: the strip's single card and its
// list rows both read this, so the two surfaces cannot word the same file
// differently.
describe("fileCardFacts", () => {
	it("says the size and, when there is one, the date with its year", () => {
		const card: ToolCallFileCard = {
			...pdf("Q3 report.pdf"),
			size: 24_576,
			mtime: "Wed, 21 Oct 2015 07:28:00 GMT",
		};

		expect(fileCardFacts(card, translate)).toMatch(/^24 KB · .+ 2015$/);
	});

	it("shows the size alone when the provider reported no mtime", () => {
		expect(
			fileCardFacts({ ...pdf("contract.pdf"), mtime: null }, translate),
		).toBe("2 KB");
	});
});
