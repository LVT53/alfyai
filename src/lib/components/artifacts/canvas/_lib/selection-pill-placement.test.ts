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

// RC-3 N3: the pill is as wide as its two buttons and was centred on its block, so
// a block near an edge of the pane put it half outside (the phone's 390 wide
// pane), and on a review it sat on the change pill's Keep and Undo, which hang from
// the block below. It stays inside the pane and off the change pill.
describe("where the selection's pill is kept in the pane", () => {
	const SIZE = { width: 240, height: 38 };

	it("slides in from the edge of the pane, a gap inside it, on both sides", () => {
		// A block at the far left: centred it would run from -20 to 220.
		const left = selectionPillPlacement(
			{ x: 0, y: 100, width: 100, height: 100 },
			CAMERA,
			PANE,
			{ size: SIZE },
		);
		expect(left).toEqual({ side: "below", x: 128, y: 200 });
		const right = selectionPillPlacement(
			{ x: 720, y: 100, width: 100, height: 100 },
			CAMERA,
			PANE,
			{ size: SIZE },
		);
		expect(right).toEqual({ side: "below", x: 672, y: 200 });
	});

	it("clamps on the screen through the camera, and answers in board units", () => {
		// Zoomed to 0.5 with the camera at x = 10: the block's centre at board 50 is at screen 35.
		const placement = selectionPillPlacement(
			{ x: 0, y: 100, width: 100, height: 100 },
			{ x: 10, y: 0, zoom: 0.5 },
			PANE,
			{ size: SIZE },
		);
		// The bar's centre is at 8 + 120 = 128 on screen: (128 - 10) / 0.5 in board units.
		expect(placement.x).toBe(236);
	});

	it("centres it in a pane too narrow to hold it", () => {
		const placement = selectionPillPlacement(
			{ x: 0, y: 100, width: 100, height: 100 },
			CAMERA,
			{ width: 200, height: 600 },
			{ size: SIZE },
		);
		expect(placement.x).toBe(100);
	});

	describe("off the change pill", () => {
		// The change pill hangs above the next block down: its rect is where the bar
		// would go, under the selected block.
		const pillRect = { left: 60, top: 206, right: 310, bottom: 234 };
		const block = { x: 100, y: 100, width: 200, height: 100 };

		it("goes to the other side of the block when it would sit on the change pill", () => {
			const placement = selectionPillPlacement(block, CAMERA, PANE, {
				size: SIZE,
				avoid: pillRect,
			});
			expect(placement).toEqual({ side: "above", x: 200, y: 100 });
		});

		it("does not move for a change pill that is somewhere else", () => {
			const placement = selectionPillPlacement(block, CAMERA, PANE, {
				size: SIZE,
				avoid: { left: 400, top: 20, right: 650, bottom: 48 },
			});
			expect(placement).toEqual({ side: "below", x: 200, y: 200 });
		});

		it("slides along the side when both sides of the block are taken", () => {
			// One pill below the block, one above it (its own toolbar's 60 and the bar's 38): a
			// single wide rectangle across both, from the left edge to x = 330.
			const wide = { left: 0, top: 0, right: 330, bottom: 240 };
			const placement = selectionPillPlacement(block, CAMERA, PANE, {
				size: SIZE,
				avoid: wide,
			});
			expect(placement.side).toBe("below");
			// Right of the rectangle, a gap beyond it: its left edge is at 330 + 6 + 8, its centre 120 more.
			const screenLeft = placement.x - SIZE.width / 2;
			expect(screenLeft).toBeGreaterThanOrEqual(330);
		});

		it("never answers a place outside the pane for a side that is cut off", () => {
			// A block at the top of the pane, with the change pill below it: above would be
			// off the top edge, so the bar slides beside the pill instead of going there.
			const top = { x: 100, y: 10, width: 200, height: 100 };
			const placement = selectionPillPlacement(top, CAMERA, PANE, {
				size: SIZE,
				avoid: { left: 60, top: 116, right: 310, bottom: 144 },
			});
			expect(placement.side).toBe("below");
			expect(placement.x - SIZE.width / 2).toBeGreaterThanOrEqual(310);
		});
	});
});
