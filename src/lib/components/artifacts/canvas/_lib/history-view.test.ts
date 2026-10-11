import { describe, expect, it } from "vitest";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	buildHistoryView,
	fitCamera,
	PREVIEW_MAX_ZOOM,
	PREVIEW_MIN_ZOOM,
} from "./history-view";

// What History draws on a board's preview (ruling 76, versioning.md §5.4): which
// blocks are ringed, which are new, where a moved one was, what is gone, and the
// list a screen reader and the stepper walk. Pure, so it is read without a browser.

function body(nodes: CanvasNode[], edges: CanvasBody["edges"] = []): CanvasBody {
	return {
		version: 1,
		nodes,
		edges,
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

function note(
	id: string,
	x: number,
	y: number,
	text: string,
	parentId?: string,
): CanvasNode {
	return {
		id,
		type: "sticky",
		position: { x, y },
		width: 180,
		...(parentId ? { parentId } : {}),
		data: { kind: "sticky", text, tone: "yellow" },
	};
}

function frame(id: string, x: number, y: number, label: string): CanvasNode {
	return {
		id,
		type: "frame",
		position: { x, y },
		width: 320,
		height: 240,
		data: { kind: "frame", label, width: 320, height: 240 },
	};
}

const SAT = frame("frame-sat", 20, 20, "Saturday");
const LUNCH = note("note-lunch", 24, 64, "Lunch at the market", "frame-sat");
const MUSEUM = note("note-museum", 420, 40, "Museum, 14:00");

describe("a version with nothing to compare it with", () => {
	it("marks nothing", () => {
		const view = buildHistoryView(null, body([SAT, LUNCH, MUSEUM]));
		expect(view).toEqual({
			changes: [],
			ringIds: [],
			newIds: [],
			moved: [],
			ghosts: [],
		});
	});

	it("marks nothing when the two boards are the same", () => {
		const same = body([SAT, LUNCH, MUSEUM]);
		expect(buildHistoryView(same, same).changes).toEqual([]);
	});
});

describe("what a version added", () => {
	const base = body([SAT, LUNCH]);
	const target = body([
		SAT,
		LUNCH,
		frame("frame-sun", 20, 300, "Sunday"),
		note("note-brunch", 24, 64, "Brunch, 10:30", "frame-sun"),
	]);

	it("rings the new blocks and tags them new", () => {
		const view = buildHistoryView(base, target);
		expect(view.newIds).toEqual(["frame-sun", "note-brunch"]);
		expect(view.ringIds).toEqual(["frame-sun", "note-brunch"]);
	});

	it("lists each as added, with its own words", () => {
		const { changes } = buildHistoryView(base, target);
		expect(changes).toEqual([
			{ id: "frame-sun", kind: "added", label: "Sunday", blockKind: "frame" },
			{
				id: "note-brunch",
				kind: "added",
				label: "Brunch, 10:30",
				blockKind: "sticky",
			},
		]);
	});
});

describe("what a version changed", () => {
	it("rings a block whose words changed, without calling it new", () => {
		const base = body([SAT, LUNCH]);
		const target = body([
			SAT,
			note("note-lunch", 24, 64, "Lunch at 13:00", "frame-sat"),
		]);
		const view = buildHistoryView(base, target);
		expect(view.ringIds).toEqual(["note-lunch"]);
		expect(view.newIds).toEqual([]);
		expect(view.changes).toEqual([
			{
				id: "note-lunch",
				kind: "changed",
				label: "Lunch at 13:00",
				blockKind: "sticky",
			},
		]);
	});

	it("says a block moved, and where it was, as a place on the board (not in its frame)", () => {
		const base = body([SAT, LUNCH]);
		const target = body([
			SAT,
			note("note-lunch", 124, 164, "Lunch at the market", "frame-sat"),
		]);
		const view = buildHistoryView(base, target);
		expect(view.changes.map((change) => change.kind)).toEqual(["moved"]);
		expect(view.moved).toHaveLength(1);
		// Frame at (20, 20) plus the note's own (24, 64): where it stood on the board.
		expect(view.moved[0]).toMatchObject({
			id: "note-lunch",
			from: { x: 44, y: 84 },
		});
	});

	it("names a block that moved AND changed by what it says, and still draws its trail", () => {
		const base = body([SAT, MUSEUM]);
		const target = body([
			SAT,
			note("note-museum", 500, 100, "Museum, 15:00"),
		]);
		const view = buildHistoryView(base, target);
		expect(view.changes.map((change) => change.kind)).toEqual(["changed"]);
		expect(view.moved.map((entry) => entry.id)).toEqual(["note-museum"]);
	});

	it("leaves out the trail of a block that ends up where it was on the board", () => {
		// The frame went 100 left and the note 100 right inside it: same place.
		const base = body([frame("frame-sat", 120, 20, "Saturday"), note("n", 0, 64, "x", "frame-sat")]);
		const target = body([frame("frame-sat", 20, 20, "Saturday"), note("n", 100, 64, "x", "frame-sat")]);
		const view = buildHistoryView(base, target);
		expect(view.moved.map((entry) => entry.id)).not.toContain("n");
	});

	it("counts a block that went into a frame as moved", () => {
		const base = body([SAT, note("note-lunch", 50, 90, "Lunch")]);
		const target = body([SAT, note("note-lunch", 30, 70, "Lunch", "frame-sat")]);
		const view = buildHistoryView(base, target);
		expect(view.ringIds).toContain("note-lunch");
		expect(view.changes.find((change) => change.id === "note-lunch")?.kind).toBe(
			"moved",
		);
	});

	it("rings both ends of an arrow that was added, as a connection that changed", () => {
		const base = body([LUNCH, MUSEUM, SAT]);
		const target = body(
			[SAT, LUNCH, MUSEUM],
			[{ id: "e1", source: "note-lunch", target: "note-museum" }],
		);
		const view = buildHistoryView(base, target);
		expect(view.ringIds.sort()).toEqual(["note-lunch", "note-museum"]);
		expect(view.changes.map((change) => change.kind)).toEqual([
			"linked",
			"linked",
		]);
	});
});

describe("what a version removed", () => {
	const base = body([SAT, LUNCH, MUSEUM]);
	const target = body([SAT, LUNCH]);

	it("leaves a ghost where it stood, with its words", () => {
		const view = buildHistoryView(base, target);
		expect(view.ghosts).toHaveLength(1);
		expect(view.ghosts[0]).toMatchObject({
			id: "note-museum",
			label: "Museum, 14:00",
			blockKind: "sticky",
		});
		expect(view.ghosts[0].rect).toMatchObject({ x: 420, y: 40, width: 180 });
	});

	it("does not ring what is not there, and lists it after what is", () => {
		const view = buildHistoryView(
			base,
			body([SAT, note("note-lunch", 24, 64, "Lunch at 13:00", "frame-sat")]),
		);
		expect(view.ringIds).toEqual(["note-lunch"]);
		expect(view.changes.map((change) => [change.id, change.kind])).toEqual([
			["note-lunch", "changed"],
			["note-museum", "removed"],
		]);
	});

	it("puts the ghost of a block that was in a frame where it stood on the board", () => {
		const view = buildHistoryView(base, body([SAT, MUSEUM]));
		expect(view.ghosts[0].rect).toMatchObject({ x: 44, y: 84 });
	});
});

describe("naming a block", () => {
	it("reads a note's text, a frame's label and a checklist's label, in a few words", () => {
		const long = "A very long afternoon at the museum with a stop for coffee and cake";
		const base = body([]);
		const target = body([
			note("a", 0, 0, long),
			{
				id: "b",
				type: "checklist",
				position: { x: 300, y: 0 },
				data: {
					kind: "checklist",
					label: "Pack",
					items: [{ id: "i1", text: "Passport", done: false }],
				},
			} as CanvasNode,
		]);
		const [first, second] = buildHistoryView(base, target).changes;
		expect(first.label?.length).toBeLessThanOrEqual(41);
		expect(first.label?.endsWith("…")).toBe(true);
		expect(second.label).toBe("Pack");
	});

	it("has no label for a block with no words of its own", () => {
		const target = body([
			{
				id: "m",
				type: "text",
				position: { x: 0, y: 0 },
				data: { kind: "text", text: "   " },
			},
		]);
		expect(buildHistoryView(body([]), target).changes[0].label).toBeNull();
	});
});

describe("where the camera goes", () => {
	const pane = { width: 800, height: 600 };

	it("fits what it is shown into the pane, centred, never past 1:1", () => {
		const camera = fitCamera({ x: 100, y: 100, width: 100, height: 60 }, pane);
		expect(camera.zoom).toBe(PREVIEW_MAX_ZOOM);
		// Centred: the box's middle is the middle of the room the padding leaves.
		const middle = {
			x: camera.x + (100 + 50) * camera.zoom,
			y: camera.y + (100 + 30) * camera.zoom,
		};
		expect(Math.round(middle.x)).toBe(400);
		expect(Math.round(middle.y)).toBeGreaterThan(280);
		expect(Math.round(middle.y)).toBeLessThan(320);
	});

	it("zooms out to take in a box bigger than the pane, but not past the board's own floor", () => {
		const big = fitCamera({ x: 0, y: 0, width: 4000, height: 3000 }, pane);
		expect(big.zoom).toBeLessThan(0.3);
		expect(big.zoom).toBeGreaterThanOrEqual(PREVIEW_MIN_ZOOM);
		const huge = fitCamera({ x: 0, y: 0, width: 90000, height: 90000 }, pane);
		expect(huge.zoom).toBe(PREVIEW_MIN_ZOOM);
	});

	it("survives a pane that has not been measured", () => {
		const camera = fitCamera(
			{ x: 0, y: 0, width: 100, height: 100 },
			{ width: 0, height: 0 },
		);
		expect(Number.isFinite(camera.x + camera.y + camera.zoom)).toBe(true);
	});
});
