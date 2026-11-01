import { describe, expect, it } from "vitest";
import {
	type ImageMark,
	MAX_MARKS,
	MIN_MARK_SIDE,
} from "$lib/shared/artifacts/image-body";
import { boxFromDrag, hitMark, nextLetter } from "./mark-geometry";

const mark = (
	letter: ImageMark["letter"],
	x = 0.1,
	y = 0.1,
	w = 0.2,
	h = 0.2,
): ImageMark => ({ letter, x, y, w, h });

describe("boxFromDrag", () => {
	const frame = { width: 200, height: 100 };

	it("turns a drag into fractions of the picture's own rectangle", () => {
		expect(boxFromDrag({ x: 10, y: 10 }, { x: 110, y: 60 }, frame)).toEqual({
			x: 0.05,
			y: 0.1,
			w: 0.5,
			h: 0.5,
		});
	});

	it("reads a drag up and to the left the same way", () => {
		expect(boxFromDrag({ x: 110, y: 60 }, { x: 10, y: 10 }, frame)).toEqual({
			x: 0.05,
			y: 0.1,
			w: 0.5,
			h: 0.5,
		});
	});

	it("clamps a drag past the frame to its edges", () => {
		expect(boxFromDrag({ x: 100, y: 50 }, { x: 400, y: 300 }, frame)).toEqual({
			x: 0.5,
			y: 0.5,
			w: 0.5,
			h: 0.5,
		});
		expect(boxFromDrag({ x: -50, y: -20 }, { x: 40, y: 30 }, frame)).toEqual({
			x: 0,
			y: 0,
			w: 0.2,
			h: 0.3,
		});
	});

	it("gives no box for a 2 px drag, or one thinner than the smallest side", () => {
		expect(boxFromDrag({ x: 10, y: 10 }, { x: 12, y: 12 }, frame)).toBeNull();
		expect(boxFromDrag({ x: 10, y: 10 }, { x: 110, y: 11 }, frame)).toBeNull();
		expect(MIN_MARK_SIDE).toBe(0.02);
	});

	it("gives no box on a frame with no size", () => {
		expect(
			boxFromDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 0 }),
		).toBeNull();
	});
});

describe("nextLetter", () => {
	it("gives A first, then the first unused letter", () => {
		expect(nextLetter([])).toBe("A");
		expect(nextLetter([mark("A"), mark("C")])).toBe("B");
	});

	it("gives none once eight marks are drawn", () => {
		const eight = (["A", "B", "C", "D", "E", "F", "G", "H"] as const).map(
			(letter) => mark(letter),
		);
		expect(eight).toHaveLength(MAX_MARKS);
		expect(nextLetter(eight)).toBeNull();
	});
});

describe("hitMark", () => {
	it("gives the last-drawn box under the point", () => {
		const marks = [mark("A", 0, 0, 0.5, 0.5), mark("B", 0.25, 0.25, 0.5, 0.5)];
		expect(hitMark({ x: 0.3, y: 0.3 }, marks)).toBe("B");
		expect(hitMark({ x: 0.1, y: 0.1 }, marks)).toBe("A");
		expect(hitMark({ x: 0.9, y: 0.1 }, marks)).toBeNull();
	});
});
