import { describe, expect, it } from "vitest";
import {
	type BoundaryRect,
	clamp,
	computeTooltipBoundary,
	computeTooltipPlacement,
	resolveTooltipMaxWidth,
	SOURCE_TOOLTIP_OFFSET,
	type ViewportBounds,
} from "./tooltip-placement";

// Tier B4 (chat-experience-elevation §5) — pure geometry tests for the
// source-link tooltip placement extracted out of MarkdownRenderer.svelte. No
// DOM, no Svelte: the placement is asserted purely against rect inputs.
//
// `referencePlacement` / `referenceBoundary` below are a verbatim copy of the
// math that used to live inline in the component (magic numbers and all). Every
// module output is checked against them, which is what pins the extraction to
// "byte-identical" — if the module ever drifts from the original geometry, the
// reference comparison fails.

const OFFSET = SOURCE_TOOLTIP_OFFSET;

function refClamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

// Exact copy of the old inline `updateSourceLinkTooltipPosition` geometry.
function referencePlacement(
	linkRect: { left: number; top: number; bottom: number },
	tooltipRect: { width: number; height: number },
	boundary: BoundaryRect,
	coordinateOffset: { left: number; top: number },
) {
	const maxWidth = Math.min(352, Math.max(180, boundary.right - boundary.left));
	const tooltipWidth = Math.min(tooltipRect.width || maxWidth, maxWidth);
	const tooltipHeight = tooltipRect.height || 48;
	const left =
		refClamp(linkRect.left, boundary.left, boundary.right - tooltipWidth) -
		coordinateOffset.left;
	const spaceBelow = boundary.bottom - linkRect.bottom;
	const spaceAbove = linkRect.top - boundary.top;
	const placement =
		spaceBelow < tooltipHeight + OFFSET && spaceAbove > spaceBelow
			? "top"
			: "bottom";
	const idealTop =
		placement === "top"
			? linkRect.top - tooltipHeight - OFFSET
			: linkRect.bottom + OFFSET;
	const top =
		refClamp(idealTop, boundary.top, boundary.bottom - tooltipHeight) -
		coordinateOffset.top;
	return { left, top, maxWidth, placement };
}

// Exact copy of the old inline `getTooltipBoundary` geometry (DOM reads removed).
function referenceBoundary(
	viewport: ViewportBounds,
	chatRect: { left: number; right: number } | null,
	margin: number,
): BoundaryRect {
	const viewportBounds = {
		left: viewport.left + margin,
		right: viewport.left + viewport.width - margin,
		top: viewport.top + margin,
		bottom: viewport.top + viewport.height - margin,
	};
	if (!chatRect) return viewportBounds;
	const bounds = {
		left: Math.max(viewportBounds.left, chatRect.left + margin),
		right: Math.min(viewportBounds.right, chatRect.right - margin),
		top: viewportBounds.top,
		bottom: viewportBounds.bottom,
	};
	return bounds.right - bounds.left >= 180 ? bounds : viewportBounds;
}

describe("clamp", () => {
	it("returns the value when it is inside the range", () => {
		expect(clamp(50, 0, 100)).toBe(50);
	});

	it("clamps to the lower bound", () => {
		expect(clamp(-5, 0, 100)).toBe(0);
	});

	it("clamps to the upper bound", () => {
		expect(clamp(150, 0, 100)).toBe(100);
	});

	it("with an inverted range (max < min) resolves to max, matching the original", () => {
		// Math.min(Math.max(v, min), max): Math.max lifts to min, Math.min pins to
		// max. So an inverted range always yields max — the behaviour the tooltip
		// relies on when the tooltip is wider than the boundary.
		expect(clamp(500, 12, -18)).toBe(-18);
	});
});

describe("resolveTooltipMaxWidth", () => {
	it("returns the max cap when the boundary is very wide", () => {
		expect(resolveTooltipMaxWidth({ left: 12, right: 812 })).toBe(352);
	});

	it("returns the boundary inner width when it sits inside the band", () => {
		expect(resolveTooltipMaxWidth({ left: 12, right: 212 })).toBe(200);
	});

	it("returns the min floor when the boundary is narrower than the min", () => {
		expect(resolveTooltipMaxWidth({ left: 12, right: 112 })).toBe(180);
	});

	it("honours custom band bounds", () => {
		expect(resolveTooltipMaxWidth({ left: 0, right: 100 }, 20, 60)).toBe(60);
		expect(resolveTooltipMaxWidth({ left: 0, right: 40 }, 20, 60)).toBe(40);
		expect(resolveTooltipMaxWidth({ left: 0, right: 10 }, 20, 60)).toBe(20);
	});
});

describe("computeTooltipBoundary", () => {
	it("returns viewport bounds inset by the margin when there is no chat rect", () => {
		const viewport: ViewportBounds = {
			left: 0,
			top: 0,
			width: 1024,
			height: 768,
		};
		expect(computeTooltipBoundary(viewport, null, 12)).toEqual({
			left: 12,
			right: 1012,
			top: 12,
			bottom: 756,
		});
	});

	it("tightens the horizontal bounds to the chat column when it stays usable", () => {
		const viewport: ViewportBounds = {
			left: 0,
			top: 0,
			width: 1024,
			height: 768,
		};
		const chatRect = { left: 300, right: 724 };
		expect(computeTooltipBoundary(viewport, chatRect, 12)).toEqual({
			left: 312,
			right: 712,
			top: 12,
			bottom: 756,
		});
	});

	it("falls back to viewport bounds when constraining to the chat column would leave < 180px", () => {
		const viewport: ViewportBounds = {
			left: 0,
			top: 0,
			width: 1024,
			height: 768,
		};
		// 500..640 inner width after margins = (640-12) - (500+12) = 116 < 180.
		const chatRect = { left: 500, right: 640 };
		expect(computeTooltipBoundary(viewport, chatRect, 12)).toEqual({
			left: 12,
			right: 1012,
			top: 12,
			bottom: 756,
		});
	});

	it("honours a non-zero visual-viewport offset (pinch-zoom / on-screen keyboard)", () => {
		const viewport: ViewportBounds = {
			left: 40,
			top: 80,
			width: 600,
			height: 400,
		};
		expect(computeTooltipBoundary(viewport, null, 12)).toEqual({
			left: 52,
			right: 628,
			top: 92,
			bottom: 468,
		});
	});

	it("matches the original inline boundary math across a grid", () => {
		const viewports: ViewportBounds[] = [
			{ left: 0, top: 0, width: 1024, height: 768 },
			{ left: 40, top: 80, width: 600, height: 400 },
			{ left: 0, top: 0, width: 320, height: 640 },
		];
		const chatRects = [
			null,
			{ left: 300, right: 724 },
			{ left: 500, right: 640 },
			{ left: 100, right: 900 },
		];
		for (const viewport of viewports) {
			for (const chatRect of chatRects) {
				expect(computeTooltipBoundary(viewport, chatRect, 12)).toEqual(
					referenceBoundary(viewport, chatRect, 12),
				);
			}
		}
	});
});

describe("computeTooltipPlacement", () => {
	const boundary: BoundaryRect = { left: 12, right: 812, top: 12, bottom: 612 };
	const noOffset = { left: 0, top: 0 };

	it("places the tooltip below the link in the normal case", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 200, bottom: 216 },
			tooltipRect: { width: 300, height: 60 },
			boundary,
			coordinateOffset: noOffset,
		});
		expect(result).toEqual({
			left: 100,
			top: 222, // linkRect.bottom (216) + OFFSET (6)
			maxWidth: 352,
			placement: "bottom",
		});
	});

	it("flips above the link when there is not enough room below and more room above", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 590, bottom: 606 },
			tooltipRect: { width: 300, height: 60 },
			boundary,
			coordinateOffset: noOffset,
		});
		// spaceBelow = 612-606 = 6 < 66; spaceAbove = 590-12 = 578 > 6 -> flip top.
		expect(result.placement).toBe("top");
		expect(result.top).toBe(524); // 590 - 60 - 6
		expect(result.left).toBe(100);
	});

	it("stays below when room below is tight but room above is no larger", () => {
		const tightBoundary: BoundaryRect = {
			left: 12,
			right: 812,
			top: 12,
			bottom: 100,
		};
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 40, bottom: 60 },
			tooltipRect: { width: 300, height: 60 },
			boundary: tightBoundary,
			coordinateOffset: noOffset,
		});
		// spaceBelow = 100-60 = 40 < 66, but spaceAbove = 40-12 = 28 <= 40 -> bottom.
		expect(result.placement).toBe("bottom");
		// idealTop = 60 + 6 = 66, clamped to boundary.bottom - height = 100-60 = 40.
		expect(result.top).toBe(40);
	});

	it("clamps the top to the boundary top when the flipped tooltip would overflow above", () => {
		const tightBoundary: BoundaryRect = {
			left: 12,
			right: 812,
			top: 12,
			bottom: 100,
		};
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 60, bottom: 70 },
			tooltipRect: { width: 300, height: 60 },
			boundary: tightBoundary,
			coordinateOffset: noOffset,
		});
		// spaceBelow = 100-70 = 30 < 66; spaceAbove = 60-12 = 48 > 30 -> top.
		// idealTop = 60 - 60 - 6 = -6, clamped up to boundary.top = 12.
		expect(result.placement).toBe("top");
		expect(result.top).toBe(12);
	});

	it("clamps the left edge against the right boundary when the link is near the right", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 700, top: 200, bottom: 216 },
			tooltipRect: { width: 300, height: 60 },
			boundary,
			coordinateOffset: noOffset,
		});
		// max left = boundary.right (812) - tooltipWidth (300) = 512.
		expect(result.left).toBe(512);
	});

	it("clamps the left edge against the left boundary when the link is near the left", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: -50, top: 200, bottom: 216 },
			tooltipRect: { width: 300, height: 60 },
			boundary,
			coordinateOffset: noOffset,
		});
		expect(result.left).toBe(12); // clamped up to boundary.left
	});

	it("subtracts the offsetParent coordinate offset from both axes", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 200, bottom: 216 },
			tooltipRect: { width: 300, height: 60 },
			boundary,
			coordinateOffset: { left: 50, top: 30 },
		});
		expect(result.left).toBe(50); // 100 - 50
		expect(result.top).toBe(192); // 222 - 30
	});

	it("falls back to max width and the fallback height for an unmeasured tooltip", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 200, bottom: 216 },
			tooltipRect: { width: 0, height: 0 },
			boundary,
			coordinateOffset: noOffset,
		});
		// tooltipWidth = maxWidth = 352; tooltipHeight = 48.
		expect(result.maxWidth).toBe(352);
		expect(result.left).toBe(100); // clamp(100, 12, 812-352=460)
		expect(result.top).toBe(222); // bottom placement, clamp(222, 12, 612-48=564)
		expect(result.placement).toBe("bottom");
	});

	it("caps the tooltip width to the min band and produces the inverted-clamp left when the boundary is smaller than the tooltip", () => {
		const narrowBoundary: BoundaryRect = {
			left: 12,
			right: 162, // inner width 150 < min 180
			top: 12,
			bottom: 612,
		};
		const result = computeTooltipPlacement({
			linkRect: { left: 80, top: 200, bottom: 216 },
			tooltipRect: { width: 500, height: 60 },
			boundary: narrowBoundary,
			coordinateOffset: noOffset,
		});
		// maxWidth floors to 180; tooltipWidth = min(500,180)=180.
		expect(result.maxWidth).toBe(180);
		// boundary.right - tooltipWidth = 162 - 180 = -18; clamp(80, 12, -18) = -18.
		expect(result.left).toBe(-18);
	});

	it("uses a wide tooltip (width > link) without exceeding the resolved max width", () => {
		const result = computeTooltipPlacement({
			linkRect: { left: 100, top: 200, bottom: 216 },
			tooltipRect: { width: 500, height: 60 },
			boundary,
			coordinateOffset: noOffset,
		});
		// tooltipWidth = min(500, 352) = 352; max left = 812-352 = 460.
		expect(result.maxWidth).toBe(352);
		expect(result.left).toBe(100); // 100 within [12, 460]
	});

	it("matches the original inline placement math across a grid of inputs", () => {
		const boundaries: BoundaryRect[] = [
			{ left: 12, right: 812, top: 12, bottom: 612 },
			{ left: 12, right: 162, top: 12, bottom: 612 }, // narrower than tooltip
			{ left: 12, right: 812, top: 12, bottom: 100 }, // short
		];
		const linkRects = [
			{ left: -50, top: 5, bottom: 20 },
			{ left: 100, top: 200, bottom: 216 },
			{ left: 700, top: 300, bottom: 316 },
			{ left: 400, top: 590, bottom: 606 },
			{ left: 400, top: 60, bottom: 70 },
		];
		const tooltipRects = [
			{ width: 0, height: 0 },
			{ width: 300, height: 60 },
			{ width: 500, height: 120 },
		];
		const offsets = [
			{ left: 0, top: 0 },
			{ left: 50, top: 30 },
			{ left: -20, top: 15 },
		];
		for (const b of boundaries) {
			for (const linkRect of linkRects) {
				for (const tooltipRect of tooltipRects) {
					for (const coordinateOffset of offsets) {
						expect(
							computeTooltipPlacement({
								linkRect,
								tooltipRect,
								boundary: b,
								coordinateOffset,
							}),
						).toEqual(
							referencePlacement(linkRect, tooltipRect, b, coordinateOffset),
						);
					}
				}
			}
		}
	});
});
