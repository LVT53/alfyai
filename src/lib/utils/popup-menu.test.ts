import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { updateMenuPosition } from "./popup-menu";

// jsdom has no layout, so the trigger's box is given by hand. The viewport is
// 1000 by 800 for every test below.
function triggerAt(box: { top: number; right: number }): HTMLElement {
	const trigger = document.createElement("button");
	vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
		x: box.right - 28,
		y: box.top,
		top: box.top,
		right: box.right,
		bottom: box.top + 28,
		left: box.right - 28,
		width: 28,
		height: 28,
		toJSON: () => ({}),
	} as DOMRect);
	return trigger;
}

function styleOf(
	trigger: HTMLElement | null,
	...rest: [number?, number?, ("below" | "above")?]
): string | undefined {
	let style: string | undefined;
	updateMenuPosition(trigger, (next) => (style = next), ...rest);
	return style;
}

describe("updateMenuPosition", () => {
	const original = {
		width: Object.getOwnPropertyDescriptor(window, "innerWidth"),
		height: Object.getOwnPropertyDescriptor(window, "innerHeight"),
	};

	beforeEach(() => {
		Object.defineProperty(window, "innerWidth", {
			configurable: true,
			value: 1000,
		});
		Object.defineProperty(window, "innerHeight", {
			configurable: true,
			value: 800,
		});
	});

	afterEach(() => {
		if (original.width)
			Object.defineProperty(window, "innerWidth", original.width);
		if (original.height)
			Object.defineProperty(window, "innerHeight", original.height);
		vi.restoreAllMocks();
	});

	it("says nothing without a trigger", () => {
		expect(styleOf(null)).toBeUndefined();
	});

	describe("below the trigger (the default)", () => {
		it("hangs the menu under the trigger, its right edge on the trigger's", () => {
			expect(styleOf(triggerAt({ top: 100, right: 500 }), 190, 8)).toBe(
				"position: fixed; top: 136px; left: 310px; width: 190px;",
			);
		});

		it("does the same when the placement is named", () => {
			expect(
				styleOf(triggerAt({ top: 100, right: 500 }), 190, 8, "below"),
			).toBe("position: fixed; top: 136px; left: 310px; width: 190px;");
		});

		it("keeps the menu inside the viewport on both sides", () => {
			expect(styleOf(triggerAt({ top: 100, right: 60 }), 190, 8)).toContain(
				"left: 12px;",
			);
			expect(styleOf(triggerAt({ top: 100, right: 990 }), 190, 8)).toContain(
				"left: 798px;",
			);
		});

		it("never starts below the bottom of the viewport", () => {
			expect(styleOf(triggerAt({ top: 790, right: 500 }), 190, 8)).toContain(
				"top: 788px;",
			);
		});
	});

	describe("above the trigger", () => {
		it("anchors the menu by its bottom edge, a gap above the trigger", () => {
			// The trigger's top edge is y = 700: the menu's bottom edge is 8px above it,
			// which is 800 - 700 + 8 from the bottom of the viewport.
			expect(
				styleOf(triggerAt({ top: 700, right: 500 }), 200, 8, "above"),
			).toBe(
				"position: fixed; bottom: 108px; left: 300px; width: 200px; max-height: 680px;",
			);
		});

		it("sets no top, so a short menu hugs the trigger and a long one grows upwards", () => {
			expect(
				styleOf(triggerAt({ top: 700, right: 500 }), 200, 8, "above"),
			).not.toMatch(/(^|[ ;])top:/);
		});

		it("lets the menu scroll inside the room above the trigger", () => {
			// 400 above the trigger, less the gap and the viewport's own margin of 12.
			expect(
				styleOf(triggerAt({ top: 400, right: 500 }), 200, 8, "above"),
			).toContain("max-height: 380px;");
		});

		it("leaves a menu a usable height when the trigger is near the top", () => {
			expect(
				styleOf(triggerAt({ top: 40, right: 500 }), 200, 8, "above"),
			).toContain("max-height: 96px;");
		});

		it("keeps the menu inside the viewport on both sides", () => {
			expect(
				styleOf(triggerAt({ top: 700, right: 60 }), 200, 8, "above"),
			).toContain("left: 12px;");
			expect(
				styleOf(triggerAt({ top: 700, right: 990 }), 200, 8, "above"),
			).toContain("left: 788px;");
		});
	});
});
