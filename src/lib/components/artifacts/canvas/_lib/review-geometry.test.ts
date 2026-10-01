import { describe, expect, it } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import {
	type Box,
	boxOf,
	changePillPlacement,
	changePillScreenRect,
	keepPillInPane,
	outOfView,
	type PillPlacement,
	padded,
	rectsOf,
} from "./review-geometry";

// Where Alfy's change is on the board, in board space: the rectangle of each
// block it touched, the one that holds them all, and where the pill hangs.

const nodes: CanvasNode[] = sampleBoard().nodes;

describe("where the touched blocks are", () => {
	it("gives each block's own rectangle, skipping the ones that are not on the board", () => {
		const rects = rectsOf(["note-museum", "gone", "text-1"], nodes);
		expect(rects.map((rect) => rect.id)).toEqual(["note-museum", "text-1"]);
		// A block with no size of its own is taken to be as wide as a block is (190)
		// and as tall as its words make it (a short note: 64), as the model reads it.
		expect(rects[0].box).toEqual({ x: 500, y: 60, width: 190, height: 64 });
	});

	it("puts a block inside a frame where the frame puts it, not at its own offset", () => {
		const [note] = rectsOf(["note-1"], nodes);
		expect(note.box.x).toBe(40 + 20);
		expect(note.box.y).toBe(40 + 60);
	});

	it("prefers what the panel measured to what is stored", () => {
		const measured = nodes.map((node) =>
			node.id === "note-museum"
				? { ...node, measured: { width: 240, height: 120 } }
				: node,
		);
		expect(rectsOf(["note-museum"], measured)[0].box).toMatchObject({
			width: 240,
			height: 120,
		});
	});

	it("holds them all in one box", () => {
		expect(boxOf(["note-museum", "text-1"], nodes)).toEqual({
			x: 500,
			y: 60,
			width: 190,
			// text-1 is at y 200 and one line tall (32): down to 232.
			height: 232 - 60,
		});
	});

	it("has no box when none of them is there", () => {
		expect(boxOf([], nodes)).toBeNull();
		expect(boxOf(["gone"], nodes)).toBeNull();
	});

	it("grows a box on every side", () => {
		expect(padded({ x: 10, y: 20, width: 100, height: 50 }, 6)).toEqual({
			x: 4,
			y: 14,
			width: 112,
			height: 62,
		});
	});
});

// The owner's walk: "sometimes the 'Keep Undo' row moves into weird locations far from
// the element". The pill hung from the top-right corner of the box that holds EVERY touched
// block, which for a change spread over the board is an empty corner (or the pane's edge)
// beside none of them. It hangs from the block the review bar is on, and keeps off the
// blocks Alfy left alone by trying that block's other corners.
describe("where the change pill hangs", () => {
	const at = (x: number, y: number, width = 200, height = 100): Box => ({
		x,
		y,
		width,
		height,
	});

	it("hangs above the top-right corner of the block it is for, running left", () => {
		const current = at(100, 100);
		expect(
			changePillPlacement({ current, obstacles: [current], zoom: 1 }),
		).toEqual({
			at: { x: 300, y: 100 },
			align: "end",
			side: "above",
		});
	});

	it("is at the block the review bar is on, not at a corner of the box that holds every touched block", () => {
		// Two touched blocks far apart: the box that held both had its corner at (1100, 100),
		// beside neither.
		const first = at(100, 100);
		const far = at(900, 700);
		const other = changePillPlacement({
			current: far,
			obstacles: [first, far],
			zoom: 1,
		});
		expect(other.at).toEqual({ x: 1100, y: 700 });
		expect(
			changePillPlacement({ current: first, obstacles: [first, far], zoom: 1 })
				.at,
		).toEqual({ x: 300, y: 100 });
	});

	it("goes above the block's top-left corner, running right, when a block Alfy left alone is where the pill would be", () => {
		const current = at(100, 100);
		// Above the top-right corner the pill (280 x 28, 16 up) covers 20..300 x 56..84;
		// a block at 10..90 x 40..90 is in it. Above the top-left corner it covers
		// 100..380 x 56..84, where nothing is.
		const other = at(10, 40, 80, 50);
		expect(
			changePillPlacement({ current, obstacles: [current, other], zoom: 1 }),
		).toEqual({ at: { x: 100, y: 100 }, align: "start", side: "above" });
	});

	it("goes below the block when both places above are taken", () => {
		const current = at(100, 100);
		const row = at(0, 40, 400, 50);
		expect(
			changePillPlacement({ current, obstacles: [current, row], zoom: 1 }),
		).toEqual({ at: { x: 300, y: 200 }, align: "end", side: "below" });
	});

	it("goes below and to the right when the corner below is taken too", () => {
		const current = at(100, 100);
		const above = at(0, 40, 400, 50);
		// Below the bottom-right corner the pill covers 20..300 x 216..244; below the
		// bottom-left one, 100..380 x 216..244, which a block at 0..90 is out of.
		const below = at(0, 210, 90, 50);
		expect(
			changePillPlacement({
				current,
				obstacles: [current, above, below],
				zoom: 1,
			}),
		).toEqual({ at: { x: 100, y: 200 }, align: "start", side: "below" });
	});

	it("takes the place with the least under it when every place is under something", () => {
		const current = at(100, 100);
		const blanket = at(-2000, -2000, 5000, 5000);
		expect(
			changePillPlacement({ current, obstacles: [blanket], zoom: 1 }),
		).toEqual({ at: { x: 300, y: 100 }, align: "end", side: "above" });
	});

	it("keeps the pill's size on the screen at any zoom, so it is bigger in board units when zoomed out", () => {
		const current = at(900, 400);
		// At 1 the pill is 280 x 28, above (1100, 400): 820..1100 x 356..384. A block at
		// 600..800 is clear of it, and at 0.5 (560 x 56 in board units: 540..1100) it is not.
		const left = at(600, 340, 200, 40);
		expect(
			changePillPlacement({ current, obstacles: [current, left], zoom: 1 })
				.align,
		).toBe("end");
		expect(
			changePillPlacement({ current, obstacles: [current, left], zoom: 0.5 })
				.align,
		).toBe("start");
	});

	it("takes the pill's measured size when it has one", () => {
		const current = at(100, 100);
		// 186 wide (measured) from the corner at 300 covers 114..300: a block at 40..100 is clear of it,
		// where the widest (280, from 20) would have covered it.
		const other = at(40, 40, 60, 50);
		expect(
			changePillPlacement({ current, obstacles: [current, other], zoom: 1 })
				.align,
		).toBe("start");
		expect(
			changePillPlacement({
				current,
				obstacles: [current, other],
				zoom: 1,
				size: { width: 186, height: 26 },
			}).align,
		).toBe("end");
	});
});

// RC-3 N3: the pill hangs to one side of its point, 280 wide at most, so a block near an
// edge of the pane put its pill half outside it. The pill is moved along the screen,
// never off it.
describe("where the change pill is kept in the pane", () => {
	const CAMERA = { x: 0, y: 0, zoom: 1 };
	const PANE = { width: 800, height: 600 };
	const SIZE = { width: 250, height: 28 };
	const above = (x: number, y: number): PillPlacement => ({
		at: { x, y },
		align: "end",
		side: "above",
	});

	it("leaves a pill that already fits exactly where it hangs", () => {
		const placement = above(500, 200);
		expect(
			keepPillInPane({ placement, camera: CAMERA, pane: PANE, size: SIZE }),
		).toEqual(placement);
	});

	it("slides a pill that would be cut off at the left edge to the edge, a gap inside it", () => {
		// Hung from x = 120 it would run from -130: it is moved so its left edge is 8 in.
		const kept = keepPillInPane({
			placement: above(120, 200),
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(kept.at).toEqual({ x: 258, y: 200 });
		const rect = changePillScreenRect(kept, CAMERA, SIZE);
		expect(rect.left).toBe(8);
		expect(rect.right).toBe(258);
	});

	it("slides a pill that would be cut off at the right edge, and one above the top edge", () => {
		const right = keepPillInPane({
			placement: above(900, 200),
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(right.at.x).toBe(792);
		const top = keepPillInPane({
			placement: above(500, 10),
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		// 16 above its corner, 28 tall, 8 inside the top edge.
		expect(top.at.y).toBe(52);
		expect(changePillScreenRect(top, CAMERA, SIZE).top).toBe(8);
	});

	it("keeps the pill above the board's own toolbar along the bottom of the pane", () => {
		const low = keepPillInPane({
			placement: above(500, 590),
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(changePillScreenRect(low, CAMERA, SIZE).bottom).toBeLessThanOrEqual(
			600 - 72,
		);
	});

	it("does the arithmetic on the screen, through the camera, and answers in board units", () => {
		// Zoomed to 0.5 and panned: a block's corner at board (200, 300) is at screen (100 + 20, 150 + 10).
		const camera = { x: 20, y: 10, zoom: 0.5 };
		const kept = keepPillInPane({
			placement: above(200, 300),
			camera,
			pane: PANE,
			size: SIZE,
		});
		const rect = changePillScreenRect(kept, camera, SIZE);
		expect(rect.left).toBe(8);
		expect(rect.right).toBe(258);
		// Back in board units: the screen's 258 is (258 - 20) / 0.5.
		expect(kept.at.x).toBe(476);
		expect(kept.at.y).toBe(300);
	});

	it("puts the left edge inside when the pane is narrower than the pill, and does nothing before the pane is measured", () => {
		const narrow = keepPillInPane({
			placement: above(100, 200),
			camera: CAMERA,
			pane: { width: 200, height: 600 },
			size: SIZE,
		});
		expect(changePillScreenRect(narrow, CAMERA, SIZE).left).toBe(8);
		const placement = above(10, 10);
		expect(
			keepPillInPane({
				placement,
				camera: CAMERA,
				pane: { width: 0, height: 0 },
				size: SIZE,
			}),
		).toEqual(placement);
	});

	it("measures a pill that runs right, or hangs below, from its own edges", () => {
		const start: PillPlacement = {
			at: { x: 100, y: 200 },
			align: "start",
			side: "below",
		};
		expect(changePillScreenRect(start, CAMERA, SIZE)).toEqual({
			left: 100,
			top: 216,
			right: 350,
			bottom: 244,
		});
		// Slid in at the right edge: its right edge 8 inside, still running right from its point.
		const kept = keepPillInPane({
			placement: { ...start, at: { x: 700, y: 200 } },
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(changePillScreenRect(kept, CAMERA, SIZE).right).toBe(792);
		expect(kept.align).toBe("start");
		expect(kept.side).toBe("below");
	});
});

// A pill is no use at the pane's edge beside nothing: when the block it is for cannot
// be seen at all it is not drawn.
describe("whether a block is out of the pane's view", () => {
	const PANE = { width: 800, height: 600 };
	const CAMERA = { x: 0, y: 0, zoom: 1 };
	const box = (x: number, y: number): Box => ({
		x,
		y,
		width: 200,
		height: 100,
	});

	it("is in view when any of it is on the pane, even a corner or only under the toolbar", () => {
		expect(outOfView(box(100, 100), CAMERA, PANE)).toBe(false);
		expect(outOfView(box(700, 500), CAMERA, PANE)).toBe(false);
		expect(outOfView(box(-150, -50), CAMERA, PANE)).toBe(false);
		expect(outOfView(box(300, 560), CAMERA, PANE)).toBe(false);
	});

	it("is out of view when it is wholly beyond an edge, touching it or not", () => {
		expect(outOfView(box(800, 100), CAMERA, PANE)).toBe(true);
		expect(outOfView(box(-200, 100), CAMERA, PANE)).toBe(true);
		expect(outOfView(box(100, -100), CAMERA, PANE)).toBe(true);
		expect(outOfView(box(100, 600), CAMERA, PANE)).toBe(true);
	});

	it("reads the screen, through the camera", () => {
		const camera = { x: -900, y: 0, zoom: 0.5 };
		// The block at board x 1000 is at screen 1000 * 0.5 - 900 = -400: 100 wide, gone.
		expect(outOfView(box(1000, 100), camera, PANE)).toBe(true);
		expect(outOfView(box(2000, 100), camera, PANE)).toBe(false);
	});

	it("says it is not out of view before the pane is measured", () => {
		expect(outOfView(box(5000, 5000), CAMERA, { width: 0, height: 0 })).toBe(
			false,
		);
	});
});
