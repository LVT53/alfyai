import { readFileSync } from "node:fs";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallFileCard } from "$lib/server/services/messages-types";
import { uiLanguage } from "$lib/stores/settings";
import FilesStrip from "./FilesStrip.svelte";

// The strip's only other module: the viewer is loaded on first open, and the
// tests read the pictures and the index back off a stub instead of mounting the
// real full-screen viewer (its portal, focus trap and keys).
const loader = vi.hoisted(() => ({ loadImageLightbox: vi.fn() }));

vi.mock("./image-lightbox-loader", async () => {
	const { default: ViewerStub } = await import(
		"./FilesStripViewerStub.test.svelte"
	);
	loader.loadImageLightbox.mockResolvedValue(ViewerStub);
	return { loadImageLightbox: loader.loadImageLightbox };
});

const PREVIEW = (fileId: number, size: 192 | 1600) =>
	`/api/connections/nextcloud/preview?connectionId=conn-1&fileId=${fileId}&size=${size}`;

/** A picture the server could preview: a tile, and the viewer's picture. */
function picture(name: string, fileId: number): ToolCallFileCard {
	return {
		name,
		path: `Photos/${name}`,
		size: 2_400_000,
		mtime: "2025-06-01T09:00:00Z",
		contentType: "image/jpeg",
		previewUrl: PREVIEW(fileId, 192),
		viewUrl: PREVIEW(fileId, 1600),
		webUrl: `https://cloud.example.com/apps/files/?fileid=${fileId}`,
	};
}

/** A document: no preview, so never a tile — only a row in the list. */
function documentCard(name: string, fileId: number): ToolCallFileCard {
	return {
		name,
		path: `Documents/${name}`,
		size: 48_000,
		mtime: "2024-03-04T09:00:00Z",
		contentType: "application/pdf",
		previewUrl: null,
		viewUrl: null,
		webUrl: `https://cloud.example.com/apps/files/?fileid=${fileId}`,
	};
}

/** A card stored before the viewer existed: a preview and no `viewUrl`. */
function legacyPicture(name: string, fileId: number): ToolCallFileCard {
	const { viewUrl: _omitted, ...legacy } = picture(name, fileId);
	return legacy;
}

/** The pictures of the strip — and, on the single card, its one picture. */
const pictureTiles = () =>
	screen.queryAllByRole("button", { name: /^Open .+, picture \d+ of \d+$/ });

/** Four pictures: exactly the wide strip's slots, one more than the narrow's. */
const FOUR_PICTURES = [1, 2, 3, 4].map((fileId) =>
	picture(`IMG_${fileId}.jpg`, fileId),
);

type NarrowListener = (event: MediaQueryListEvent) => void;

/**
 * jsdom has no `matchMedia` of its own, so the narrow measure is stubbed: the
 * component reads `matches` once and follows `change`, and `set` plays both.
 */
function stubNarrow(matches: boolean) {
	const listeners = new Set<NarrowListener>();
	const query = {
		matches,
		media: "(max-width: 480px)",
		addEventListener: (_type: string, listener: NarrowListener) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: NarrowListener) => {
			listeners.delete(listener);
		},
	};
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => query),
	);
	return {
		set(next: boolean) {
			query.matches = next;
			for (const listener of listeners) {
				listener({ matches: next } as MediaQueryListEvent);
			}
		},
	};
}

/** The lazy viewer's chunk lands in a promise the press does not await. */
async function viewerLoaded() {
	await vi.dynamicImportSettled();
	await tick();
	await waitFor(() =>
		expect(screen.getByTestId("fs-viewer")).toBeInTheDocument(),
	);
}

describe("FilesStrip", () => {
	beforeEach(() => {
		uiLanguage.set("en");
		loader.loadImageLightbox.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("draws one file as a card, not a strip", async () => {
		const only = picture("IMG_2043.jpg", 42);
		render(FilesStrip, { props: { cards: [only] } });

		// The 56px picture, not a 78px tile, and no chevron.
		const shown = pictureTiles()[0];
		const image = shown.querySelector("img");
		expect(image).toHaveAttribute("src", only.previewUrl);
		expect(image).toHaveAttribute("width", "56");
		expect(image).toHaveAttribute("height", "56");
		expect(
			screen.queryByRole("button", { name: /Show (all|the file list)/ }),
		).toBeNull();

		// Its text is one link to Nextcloud, with the facts and the label.
		const link = screen.getByRole("link", { name: /IMG_2043\.jpg/ });
		expect(link).toHaveAttribute("href", only.webUrl);
		expect(link).toHaveAttribute("target", "_blank");
		expect(link).toHaveTextContent("Open in Nextcloud");
		expect(link).toHaveTextContent("2.3 MB");

		// Its picture opens the viewer, and the two are siblings, not nested.
		await fireEvent.click(shown);
		await viewerLoaded();
		expect(loader.loadImageLightbox).toHaveBeenCalledTimes(1);
		expect(screen.getByTestId("fs-viewer")).toHaveAttribute("data-index", "0");
		expect(link.contains(shown)).toBe(false);
	});

	it("draws a tile per picture and a chevron", () => {
		render(FilesStrip, {
			props: {
				cards: [
					picture("IMG_1.jpg", 1),
					picture("IMG_2.jpg", 2),
					picture("IMG_3.jpg", 3),
				],
			},
		});

		const tiles = pictureTiles();
		expect(tiles).toHaveLength(3);
		expect(tiles.map((tile) => tile.getAttribute("aria-label"))).toEqual([
			"Open IMG_1.jpg, picture 1 of 3",
			"Open IMG_2.jpg, picture 2 of 3",
			"Open IMG_3.jpg, picture 3 of 3",
		]);
		for (const tile of tiles) {
			const image = tile.querySelector("img");
			expect(image).toHaveAttribute("width", "78");
			expect(image).toHaveAttribute("height", "78");
		}

		// One chevron, naming the list it opens rather than sharing the count
		// tile's words, and no list until it is pressed.
		const chevrons = screen.getAllByRole("button", {
			name: "Show the file list",
		});
		expect(chevrons).toHaveLength(1);
		expect(
			screen.queryByRole("button", { name: /Show all 3 files/ }),
		).toBeNull();
		expect(chevrons[0]).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("opens the viewer at the picture that was pressed", async () => {
		render(FilesStrip, {
			props: {
				cards: [
					picture("IMG_1.jpg", 1),
					picture("IMG_2.jpg", 2),
					picture("IMG_3.jpg", 3),
				],
			},
		});

		await fireEvent.click(pictureTiles()[1]);
		await viewerLoaded();

		expect(loader.loadImageLightbox).toHaveBeenCalledTimes(1);
		const viewer = screen.getByTestId("fs-viewer");
		expect(viewer).toHaveAttribute("data-index", "1");
		// The viewer is handed the whole call's pictures at the viewer size, in
		// the call's order, with the pressed one open.
		expect(
			screen
				.getAllByTestId("fs-viewer-image")
				.map((image) => image.getAttribute("data-src")),
		).toEqual([PREVIEW(1, 1600), PREVIEW(2, 1600), PREVIEW(3, 1600)]);
		expect(
			screen
				.getAllByTestId("fs-viewer-image")
				.map((image) => image.getAttribute("data-open")),
		).toEqual(["false", "true", "false"]);

		// The viewer's own two props are wired: next moves, close shuts it.
		await fireEvent.click(screen.getByRole("button", { name: "next" }));
		expect(screen.getByTestId("fs-viewer")).toHaveAttribute("data-index", "2");
		await fireEvent.click(screen.getByRole("button", { name: "close" }));
		expect(screen.queryByTestId("fs-viewer")).toBeNull();
	});

	it("gives focus back to the pressed tile when the viewer closes", async () => {
		render(FilesStrip, {
			props: {
				cards: [picture("IMG_1.jpg", 1), picture("IMG_2.jpg", 2)],
			},
		});

		const tile = pictureTiles()[1];
		// A click moves no focus here, as on Safari it does not move it onto the
		// button either, so the strip must hand focus back itself: the viewer's
		// own trap restores whatever had focus when it installed — <body>.
		expect(tile).not.toBe(document.activeElement);
		await fireEvent.click(tile);
		await viewerLoaded();
		await fireEvent.click(screen.getByRole("button", { name: "close" }));
		expect(screen.queryByTestId("fs-viewer")).toBeNull();
		await waitFor(() => expect(document.activeElement).toBe(tile));
	});

	it("opens the list from the chevron and closes it again", async () => {
		render(FilesStrip, {
			props: {
				cards: [
					picture("IMG_1.jpg", 1),
					picture("IMG_2.jpg", 2),
					picture("IMG_3.jpg", 3),
				],
			},
		});

		const chevron = screen.getByRole("button", { name: "Show the file list" });
		expect(chevron).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("list")).toBeNull();

		await fireEvent.click(chevron);
		const list = screen.getByRole("list");
		expect(chevron).toHaveAttribute("aria-expanded", "true");
		expect(chevron).toHaveAttribute("aria-controls", list.id);
		expect(chevron).toHaveAccessibleName("Hide the file list");
		expect(screen.getAllByRole("link")).toHaveLength(3);

		await fireEvent.click(chevron);
		expect(chevron).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByRole("list")).toBeNull();
		expect(loader.loadImageLightbox).not.toHaveBeenCalled();
	});

	it("draws the quiet line and no strip when nothing is a picture", async () => {
		render(FilesStrip, {
			props: {
				cards: [
					documentCard("Report.pdf", 1),
					documentCard("Notes.pdf", 2),
					documentCard("Budget.pdf", 3),
				],
			},
		});

		expect(
			screen.getByText("Searched your files · 3 files"),
		).toBeInTheDocument();
		expect(pictureTiles()).toHaveLength(0);

		// The same chevron, and the list behind it.
		const chevron = screen.getByRole("button", { name: "Show the file list" });
		await fireEvent.click(chevron);
		expect(screen.getByRole("list")).toBeInTheDocument();
		expect(screen.getAllByRole("link")).toHaveLength(3);
	});

	it("draws the count tile for the pictures it leaves out, and it opens the list", async () => {
		const six = Array.from({ length: 6 }, (_, at) =>
			picture(`IMG_${at + 1}.jpg`, at + 1),
		);
		render(FilesStrip, { props: { cards: six } });

		// Four slots: three pictures, then the count tile over the fourth. Its
		// veil says +3, and its own name counts the files the list will show —
		// the chevron names the list instead.
		expect(pictureTiles()).toHaveLength(3);
		const count = screen.getByText("+3").closest("button");
		if (!count) throw new Error("the count tile is not a button");
		expect(count).toHaveAccessibleName("Show all 6 files");
		const cover = count.querySelector("img");
		expect(cover).toHaveAttribute("src", PREVIEW(4, 192));

		await fireEvent.click(count);
		expect(screen.getByRole("list")).toBeInTheDocument();
		expect(screen.getAllByRole("link")).toHaveLength(6);
		// The count tile is a way into the list, never into the viewer.
		expect(loader.loadImageLightbox).not.toHaveBeenCalled();
	});

	it("narrows to three slots at 480px and widens again when the chat grows", async () => {
		const media = stubNarrow(false);
		render(FilesStrip, { props: { cards: FOUR_PICTURES } });

		// Wide: four pictures fit four slots, so there is no count tile.
		expect(pictureTiles()).toHaveLength(4);
		expect(screen.queryByText("+2")).toBeNull();

		media.set(true);
		await tick();
		// Narrow: three slots, so two pictures and the count tile over the two
		// the strip leaves out — three tiles in all. The count tile says how
		// many files the list will show; the chevron names the list itself.
		expect(pictureTiles()).toHaveLength(2);
		expect(screen.getByText("+2")).toBeInTheDocument();
		expect(
			screen.getAllByRole("button", { name: "Show all 4 files" }),
		).toHaveLength(1);
		expect(
			screen.getAllByRole("button", { name: "Show the file list" }),
		).toHaveLength(1);

		media.set(false);
		await tick();
		expect(pictureTiles()).toHaveLength(4);
		expect(screen.queryByText("+2")).toBeNull();
	});

	it("stays wide when there is no matchMedia to measure with", () => {
		vi.stubGlobal("matchMedia", undefined);
		render(FilesStrip, { props: { cards: FOUR_PICTURES } });

		expect(pictureTiles()).toHaveLength(4);
		expect(screen.queryByText("+2")).toBeNull();
	});

	it("draws nothing at all when the call found nothing", () => {
		render(FilesStrip, { props: { cards: [] } });

		// Not the quiet line: "Searched your files · 0 files" over an empty list
		// would be a lie about a call that returned no cards.
		expect(screen.queryByText(/Searched your files/)).toBeNull();
		expect(screen.queryByRole("button")).toBeNull();
		expect(screen.queryByRole("list")).toBeNull();
	});

	it("keeps the whole name reachable when it is too long", async () => {
		// A Hungarian file name, far longer than any card or row.
		const long =
			"Megbeszélés-jegyzőkönyv-2025-június-veszprémi-irodafelújítás-árajánlatok-összesítése-végleges-változat-2.pdf";

		const single = render(FilesStrip, {
			props: { cards: [documentCard(long, 9)] },
		});
		const cardName = screen.getByText(long);
		expect(cardName).toHaveAttribute("title", long);
		expect(cardName).toHaveTextContent(long);
		expect(
			screen.getByRole("link", {
				name: (accessible) => accessible.includes(long),
			}),
		).toBeInTheDocument();
		single.unmount();

		render(FilesStrip, {
			props: { cards: [documentCard(long, 9), documentCard("Short.pdf", 10)] },
		});
		await fireEvent.click(
			screen.getByRole("button", { name: "Show the file list" }),
		);
		const rowName = screen.getByText(long);
		expect(rowName).toHaveAttribute("title", long);
		expect(
			screen.getByRole("link", {
				name: (accessible) => accessible.includes(long),
			}),
		).toBeInTheDocument();
	});

	it("gives a document row one link to Nextcloud", async () => {
		const photo = picture("IMG_1.jpg", 1);
		render(FilesStrip, {
			props: { cards: [photo, documentCard("Report.pdf", 2)] },
		});

		await fireEvent.click(
			screen.getByRole("button", { name: "Show the file list" }),
		);
		const row = screen.getByRole("link", { name: /IMG_1\.jpg/ });

		expect(row).toHaveAttribute("href", photo.webUrl);
		expect(row).toHaveAttribute("target", "_blank");
		expect(row).toHaveAttribute("rel", "noopener noreferrer external");
		// The 40px picture is inside the row's one link, and nothing in the row
		// is a control of its own.
		const inner = row.querySelector("img");
		expect(inner).toHaveAttribute("src", photo.previewUrl);
		expect(inner).toHaveAttribute("width", "40");
		expect(inner).toHaveAttribute("height", "40");
		expect(row.querySelector("button")).toBeNull();
		expect(row.querySelector("a")).toBeNull();

		// A document with no preview keeps its row and its link, with the glyph.
		const documentRow = screen.getByRole("link", { name: /Report\.pdf/ });
		expect(documentRow).toHaveAttribute(
			"href",
			documentCard("Report.pdf", 2).webUrl,
		);
		expect(documentRow.querySelector("svg")).not.toBeNull();
	});

	it("falls back to the preview size for a card with no viewUrl", async () => {
		const legacy = legacyPicture("Old.jpg", 7);
		expect(legacy).not.toHaveProperty("viewUrl");

		render(FilesStrip, { props: { cards: [legacy] } });
		await fireEvent.click(pictureTiles()[0]);
		await viewerLoaded();

		const image = screen.getByTestId("fs-viewer-image");
		expect(image).toHaveAttribute("data-src", PREVIEW(7, 192));
		expect(image.getAttribute("data-src")).toMatch(/size=192$/);
	});

	it("draws the file-type icon in the square when a picture fails to load", async () => {
		const card = render(FilesStrip, {
			props: { cards: [picture("IMG_9.jpg", 9)] },
		});
		await fireEvent.error(
			pictureTiles()[0].querySelector("img") as HTMLImageElement,
		);
		// The square draws the glyph instead, and stays the way into the viewer:
		// its larger copy may still load.
		expect(document.querySelector(".fs-card-picture img")).toBeNull();
		expect(document.querySelector(".fs-card-picture svg")).not.toBeNull();
		expect(pictureTiles()).toHaveLength(1);
		card.unmount();

		render(FilesStrip, {
			props: {
				cards: [picture("IMG_1.jpg", 1), picture("IMG_2.jpg", 2)],
			},
		});
		const tile = pictureTiles()[0];
		await fireEvent.error(tile.querySelector("img") as HTMLImageElement);
		expect(tile.querySelector("img")).toBeNull();
		expect(tile.querySelector("svg")).not.toBeNull();
		// A broken picture never replaces the button: the viewer may still have
		// the bigger copy.
		expect(pictureTiles()).toHaveLength(2);
	});
});

// jsdom applies no component CSS, so the stylesheet itself is the subject of
// the two layout promises the design makes and a DOM test cannot measure: a
// long name truncates rather than widening its box, and each square is the
// design's size.
describe("FilesStrip's stylesheet", () => {
	const source = readFileSync(
		`${process.cwd()}/src/lib/components/chat/FilesStrip.svelte`,
		"utf-8",
	);

	/** The rule that starts at `selector`, not one whose list of selectors ends in it. */
	function rule(css: string, selector: string): string {
		const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return (
			css.match(
				new RegExp(`(?<=(?:^|[{};/])\\s*)${escaped} \\{([^}]*)\\}`),
			)?.[1] ?? ""
		);
	}

	it("keeps a long name on one line, and lets its block shrink, in the card and in every row", () => {
		for (const selector of [
			".fs-card-name",
			".fs-card-facts",
			".fs-row-name",
		]) {
			const name = rule(source, selector);
			expect(name, selector).toMatch(/white-space:\s*nowrap/);
			expect(name, selector).toMatch(/overflow:\s*hidden/);
			expect(name, selector).toMatch(/text-overflow:\s*ellipsis/);
			expect(name, selector).toMatch(/min-width:\s*0/);
		}
		// Without this the name pushes the box wider instead of truncating.
		for (const selector of [".fs-card-text", ".fs-row-text"]) {
			expect(rule(source, selector), selector).toMatch(/min-width:\s*0/);
		}
	});

	it("draws the design's squares: 78px tiles, a 56px card picture and a 40px row picture", () => {
		const tile = rule(source, ".fs-tile");
		expect(tile).toMatch(/width:\s*78px/);
		expect(tile).toMatch(/height:\s*78px/);
		expect(rule(source, ".fs-tile img")).toMatch(/object-fit:\s*cover/);
		expect(rule(source, ".fs-card-picture")).toMatch(/width:\s*56px/);
		expect(rule(source, ".fs-card-picture")).toMatch(/height:\s*56px/);
		expect(rule(source, ".fs-row-picture")).toMatch(/width:\s*40px/);
	});

	it("dims the count tile with the app's one scrim, laid dark enough for small white text", () => {
		const more = rule(source, ".fs-tile-more");
		expect(more).toMatch(/color:\s*var\(--accent-contrast\)/);
		// One 32% scrim leaves the +N at about 2:1 over a bright picture; two
		// layers reach about 4.6:1, which is what small text needs.
		expect(
			more.match(/linear-gradient\(var\(--scrim\), var\(--scrim\)\)/g) ?? [],
		).toHaveLength(2);
		// The dimming is the token's, never a colour written here.
		expect(more).not.toMatch(/#[0-9a-f]{3,8}\b/i);
		expect(more).not.toMatch(/rgba?\(/);
	});
});
