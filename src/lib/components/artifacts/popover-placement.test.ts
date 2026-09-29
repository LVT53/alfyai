import { describe, expect, it } from "vitest";
import { type PlacementRect, placePopover } from "./popover-placement";

const VIEWPORT = { width: 1440, height: 900 };

/** The docked panel at 1440 wide: x 494..1440, full height. */
const PANEL: PlacementRect = { left: 494, top: 0, right: 1440, bottom: 900 };

function rect(left: number, top: number, width: number, height: number) {
	return { left, top, right: left + width, bottom: top + height };
}

describe("placePopover", () => {
	it("opens under its button, left edges aligned, when there is room", () => {
		const placement = placePopover({
			anchor: rect(632, 88, 44, 22),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
		});
		expect(placement).toMatchObject({
			side: "below",
			left: 632,
			top: 118,
			width: 340,
		});
		// The whole popover fits, so it is not squeezed.
		expect(placement.maxHeight).toBeGreaterThanOrEqual(300);
	});

	it("never leaves the panel: near the panel's right edge it shifts left, staying inside", () => {
		const placement = placePopover({
			anchor: rect(1300, 88, 44, 22),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
			margin: 12,
		});
		expect(placement.left + placement.width).toBeLessThanOrEqual(1440 - 12);
		expect(placement.left).toBeGreaterThanOrEqual(494 + 12);
	});

	it("never covers the chat column: an anchor at the panel's left edge does not pull the popover past it", () => {
		const placement = placePopover({
			anchor: rect(470, 88, 44, 22),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
			margin: 12,
		});
		expect(placement.left).toBe(494 + 12);
	});

	it("shrinks to fit a panel narrower than the popover", () => {
		const narrow: PlacementRect = {
			left: 1000,
			top: 0,
			right: 1300,
			bottom: 900,
		};
		const placement = placePopover({
			anchor: rect(1040, 88, 44, 22),
			boundary: narrow,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
			margin: 12,
		});
		expect(placement.width).toBe(300 - 24);
		expect(placement.left).toBe(1012);
	});

	it("also stays inside the window when the boundary is larger than it", () => {
		const oversized: PlacementRect = {
			left: 0,
			top: 0,
			right: 3000,
			bottom: 2000,
		};
		const placement = placePopover({
			anchor: rect(1420, 88, 44, 22),
			boundary: oversized,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
			margin: 12,
		});
		expect(placement.left + placement.width).toBeLessThanOrEqual(1440 - 12);
	});

	it("flips above its button when it does not fit below and there is more room above", () => {
		const placement = placePopover({
			anchor: rect(632, 780, 44, 22),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
			gap: 8,
			margin: 12,
		});
		expect(placement.side).toBe("above");
		// Pinned by its bottom edge: 8px above the button's top.
		expect(placement.bottom).toBe(900 - (780 - 8));
		expect(placement.top).toBeUndefined();
	});

	it("stays below and scrolls when it does not fit and there is no more room above", () => {
		const placement = placePopover({
			anchor: rect(632, 20, 44, 22),
			boundary: { left: 494, top: 0, right: 1440, bottom: 500 },
			viewport: VIEWPORT,
			contentHeight: 600,
			preferredWidth: 340,
			gap: 8,
			margin: 12,
		});
		expect(placement.side).toBe("below");
		// Room under the button, inside the panel: 500 - 12 - (42 + 8).
		expect(placement.maxHeight).toBe(438);
	});

	it("flips above when both sides are short but above has more room", () => {
		const placement = placePopover({
			anchor: rect(632, 300, 44, 22),
			boundary: { left: 494, top: 0, right: 1440, bottom: 500 },
			viewport: VIEWPORT,
			contentHeight: 600,
			preferredWidth: 340,
			gap: 8,
			margin: 12,
		});
		expect(placement.side).toBe("above");
		// Room above the button, inside the panel: (300 - 8) - 12.
		expect(placement.maxHeight).toBe(280);
	});

	it("caps its own height at maxHeight, so a long list scrolls inside the popover", () => {
		const placement = placePopover({
			anchor: rect(632, 88, 44, 22),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 2000,
			preferredWidth: 340,
			maxHeight: 420,
		});
		expect(placement.side).toBe("below");
		expect(placement.maxHeight).toBe(420);
	});

	it("keeps whole pixels", () => {
		const placement = placePopover({
			anchor: rect(632.4, 88.6, 44.2, 22.3),
			boundary: PANEL,
			viewport: VIEWPORT,
			contentHeight: 300,
			preferredWidth: 340,
		});
		expect(Number.isInteger(placement.left)).toBe(true);
		expect(Number.isInteger(placement.top)).toBe(true);
		expect(Number.isInteger(placement.maxHeight)).toBe(true);
	});
});
