import { describe, expect, it } from "vitest";
import {
	type BubbleContainerGeometry,
	computeBubblePlacement,
	localizePoint,
} from "./bubble-placement";

function container(
	overrides: Partial<BubbleContainerGeometry> = {},
): BubbleContainerGeometry {
	return {
		hostRect: { left: 0, top: 0 },
		scrollLeft: 0,
		scrollTop: 0,
		clientWidth: 800,
		clientHeight: 600,
		...overrides,
	};
}

const BUBBLE = { width: 192, height: 92 };

describe("computeBubblePlacement", () => {
	it("centers the bubble above a selection with plenty of room on every side", () => {
		const result = computeBubblePlacement(
			{ top: 300, left: 380, right: 420, bottom: 320 },
			container(),
			BUBBLE,
		);
		expect(result).toEqual({ x: 400, y: 292, placement: "above" });
	});

	// The actual bug: `context.rect.top - hostRect.top` (the pre-fix formula)
	// never added the container's OWN scroll back in, so it produced the
	// IDENTICAL local point regardless of how far the container had scrolled
	// — this is the regression check that it now does not.
	it("shifts the placement by exactly the container's own scroll offset", () => {
		const anchor = { top: 300, left: 380, right: 420, bottom: 320 };
		const unscrolled = computeBubblePlacement(anchor, container(), BUBBLE);
		const scrolled = computeBubblePlacement(
			anchor,
			container({ scrollLeft: 50, scrollTop: 250 }),
			BUBBLE,
		);
		expect(unscrolled).not.toBeNull();
		expect(scrolled).not.toBeNull();
		expect(scrolled?.x).toBe((unscrolled?.x ?? 0) + 50);
		expect(scrolled?.y).toBe((unscrolled?.y ?? 0) + 250);
	});

	it("flips below the selection when there is not enough room above", () => {
		const result = computeBubblePlacement(
			{ top: 20, left: 100, right: 160, bottom: 40 },
			container(),
			BUBBLE,
		);
		expect(result?.placement).toBe("below");
		expect(result?.y).toBe(48); // localBottom (40) + the 8px selection gap.
	});

	it("clamps the bubble away from the container's left edge instead of letting it overhang", () => {
		const result = computeBubblePlacement(
			{ top: 300, left: 2, right: 10, bottom: 320 },
			container(),
			BUBBLE,
		);
		// Half the bubble's width plus the edge margin, never negative.
		expect(result?.x).toBe(104);
	});

	it("clamps the bubble away from the container's right edge instead of letting it overhang", () => {
		const result = computeBubblePlacement(
			{ top: 300, left: 790, right: 798, bottom: 320 },
			container(),
			BUBBLE,
		);
		expect(result?.x).toBe(696);
	});

	it("returns null when the selection has scrolled entirely out of the visible window", () => {
		const result = computeBubblePlacement(
			// Already-converted-to-local-space numbers land well above the
			// visible [500, 1100] window once scrollTop is added back in.
			{ top: -450, left: 10, right: 50, bottom: -430 },
			container({ scrollTop: 500 }),
			BUBBLE,
		);
		expect(result).toBeNull();
	});

	it("centers the bubble in the visible window rather than overhanging both edges when it cannot fit", () => {
		const result = computeBubblePlacement(
			{ top: 300, left: 40, right: 60, bottom: 320 },
			container({ clientWidth: 100 }),
			BUBBLE,
		);
		expect(result?.x).toBe(50);
	});

	// jsdom (component unit tests) never performs real layout, so
	// `clientWidth`/`clientHeight` are always 0 there — this must degrade to
	// the plain, unclamped point rather than hiding the bubble (`null`) or
	// throwing, so `DocumentBody.test.ts`'s selection-bubble coverage keeps
	// working unchanged.
	it("returns the plain unclamped point when the container reports no real layout (clientWidth/Height 0)", () => {
		const result = computeBubblePlacement(
			{ top: 10, left: 20, right: 40, bottom: 30 },
			container({ clientWidth: 0, clientHeight: 0 }),
			BUBBLE,
		);
		expect(result).toEqual({ x: 30, y: 10, placement: "above" });
	});
});

describe("localizePoint", () => {
	it("converts a viewport point into the container's own local coordinate space, scroll included", () => {
		expect(
			localizePoint(
				{ x: 150, y: 220 },
				{ hostRect: { left: 100, top: 200 }, scrollLeft: 30, scrollTop: 40 },
			),
		).toEqual({ x: 80, y: 60 });
	});

	it("is the identity when the container is unscrolled and has no offset", () => {
		expect(
			localizePoint(
				{ x: 12, y: 34 },
				{ hostRect: { left: 0, top: 0 }, scrollLeft: 0, scrollTop: 0 },
			),
		).toEqual({ x: 12, y: 34 });
	});
});
