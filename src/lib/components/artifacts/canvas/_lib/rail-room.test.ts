import { describe, expect, it } from "vitest";
import { type PaneBox, slideForColumn } from "./rail-room";

const box = (left: number, right: number, top = 40, bottom = 200): PaneBox => ({
	left,
	right,
	top,
	bottom,
});
const PANE = { width: 646, height: 730 };

describe("slideForColumn — a column took 300 px off the right of the pane", () => {
	it("slides the board over by what keeps the last block in view, with the margin to spare", () => {
		// The last block ended at 891 of the 946 px the reader had; 646 are left.
		expect(slideForColumn([box(40, 300), box(700, 891)], PANE, 300)).toBe(
			891 - (646 - 24),
		);
	});

	it("never slides by more than the column took", () => {
		// A frame that runs past the old edge: the view's own right edge is what counts.
		expect(slideForColumn([box(100, 2000)], PANE, 300)).toBe(300);
	});

	it("does not slide when everything that was in view still is", () => {
		expect(slideForColumn([box(40, 300), box(320, 600)], PANE, 300)).toBe(0);
	});

	it("keeps the margin: a block that now ends at the column's edge is slid clear of it", () => {
		expect(slideForColumn([box(400, 646)], PANE, 300)).toBe(24);
	});

	it("ignores what the reader could not see: past the old edge, above or below the pane", () => {
		expect(slideForColumn([box(960, 1200)], PANE, 300)).toBe(0);
		expect(slideForColumn([box(700, 891, 800, 900)], PANE, 300)).toBe(0);
		expect(slideForColumn([box(700, 891, -300, -10)], PANE, 300)).toBe(0);
	});

	it("is 0 for a board with no blocks", () => {
		expect(slideForColumn([], PANE, 300)).toBe(0);
	});

	it("counts a block that was only partly in view by the part that was", () => {
		// 800 to 1100: the reader saw it up to 946.
		expect(slideForColumn([box(800, 1100)], PANE, 300)).toBe(300);
		expect(slideForColumn([box(300, 700)], PANE, 300)).toBe(700 - (646 - 24));
	});
});
