import { describe, expect, it } from "vitest";
import { visibleBoardRect } from "./pane-rect";

describe("visibleBoardRect", () => {
	it("returns the board rectangle the pane is showing, for a panned and zoomed camera", () => {
		// translate(-200, -100) scale(2): the pane's 800 x 600 shows board x 100..500, y 50..350.
		expect(
			visibleBoardRect(
				{ width: 800, height: 600 },
				{ x: -200, y: -100, zoom: 2 },
			),
		).toEqual({ left: 100, top: 50, width: 400, height: 300 });
	});

	it("shows more of the board the further the camera is zoomed out", () => {
		const rect = visibleBoardRect(
			{ width: 800, height: 600 },
			{ x: 0, y: 0, zoom: 0.25 },
		);
		expect(rect).toEqual({ left: 0, top: 0, width: 3200, height: 2400 });
	});

	it("returns an all-zero rectangle before the pane has been measured, or for a camera that makes no sense", () => {
		const zero = { left: 0, top: 0, width: 0, height: 0 };
		expect(
			visibleBoardRect({ width: 0, height: 0 }, { x: 5, y: 5, zoom: 1 }),
		).toEqual(zero);
		expect(
			visibleBoardRect({ width: 800, height: 600 }, { x: 0, y: 0, zoom: 0 }),
		).toEqual(zero);
	});

	it("inflates by the margin in board units, not screen units", () => {
		// At zoom 2 a margin of 10 board units is 20 screen pixels, on every side.
		const plain = visibleBoardRect(
			{ width: 800, height: 600 },
			{ x: -200, y: -100, zoom: 2 },
		);
		const inflated = visibleBoardRect(
			{ width: 800, height: 600 },
			{ x: -200, y: -100, zoom: 2 },
			10,
		);
		expect(inflated).toEqual({
			left: plain.left - 10,
			top: plain.top - 10,
			width: plain.width + 20,
			height: plain.height + 20,
		});
	});
});
