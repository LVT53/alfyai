import { describe, expect, it } from "vitest";
import {
	computeFlyoutPlacement,
	computeMenuPlacement,
	FLYOUT_GAP,
	FLYOUT_MARGIN,
	MENU_GAP,
	MENU_MARGIN,
	MENU_WIDTH,
	type PlacementRect,
} from "./composer-placement";

function rect(
	left: number,
	top: number,
	width: number,
	height: number,
): PlacementRect {
	return {
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
	};
}

const DESKTOP = { width: 1440, height: 900 };
/** The window the owner reported the clipping on. */
const SHORT = { width: 1280, height: 720 };

describe("computeMenuPlacement", () => {
	it("hangs above the trigger when there is room up there", () => {
		const trigger = rect(120, 820, 34, 34);
		const placement = computeMenuPlacement(trigger, DESKTOP);

		expect(placement.placement).toBe("above");
		expect(placement.left).toBe(120);
		expect(placement.top).toBeNull();
		expect(placement.bottom).toBe(DESKTOP.height - trigger.top + MENU_GAP);
		expect(placement.maxHeight).toBe(trigger.top - MENU_MARGIN);
	});

	// The defect: a fixed `bottom: calc(100% + 8px)` with no measurement grew
	// the menu off the top of a short window. Whatever the arithmetic decides,
	// the box it describes has to be inside the viewport.
	it("keeps the menu inside a 1280x720 window with the composer at the bottom", () => {
		const trigger = rect(300, 656, 34, 34);
		const placement = computeMenuPlacement(trigger, SHORT);

		const bottomEdge = SHORT.height - (placement.bottom ?? 0);
		const topEdge = bottomEdge - placement.maxHeight;
		expect(topEdge).toBeGreaterThanOrEqual(0);
		expect(bottomEdge).toBeLessThanOrEqual(SHORT.height);
		expect(placement.maxHeight).toBeGreaterThan(0);
	});

	it("flips below the trigger when the space above is under 320px", () => {
		const trigger = rect(40, 180, 34, 34);
		const placement = computeMenuPlacement(trigger, DESKTOP);

		expect(placement.placement).toBe("below");
		expect(placement.bottom).toBeNull();
		expect(placement.top).toBe(trigger.bottom + MENU_GAP);
		expect(placement.maxHeight).toBe(
			DESKTOP.height - trigger.bottom - MENU_MARGIN,
		);
	});

	// Flipping is an improvement or it is not taken. In a window too short for
	// either direction, opening downward off the bottom is no better than
	// opening upward off the top — and upward is where the menu belongs.
	it("stays above when there is even less room below", () => {
		const placement = computeMenuPlacement(rect(40, 200, 34, 34), {
			width: 1280,
			height: 280,
		});

		expect(placement.placement).toBe("above");
		expect(placement.maxHeight).toBe(200 - MENU_MARGIN);
	});

	it("never reports a negative height in a window with no room at all", () => {
		const placement = computeMenuPlacement(rect(0, 4, 34, 34), {
			width: 1280,
			height: 10,
		});
		expect(placement.maxHeight).toBe(0);
	});

	it("pulls the menu back from the right edge rather than hanging it off", () => {
		const placement = computeMenuPlacement(rect(1380, 700, 34, 34), DESKTOP);
		expect(placement.left).toBe(DESKTOP.width - MENU_WIDTH - MENU_MARGIN);
	});

	it("keeps the left margin when the window is narrower than the menu", () => {
		const placement = computeMenuPlacement(rect(4, 400, 34, 34), {
			width: 240,
			height: 900,
		});
		expect(placement.left).toBe(MENU_MARGIN);
	});
});

describe("computeFlyoutPlacement", () => {
	// The menu as it sits on a desktop: 280px wide, hanging above a composer
	// on the left of a wide window.
	const menu = rect(120, 300, MENU_WIDTH, 520);

	it("opens to the right of the menu, aligned with the row that opened it", () => {
		const row = rect(130, 540, 260, 32);
		const flyout = computeFlyoutPlacement(row, menu, DESKTOP, {
			width: 300,
			height: 320,
		});

		expect(flyout.placement).toBe("right");
		expect(flyout.left).toBe(menu.right + FLYOUT_GAP);
		expect(flyout.top).toBe(row.top);
	});

	// The whole point of item 4: the flyout and the menu do not overlap.
	it("starts where the menu ends, so the boxes are disjoint", () => {
		const row = rect(130, 760, 260, 32);
		const flyout = computeFlyoutPlacement(row, menu, DESKTOP, { width: 300 });
		expect(flyout.left).toBeGreaterThanOrEqual(menu.right);
	});

	it("flips to the left of the menu when the right edge has no room", () => {
		const rightMenu = rect(1120, 300, MENU_WIDTH, 520);
		const row = rect(1130, 760, 260, 32);
		const flyout = computeFlyoutPlacement(row, rightMenu, DESKTOP, {
			width: 300,
			height: 320,
		});

		expect(flyout.placement).toBe("left");
		expect(flyout.left).toBe(rightMenu.left - FLYOUT_GAP - 300);
		expect(flyout.left + 300).toBeLessThanOrEqual(rightMenu.left);
	});

	it("caps the height at the viewport less its margins", () => {
		const flyout = computeFlyoutPlacement(
			rect(130, 760, 260, 32),
			menu,
			SHORT,
			{ width: 300 },
		);
		expect(flyout.maxHeight).toBe(SHORT.height - FLYOUT_MARGIN * 2);
	});

	// A Model row near the bottom of a 720px window would put a 400px list
	// 300px past the bottom edge if `top` simply followed the row.
	it("lifts the flyout off the bottom edge rather than following the row", () => {
		const row = rect(130, 640, 260, 32);
		const flyout = computeFlyoutPlacement(row, menu, SHORT, {
			width: 300,
			height: 400,
		});

		expect(flyout.top).toBe(SHORT.height - FLYOUT_MARGIN - 400);
		expect(flyout.top + 400).toBeLessThanOrEqual(SHORT.height);
	});

	it("keeps the top margin when the flyout is taller than the window", () => {
		const flyout = computeFlyoutPlacement(
			rect(130, 640, 260, 32),
			menu,
			SHORT,
			{
				width: 300,
				height: 5000,
			},
		);
		expect(flyout.top).toBe(FLYOUT_MARGIN);
	});
});
