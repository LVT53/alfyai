import { describe, expect, it } from "vitest";
import { deriveRowDetail } from "./detail";

const doc = (...blocks: Array<[string, string]>) =>
	blocks.map(([id, text]) => `<!--b:${id}-->\n${text}`).join("\n\n");

const board = (
	nodes: Array<{
		id: string;
		text?: string;
		x?: number;
		y?: number;
		parentId?: string;
	}>,
	edges: Array<{ id: string; source: string; target: string }> = [],
) =>
	JSON.stringify({
		version: 1,
		nodes: nodes.map((node) => ({
			id: node.id,
			type: "sticky",
			position: { x: node.x ?? 0, y: node.y ?? 0 },
			...(node.parentId ? { parentId: node.parentId } : {}),
			data: { kind: "sticky", text: node.text ?? node.id, tone: "yellow" },
		})),
		edges,
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	});

const NO_TABS: never[] = [];

describe("deriveRowDetail — a Document", () => {
	const before = doc(
		["p1", "Saturday"],
		["p2", "Morning at the museum."],
		["p3", "Evening: dinner."],
	);

	it("counts the blocks changed, added and removed, naming the first of each", () => {
		const after = doc(
			["p1", "Saturday, rainy"],
			["p2", "Morning at the museum."],
			["p4", "Museum tickets"],
			["p5", "Buy them online."],
		);
		const { detail } = deriveRowDetail({
			kind: "document",
			before,
			after,
			tabs: NO_TABS,
		});
		expect(detail).toEqual({
			type: "document",
			changed: { count: 1, first: "Saturday, rainy" },
			added: { count: 2, first: "Museum tickets" },
			removed: { count: 1, first: "Evening: dinner." },
			tab: null,
		});
	});

	it("says nothing for a save that changed nothing, and for a first version", () => {
		expect(
			deriveRowDetail({
				kind: "document",
				before,
				after: before,
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
		expect(
			deriveRowDetail({
				kind: "document",
				before: null,
				after: before,
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
	});

	it("names the tab of the first changed block, only when it is not the first tab", () => {
		const tabs = [
			{ id: "t1", title: "Plan", startBlockId: "p1" },
			{ id: "t2", title: "Budget", startBlockId: "p3" },
		];
		const edited = doc(
			["p1", "Saturday"],
			["p2", "Morning at the museum."],
			["p3", "Evening: dinner, 40 EUR."],
		);
		expect(
			deriveRowDetail({ kind: "document", before, after: edited, tabs }).detail,
		).toMatchObject({ type: "document", tab: "Budget" });
		const firstTab = doc(
			["p1", "Saturday!"],
			["p2", "Morning at the museum."],
			["p3", "Evening: dinner."],
		);
		expect(
			deriveRowDetail({ kind: "document", before, after: firstTab, tabs })
				.detail,
		).toMatchObject({ type: "document", tab: null });
	});

	it("reads a task whose checked state alone flipped as a tick", () => {
		// Each task item is a block of its own, as the editor writes them.
		const open = doc(
			["t1", "- [ ] Renew passport"],
			["t2", "- [ ] Book train"],
		);
		const ticked = doc(
			["t1", "- [x] Renew passport"],
			["t2", "- [ ] Book train"],
		);
		const result = deriveRowDetail({
			kind: "document",
			before: open,
			after: ticked,
			tabs: NO_TABS,
		});
		expect(result.tick).toEqual({ text: "Renew passport", checked: true });
		const unticked = deriveRowDetail({
			kind: "document",
			before: ticked,
			after: open,
			tabs: NO_TABS,
		});
		expect(unticked.tick).toEqual({ text: "Renew passport", checked: false });
	});

	it("does not call it a tick when the words changed too, or two tasks flipped", () => {
		const open = doc(
			["t1", "- [ ] Renew passport"],
			["t2", "- [ ] Book train"],
		);
		expect(
			deriveRowDetail({
				kind: "document",
				before: open,
				after: doc(
					["t1", "- [x] Renew the passport"],
					["t2", "- [ ] Book train"],
				),
				tabs: NO_TABS,
			}).tick,
		).toBeNull();
		expect(
			deriveRowDetail({
				kind: "document",
				before: open,
				after: doc(["t1", "- [x] Renew passport"], ["t2", "- [x] Book train"]),
				tabs: NO_TABS,
			}).tick,
		).toBeNull();
	});

	it("skips a body it was told is too large to compare", () => {
		expect(
			deriveRowDetail({
				kind: "document",
				before,
				after: before,
				large: true,
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "large" });
	});

	it("hands back the id-to-hash index and the changed ids the review statuses read", () => {
		const after = doc(
			["p1", "Saturday, rainy"],
			["p2", "Morning at the museum."],
			["p4", "New."],
		);
		const result = deriveRowDetail({
			kind: "document",
			before,
			after,
			tabs: NO_TABS,
		});
		expect(result.changedBlockIds.sort()).toEqual(["p1", "p4"]);
		expect(Object.keys(result.blockIndex ?? {}).sort()).toEqual([
			"p1",
			"p2",
			"p4",
		]);
	});
});

describe("deriveRowDetail — a Canvas", () => {
	it("counts blocks and arrows by what happened to them", () => {
		const before = board(
			[
				{ id: "a", text: "Museum", x: 0, y: 0 },
				{ id: "b", text: "Dinner", x: 100, y: 0 },
				{ id: "c", text: "Hotel", x: 200, y: 0 },
			],
			[{ id: "e1", source: "a", target: "b" }],
		);
		const after = board(
			[
				{ id: "a", text: "Museum", x: 50, y: 0 },
				{ id: "b", text: "Dinner at eight", x: 100, y: 0 },
				{ id: "d", text: "Rainy-day plan", x: 300, y: 0 },
			],
			[{ id: "e2", source: "a", target: "d" }],
		);
		const { detail } = deriveRowDetail({
			kind: "canvas",
			before,
			after,
			tabs: NO_TABS,
		});
		expect(detail).toEqual({
			type: "canvas",
			blocksAdded: { count: 1, first: "Rainy-day plan" },
			blocksChanged: { count: 1, first: "Dinner at eight" },
			blocksRemoved: { count: 1, first: "Hotel" },
			blocksMoved: 1,
			blocksReparented: 0,
			arrowsAdded: 1,
			arrowsChanged: 0,
			arrowsRemoved: 1,
		});
	});

	it("says nothing for a board that did not change, and reads a body that is not a board as empty", () => {
		const same = board([{ id: "a" }]);
		expect(
			deriveRowDetail({
				kind: "canvas",
				before: same,
				after: same,
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
		expect(
			deriveRowDetail({
				kind: "canvas",
				before: "not json",
				after: same,
				tabs: NO_TABS,
			}).detail,
		).toMatchObject({ type: "canvas", blocksAdded: { count: 1 } });
	});
});

describe("deriveRowDetail — an App", () => {
	it("counts the source lines changed", () => {
		const detail = deriveRowDetail({
			kind: "app",
			before: "<h1>Tips</h1>\n<p>a</p>\n<p>b</p>",
			after: "<h1>Tips</h1>\n<p>A</p>\n<p>b</p>\n<p>c</p>",
			tabs: NO_TABS,
		}).detail;
		expect(detail).toEqual({ type: "app", linesAdded: 2, linesRemoved: 1 });
	});

	it("says nothing about an identical source or a first version", () => {
		expect(
			deriveRowDetail({
				kind: "app",
				before: "<p>a</p>",
				after: "<p>a</p>",
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
		expect(
			deriveRowDetail({
				kind: "app",
				before: null,
				after: "<p>a</p>",
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
	});
});

describe("deriveRowDetail — other kinds", () => {
	it("has nothing to say about a kind with no history of its own", () => {
		expect(
			deriveRowDetail({
				kind: "slides",
				before: "a",
				after: "b",
				tabs: NO_TABS,
			}).detail,
		).toEqual({ type: "none" });
	});
});
