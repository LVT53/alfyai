import { describe, expect, it } from "vitest";
import { selectionPillPlacement } from "./selection-pill-placement";

// Where the pill a selection raises sits: below the blocks, where the block's own
// small toolbar (above them) is not, and above that toolbar when there is no room
// below (the board's own toolbar runs along the bottom of the pane).

const PANE = { width: 800, height: 600 };
const CAMERA = { x: 0, y: 0, zoom: 1 };

describe("where the selection's pill sits", () => {
	it("is below a block that has room under it, centred", () => {
		const placement = selectionPillPlacement(
			{ x: 100, y: 100, width: 200, height: 100 },
			CAMERA,
			PANE,
		);
		expect(placement).toEqual({ side: "below", x: 200, y: 200 });
	});

	it("goes above the block's own toolbar when the board's toolbar would cover it", () => {
		const placement = selectionPillPlacement(
			{ x: 100, y: 470, width: 200, height: 100 },
			CAMERA,
			PANE,
		);
		expect(placement).toEqual({ side: "above", x: 200, y: 470 });
	});

	it("reads the box through the camera: pan and zoom move where the room is", () => {
		// The same block, zoomed and panned so its bottom is at 300 * 0.5 + 400 = 550 on screen.
		const placement = selectionPillPlacement(
			{ x: 100, y: 100, width: 200, height: 200 },
			{ x: 0, y: 400, zoom: 0.5 },
			PANE,
		);
		expect(placement.side).toBe("above");
	});

	it("does not know the pane before it is measured, and then stays below", () => {
		const placement = selectionPillPlacement(
			{ x: 0, y: 5000, width: 10, height: 10 },
			CAMERA,
			{ width: 0, height: 0 },
		);
		expect(placement.side).toBe("below");
	});
});
