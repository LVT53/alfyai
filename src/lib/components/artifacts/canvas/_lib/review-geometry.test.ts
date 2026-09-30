import { describe, expect, it } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import {
	type Box,
	boxOf,
	changePillAnchor,
	changePillScreenRect,
	keepPillInPane,
	padded,
	rectsOf,
} from "./review-geometry";

// Where Alfy's change is on the board, in board space: the rectangle of each
// block it touched, and the one that holds them all (the pill sits at its corner).

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

// RV-3 Minor 2: the pill hung from the top-right corner of the box that holds every
// touched block, which for a change spread over the board is a corner over blocks
// Alfy never touched (walk 04: over the packing list).
describe("where the change pill hangs", () => {
	const at = (x: number, y: number, width = 200, height = 100): Box => ({
		x,
		y,
		width,
		height,
	});

	it("hangs from the top-right corner of the box that holds the change, when nothing is under the pill there", () => {
		const touched = [at(100, 100), at(500, 300)];
		expect(changePillAnchor({ touched, obstacles: touched, zoom: 1 })).toEqual({
			x: 700,
			y: 100,
		});
	});

	it("moves to the corner of a touched block when that corner would put the pill on a block Alfy left alone", () => {
		const touched = [at(100, 100), at(500, 300)];
		// The pill hangs 16 above its corner and is 280 x 28 on the screen: from (700, 100) it
		// would cover 420..700 x 56..84, which a block at 600..800 x 40..90 is in.
		const other = at(600, 40, 200, 50);
		const anchor = changePillAnchor({
			touched,
			obstacles: [...touched, other],
			zoom: 1,
		});
		expect(anchor).toEqual({ x: 300, y: 100 });
	});

	it("keeps the pill's size on the screen at any zoom, so it is bigger in board units when zoomed out", () => {
		const touched = [at(100, 400), at(900, 400)];
		// Zoomed out to 0.5 the pill is 560 x 56 in board units: from the union's corner (1100, 400)
		// it covers 540..1100 x 328..384, where a block at 800..1000 x 340..380 is.
		const other = at(800, 340, 200, 40);
		expect(
			changePillAnchor({ touched, obstacles: [...touched, other], zoom: 0.5 })
				?.x,
		).not.toBe(1100);
		// At 1 it is 280 x 28: 820..1100 x 356..384 still covers it, so the same holds.
		expect(
			changePillAnchor({ touched, obstacles: [...touched, other], zoom: 1 })?.x,
		).not.toBe(1100);
		// A block that is out of the way of both does not move it.
		const far = at(800, 100, 200, 40);
		expect(
			changePillAnchor({ touched, obstacles: [...touched, far], zoom: 0.5 }),
		).toEqual({ x: 1100, y: 400 });
	});

	it("falls back to the box's own corner when every corner is under something", () => {
		const touched = [at(100, 100)];
		// A block the size of the neighbourhood: the only corner there is.
		const blanket = at(-2000, -2000, 5000, 5000);
		expect(
			changePillAnchor({ touched, obstacles: [blanket], zoom: 1 }),
		).toEqual({ x: 300, y: 100 });
	});

	it("has no anchor when nothing is touched", () => {
		expect(
			changePillAnchor({ touched: [], obstacles: [], zoom: 1 }),
		).toBeNull();
	});
});

// RC-3 N3: the pill hangs from a block's corner, 280 wide at most and to the LEFT of
// it, so a block near the left edge of the pane put its pill half outside it. The
// pill is moved along the screen, never off it.
describe("where the change pill is kept in the pane", () => {
	const CAMERA = { x: 0, y: 0, zoom: 1 };
	const PANE = { width: 800, height: 600 };
	const SIZE = { width: 250, height: 28 };

	it("leaves a pill that already fits exactly where it hangs", () => {
		const anchor = { x: 500, y: 200 };
		expect(
			keepPillInPane({ anchor, camera: CAMERA, pane: PANE, size: SIZE }),
		).toEqual(anchor);
	});

	it("slides a pill that would be cut off at the left edge to the edge, a gap inside it", () => {
		// Hung from x = 120 it would run from -130: it is moved so its left edge is 8 in.
		const kept = keepPillInPane({
			anchor: { x: 120, y: 200 },
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(kept).toEqual({ x: 258, y: 200 });
		const rect = changePillScreenRect(kept, CAMERA, SIZE);
		expect(rect.left).toBe(8);
		expect(rect.right).toBe(258);
	});

	it("slides a pill that would be cut off at the right edge, and one above the top edge", () => {
		const right = keepPillInPane({
			anchor: { x: 900, y: 200 },
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		expect(right.x).toBe(792);
		const top = keepPillInPane({
			anchor: { x: 500, y: 10 },
			camera: CAMERA,
			pane: PANE,
			size: SIZE,
		});
		// 16 above its corner, 28 tall, 8 inside the top edge.
		expect(top.y).toBe(52);
		expect(changePillScreenRect(top, CAMERA, SIZE).top).toBe(8);
	});

	it("keeps the pill above the board's own toolbar along the bottom of the pane", () => {
		const low = keepPillInPane({
			anchor: { x: 500, y: 590 },
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
			anchor: { x: 200, y: 300 },
			camera,
			pane: PANE,
			size: SIZE,
		});
		const rect = changePillScreenRect(kept, camera, SIZE);
		expect(rect.left).toBe(8);
		expect(rect.right).toBe(258);
		// Back in board units: the screen's 258 is (258 - 20) / 0.5.
		expect(kept.x).toBe(476);
		expect(kept.y).toBe(300);
	});

	it("puts the left edge inside when the pane is narrower than the pill, and does nothing before the pane is measured", () => {
		const narrow = keepPillInPane({
			anchor: { x: 100, y: 200 },
			camera: CAMERA,
			pane: { width: 200, height: 600 },
			size: SIZE,
		});
		expect(changePillScreenRect(narrow, CAMERA, SIZE).left).toBe(8);
		const anchor = { x: 10, y: 10 };
		expect(
			keepPillInPane({
				anchor,
				camera: CAMERA,
				pane: { width: 0, height: 0 },
				size: SIZE,
			}),
		).toEqual(anchor);
	});
});
