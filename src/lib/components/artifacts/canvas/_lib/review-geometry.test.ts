import { describe, expect, it } from "vitest";
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import { boxOf, padded, rectsOf } from "./review-geometry";

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
