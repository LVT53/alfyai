import { describe, expect, it } from "vitest";
import { lineBoxes } from "./line-rects";

const rect = (left: number, top: number, width: number, height: number) =>
	({
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		x: left,
		y: top,
		toJSON: () => ({}),
	}) as DOMRectReadOnly;

const origin = rect(100, 200, 600, 400);

describe("lineBoxes", () => {
	it("joins a line's word rects into one box", () => {
		const boxes = lineBoxes(
			[rect(110, 210, 40, 20), rect(155, 210, 30, 20), rect(190, 211, 50, 19)],
			origin,
		);
		expect(boxes).toEqual([{ left: 10, top: 10, width: 130, height: 20 }]);
	});

	it("keeps lines apart, and words apart beyond the join gap", () => {
		const boxes = lineBoxes(
			[
				rect(110, 210, 40, 20),
				rect(300, 210, 30, 20),
				rect(110, 235, 60, 20),
				rect(175, 236, 20, 18),
			],
			origin,
		);
		expect(boxes).toEqual([
			{ left: 10, top: 10, width: 40, height: 20 },
			{ left: 200, top: 10, width: 30, height: 20 },
			{ left: 10, top: 35, width: 85, height: 20 },
		]);
	});

	it("takes a smaller rect that overlaps half its height as the same line, and skips empty rects", () => {
		const boxes = lineBoxes(
			[rect(110, 210, 40, 20), rect(152, 216, 20, 10), rect(0, 0, 0, 0)],
			origin,
		);
		expect(boxes).toEqual([{ left: 10, top: 10, width: 62, height: 20 }]);
		expect(lineBoxes([], origin)).toEqual([]);
	});

	it("joins with a gap of its own choosing", () => {
		expect(
			lineBoxes([rect(110, 210, 40, 20), rect(170, 210, 30, 20)], origin, 30),
		).toHaveLength(1);
		expect(
			lineBoxes([rect(110, 210, 40, 20), rect(170, 210, 30, 20)], origin, 5),
		).toHaveLength(2);
	});
});
