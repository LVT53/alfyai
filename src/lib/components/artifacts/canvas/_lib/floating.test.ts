import { describe, expect, it } from "vitest";
import {
	BOARD_TOOLBAR_CLEARANCE,
	PANE_EDGE_GAP,
	placeToolbar,
	type ScreenRect,
	TOOLBAR_OFFSET,
} from "./floating";

// Where the small toolbar of a selected block hangs (CV-B2): above the block, 12 px
// clear of it, centred, unless that would leave the pane, and then below it; and always
// inside the pane, a few pixels clear of its edge, with the board's own toolbar along
// the bottom kept clear.

const PANE = { width: 800, height: 600 };
/** A toolbar with four tones, Edit and Delete: wider than a File block's two buttons. */
const BAR = { width: 200, height: 38 };

const block = (left: number, top: number, width = 160, height = 100) =>
	({
		left,
		top,
		right: left + width,
		bottom: top + height,
	}) satisfies ScreenRect;

describe("placeToolbar: above the block when there is room", () => {
	it("hangs centred over the block, a gap clear of it", () => {
		const placed = placeToolbar(block(300, 200), PANE, BAR);
		expect(placed.side).toBe("above");
		expect(placed.rect).toEqual({
			left: 380 - 100,
			top: 200 - TOOLBAR_OFFSET - 38,
			right: 380 + 100,
			bottom: 200 - TOOLBAR_OFFSET,
		});
	});

	it("keeps above up to the last pixel that fits, and goes below one pixel after", () => {
		// The toolbar's top edge lands exactly the pane's edge gap inside the pane.
		const top = PANE_EDGE_GAP + 38 + TOOLBAR_OFFSET;
		expect(placeToolbar(block(300, top), PANE, BAR).side).toBe("above");
		expect(placeToolbar(block(300, top - 1), PANE, BAR).side).toBe("below");
	});
});

describe("placeToolbar: below the block when there is no room above", () => {
	it("hangs below a block 14 px from the top of the pane, the same gap clear of it", () => {
		const placed = placeToolbar(block(300, 14), PANE, BAR);
		expect(placed.side).toBe("below");
		expect(placed.rect.top).toBe(14 + 100 + TOOLBAR_OFFSET);
		expect(placed.rect.bottom).toBe(14 + 100 + TOOLBAR_OFFSET + 38);
		// Still centred under it.
		expect(placed.rect.left).toBe(380 - 100);
	});

	it("stays above the board's own toolbar along the bottom of the pane", () => {
		// A block whose bottom is so low that below would run under the board's toolbar,
		// and whose top is too high for above: neither fits, and it is held in the pane.
		const tall = block(300, 10, 160, PANE.height - 30);
		const placed = placeToolbar(tall, PANE, BAR);
		expect(placed.side).toBe("over");
		expect(placed.rect.bottom).toBeLessThanOrEqual(PANE.height - PANE_EDGE_GAP);
	});

	it("uses below only while it clears the board's toolbar", () => {
		const fits = block(
			300,
			20,
			160,
			PANE.height - BOARD_TOOLBAR_CLEARANCE - 20 - 12 - 38,
		);
		expect(placeToolbar(fits, PANE, BAR).side).toBe("below");
		const touches = block(300, 20, 160, fits.bottom - fits.top + 1);
		expect(placeToolbar(touches, PANE, BAR).side).toBe("over");
	});
});

describe("placeToolbar: inside the pane, sideways too", () => {
	it("slides in from the left edge of the pane", () => {
		// A narrow block at the pane's edge: centred, the toolbar would run from -20.
		const placed = placeToolbar(block(0, 200, 160), PANE, BAR);
		expect(placed.rect.left).toBe(PANE_EDGE_GAP);
		expect(placed.rect.right).toBe(PANE_EDGE_GAP + 200);
		expect(placed.side).toBe("above");
	});

	it("slides in from the right edge of the pane", () => {
		const placed = placeToolbar(block(PANE.width - 160, 200, 160), PANE, BAR);
		expect(placed.rect.right).toBe(PANE.width - PANE_EDGE_GAP);
		expect(placed.rect.left).toBe(PANE.width - PANE_EDGE_GAP - 200);
	});

	it("is not wider than the pane's left edge allows: the left edge wins on a pane narrower than the toolbar", () => {
		const placed = placeToolbar(
			block(0, 200, 160),
			{ width: 150, height: 600 },
			BAR,
		);
		expect(placed.rect.left).toBe(PANE_EDGE_GAP);
	});

	it("slides a block that is half out of the pane to where the toolbar can be pressed", () => {
		const placed = placeToolbar(block(-300, 200, 400), PANE, BAR);
		expect(placed.rect.left).toBeGreaterThanOrEqual(PANE_EDGE_GAP);
		expect(placed.rect.right).toBeLessThanOrEqual(PANE.width - PANE_EDGE_GAP);
	});
});

describe("placeToolbar: a block bigger than the pane", () => {
	it("is held at the top of the pane, over the block, when its top is out of view", () => {
		const frame = block(100, -400, 600, 2400);
		const placed = placeToolbar(frame, PANE, BAR);
		expect(placed.side).toBe("over");
		expect(placed.rect.top).toBe(PANE_EDGE_GAP);
		expect(placed.rect.bottom).toBe(PANE_EDGE_GAP + 38);
		expect(placed.rect.left).toBe(400 - 100);
	});

	it("is held in the pane for a block that is out of the pane altogether", () => {
		const placed = placeToolbar(block(100, 2000), PANE, BAR);
		expect(placed.rect.bottom).toBeLessThanOrEqual(PANE.height - PANE_EDGE_GAP);
		expect(placed.rect.top).toBeGreaterThanOrEqual(PANE_EDGE_GAP);
	});
});

describe("placeToolbar: off the other layers", () => {
	it("goes below when the change pill hangs where the toolbar would be above", () => {
		const pill: ScreenRect = { left: 280, top: 140, right: 560, bottom: 168 };
		const placed = placeToolbar(block(300, 200), PANE, BAR, pill);
		expect(placed.side).toBe("below");
	});

	it("stays above when the change pill is elsewhere", () => {
		const pill: ScreenRect = { left: 280, top: 320, right: 560, bottom: 348 };
		expect(placeToolbar(block(300, 200), PANE, BAR, pill).side).toBe("above");
	});

	it("stays above, inside the pane, when the pill is on both sides: a pill under the toolbar is better than a toolbar off the screen", () => {
		const both = placeToolbar(block(300, 200), PANE, BAR, {
			left: 0,
			top: 100,
			right: 800,
			bottom: 380,
		});
		expect(both.side).toBe("above");
		expect(both.rect.top).toBe(200 - TOOLBAR_OFFSET - 38);
	});
});

describe("placeToolbar: before the pane is measured", () => {
	it("hangs the toolbar where the library puts it: above, centred, no clamping", () => {
		const placed = placeToolbar(block(0, 5), { width: 0, height: 0 }, BAR);
		expect(placed.side).toBe("above");
		expect(placed.rect.left).toBe(80 - 100);
		expect(placed.rect.top).toBe(5 - TOOLBAR_OFFSET - 38);
	});
});
