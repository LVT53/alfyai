// Tier B4 (chat-experience-elevation §5) — the pure tooltip-placement geometry
// extracted out of MarkdownRenderer.svelte.
//
// The source-link hover tooltip's positioning is pure viewport/clamp/flip math:
// given the live anchor rect, the measured tooltip rect, and the resolved
// placement boundary (viewport ∩ chat bounds), decide where the tooltip sits
// (top/left in the element's coordinate space), which side it flips to, and how
// wide it may grow. None of that needs the DOM — the component measures the
// rects with getBoundingClientRect and threads them in; everything below is a
// plain rect-in / coords-out function, unit-testable without a browser.
//
// This mirrors the existing `reasoning-spine.ts` / `tool-evidence-presentation.ts`
// extractions: pure functions returning plain data, asserted directly rather
// than only reachable through the heavy component test. The math here is
// byte-identical to the old inline geometry — same clamps, same flip decision,
// same width resolution — so the tooltip lands in the exact same spot.

/** The tuning geometry the placement shares with its component glue. */
// Gap kept between the tooltip and the viewport/chat edges when resolving the
// boundary.
export const SOURCE_TOOLTIP_MARGIN = 12;
// Gap between the anchor and the tooltip, and the threshold that drives the
// top/bottom flip decision.
export const SOURCE_TOOLTIP_OFFSET = 6;
// The tooltip's clamped width band. The min doubles as the smallest boundary
// width worth constraining to the chat column (below it, fall back to viewport).
export const SOURCE_TOOLTIP_MIN_WIDTH = 180;
export const SOURCE_TOOLTIP_MAX_WIDTH = 352;
// Height assumed when the tooltip has not been measured yet (width/height 0).
export const SOURCE_TOOLTIP_FALLBACK_HEIGHT = 48;

/** Visible viewport bounds, as read from `window.visualViewport` / `window`. */
export interface ViewportBounds {
	left: number;
	top: number;
	width: number;
	height: number;
}

/** A resolved placement boundary (or any left/right/top/bottom box). */
export interface BoundaryRect {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** Inputs to `computeTooltipPlacement` — all plain, DOM-free rects/numbers. */
export interface TooltipPlacementInput {
	/** Live bounding rect of the source-link anchor (uses left/top/bottom). */
	linkRect: { left: number; top: number; bottom: number };
	/**
	 * Measured bounding rect of the tooltip element (uses width/height). A
	 * width/height of 0 (unmeasured) falls back to the max width / fallback
	 * height respectively — the exact `|| fallback` behaviour of the original.
	 */
	tooltipRect: { width: number; height: number };
	/** Resolved placement boundary (viewport ∩ chat bounds). */
	boundary: BoundaryRect;
	/**
	 * Offset of the tooltip's offsetParent. The tooltip is `position: fixed`, so
	 * its coords are viewport-relative; subtract this to convert into the
	 * offsetParent's coordinate space. Defaults to the origin.
	 */
	coordinateOffset?: { left: number; top: number };
	/** Gap between the anchor and the tooltip; also the flip threshold. */
	offset?: number;
	/** Lower bound of the tooltip's clamped width band. */
	minWidth?: number;
	/** Upper bound of the tooltip's clamped width band. */
	maxWidth?: number;
	/** Height assumed when the tooltip has not been measured yet. */
	fallbackHeight?: number;
}

/** The resolved tooltip position the component applies to the element. */
export interface TooltipPlacement {
	left: number;
	top: number;
	maxWidth: number;
	placement: "top" | "bottom";
}

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

/**
 * Resolve the tooltip's usable max-width: the boundary's inner width, clamped
 * into the `[minWidth, maxWidth]` band. Shared by the placement math and the
 * component's pre-measurement initial position so both agree on the width.
 */
export function resolveTooltipMaxWidth(
	boundary: Pick<BoundaryRect, "left" | "right">,
	minWidth: number = SOURCE_TOOLTIP_MIN_WIDTH,
	maxWidth: number = SOURCE_TOOLTIP_MAX_WIDTH,
): number {
	return Math.min(maxWidth, Math.max(minWidth, boundary.right - boundary.left));
}

/**
 * Resolve the placement boundary from the measured viewport and (optional) chat
 * column rect. The tooltip is first constrained to the viewport (inset by
 * `margin`); if the chat column is present and constraining to it still leaves
 * at least `SOURCE_TOOLTIP_MIN_WIDTH` of usable width, the horizontal bounds are
 * tightened to the chat column. Otherwise the viewport bounds win.
 *
 * The caller supplies the measured rects — no DOM access lives here.
 */
export function computeTooltipBoundary(
	viewport: ViewportBounds,
	chatRect: { left: number; right: number } | null,
	margin: number = SOURCE_TOOLTIP_MARGIN,
): BoundaryRect {
	const viewportBounds: BoundaryRect = {
		left: viewport.left + margin,
		right: viewport.left + viewport.width - margin,
		top: viewport.top + margin,
		bottom: viewport.top + viewport.height - margin,
	};

	if (!chatRect) {
		return viewportBounds;
	}

	const bounds: BoundaryRect = {
		left: Math.max(viewportBounds.left, chatRect.left + margin),
		right: Math.min(viewportBounds.right, chatRect.right - margin),
		top: viewportBounds.top,
		bottom: viewportBounds.bottom,
	};

	return bounds.right - bounds.left >= SOURCE_TOOLTIP_MIN_WIDTH
		? bounds
		: viewportBounds;
}

/**
 * The core placement decision: given the anchor rect, the measured tooltip rect,
 * and the resolved boundary, return the tooltip's resolved `{ left, top,
 * maxWidth, placement }`.
 *
 * - Width is clamped to the boundary's usable band; an unmeasured tooltip
 *   (width 0) is treated as its max width.
 * - `left` clamps the anchor's left edge so the tooltip stays inside the
 *   boundary, then converts into the offsetParent's coordinate space.
 * - The tooltip flips above the anchor only when there is not enough room below
 *   AND there is more room above than below; otherwise it sits below.
 * - `top` clamps the ideal top into the boundary and converts coordinate space.
 *
 * Byte-identical to the geometry previously inline in
 * MarkdownRenderer.svelte's `updateSourceLinkTooltipPosition`.
 */
export function computeTooltipPlacement(
	input: TooltipPlacementInput,
): TooltipPlacement {
	const {
		linkRect,
		tooltipRect,
		boundary,
		coordinateOffset = { left: 0, top: 0 },
		offset = SOURCE_TOOLTIP_OFFSET,
		minWidth = SOURCE_TOOLTIP_MIN_WIDTH,
		maxWidth = SOURCE_TOOLTIP_MAX_WIDTH,
		fallbackHeight = SOURCE_TOOLTIP_FALLBACK_HEIGHT,
	} = input;

	const resolvedMaxWidth = resolveTooltipMaxWidth(boundary, minWidth, maxWidth);
	const tooltipWidth = Math.min(
		tooltipRect.width || resolvedMaxWidth,
		resolvedMaxWidth,
	);
	const tooltipHeight = tooltipRect.height || fallbackHeight;

	const left =
		clamp(linkRect.left, boundary.left, boundary.right - tooltipWidth) -
		coordinateOffset.left;

	const spaceBelow = boundary.bottom - linkRect.bottom;
	const spaceAbove = linkRect.top - boundary.top;
	const placement: "top" | "bottom" =
		spaceBelow < tooltipHeight + offset && spaceAbove > spaceBelow
			? "top"
			: "bottom";

	const idealTop =
		placement === "top"
			? linkRect.top - tooltipHeight - offset
			: linkRect.bottom + offset;
	const top =
		clamp(idealTop, boundary.top, boundary.bottom - tooltipHeight) -
		coordinateOffset.top;

	return { left, top, maxWidth: resolvedMaxWidth, placement };
}
