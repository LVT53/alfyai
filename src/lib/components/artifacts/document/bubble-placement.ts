/**
 * The selection bubble's placement math (Feature 2 · Artifacts, Slice 1, T10
 * follow-up — "the overlay ... is always off screen, not by the cursor").
 * Pure and DOM-free on purpose, mirroring `comment-threads.ts`'s own split:
 * `DocumentBody.svelte` measures the live selection and the scroll container
 * (`contentEl.getBoundingClientRect()`, its `scrollLeft`/`scrollTop`/
 * `clientWidth`/`clientHeight`) and hands the numbers in; this module only
 * decides where the bubble ends up once it has them.
 *
 * Two independent bugs shared one root cause — `updateSelectionBubble` used
 * `context.rect.top - hostRect.top` (both VIEWPORT coordinates) directly as
 * the bubble's `position: absolute` `top`, inside a `position: relative`
 * container that SCROLLS:
 *
 *  1. That subtraction removes the container's own on-screen OFFSET but
 *     never adds back its `scrollTop`/`scrollLeft` — the container's own
 *     scroll shifts everything laid out inside it (including an absolutely
 *     positioned child measured in the SAME local space), so the container's
 *     scroll must be added back in. Skipping it put the bubble exactly
 *     `scrollTop` px too high after any scrolling — often thousands of
 *     pixels, and always growing with how far the user had scrolled.
 *  2. There was no "clamp into the visible area, flip below when there's no
 *     room above" logic at all, so a selection near the container's own
 *     visible top/left edge placed the bubble (anchored via
 *     `transform: translate(-50%, -100%)`, i.e. always ABOVE and CENTERED)
 *     above/beside the container's own clipped edge — invisible even at
 *     scrollTop 0, which is the common case for the very first selection in
 *     a session.
 *
 * `computeBubblePlacement` fixes both: it converts the anchor rect into the
 * container's own local coordinate space (undoing exactly what
 * `getBoundingClientRect` subtracted, scroll included), then clamps the
 * result to the container's CURRENTLY VISIBLE window and flips to "below"
 * when there is not enough room above. `localizePoint` is the same
 * viewport-to-local conversion without the clamp/flip, shared with the
 * inline Keep/Undo change-bar positions (`DocumentBody.svelte`'s
 * `maybeAskAlfy`/`landAlfyActivity`), which had the identical scroll-offset
 * bug for the identical reason.
 */

export interface BubbleAnchorRect {
	top: number;
	left: number;
	right: number;
	bottom: number;
}

export interface BubbleContainerGeometry {
	/** The scroll container's own on-screen rect (`Element.getBoundingClientRect()`). */
	hostRect: { left: number; top: number };
	scrollLeft: number;
	scrollTop: number;
	/**
	 * The container's own visible viewport size (`clientWidth`/`clientHeight`).
	 * Zero (jsdom's component-test environment, which never performs real
	 * layout — see `document-editor.ts`'s own `coordsAtPos` fallback) disables
	 * clamping/hiding entirely: the plain, unclamped local point is returned
	 * instead, exactly what this function's predecessor always computed, so
	 * component tests that never see a real viewport keep passing unchanged.
	 */
	clientWidth: number;
	clientHeight: number;
}

export interface BubbleSize {
	width: number;
	height: number;
}

export interface BubblePlacement {
	x: number;
	y: number;
	/** Which side of the selection the bubble sits on — `SelectionBubble.svelte` flips its own anchor transform accordingly. */
	placement: "above" | "below";
}

/**
 * `.selection-bubble`'s own `min-width: 12rem` and its default (non-
 * composing, two-action-row) rendered height. Not exported: `DocumentBody.svelte`
 * always places the bubble against `COMPOSER_BUBBLE_SIZE` below instead (the
 * grown composer's footprint, so growing in place never needs a re-flip) —
 * this stays the internal default for any caller that omits `bubbleSize`.
 */
const DEFAULT_BUBBLE_SIZE: BubbleSize = { width: 192, height: 92 };

/**
 * The grown composer's own footprint (redesign §4.2 item 2: "the pill grows
 * into a 340 px composer"; §9.2's `SelectionBubble.svelte` row: "composer-
 * height-aware flip"). `DocumentBody.svelte`'s `updateSelectionBubble` always
 * places the bubble against THIS size, never the smaller resting pill's —
 * the pill only ever grows in place (motion #8), so a placement computed for
 * the small pill could leave no room once it grows, forcing a visible jump.
 * Sizing for the composer's TALLEST realistic content (Ask mode: header,
 * textarea, a wrapped suggestion-chip row, the effect line, the action row)
 * keeps this a safe, if occasionally conservative, upper bound.
 */
export const COMPOSER_BUBBLE_SIZE: BubbleSize = { width: 340, height: 320 };

/** Breathing room kept between the bubble and the selection, and between the bubble and the container's own visible edge. */
const SELECTION_GAP_PX = 8;
const EDGE_MARGIN_PX = 8;

function clamp(value: number, min: number, max: number): number {
	if (min > max) return (min + max) / 2;
	return Math.min(Math.max(value, min), max);
}

/**
 * Converts a viewport point into the scroll container's own local coordinate
 * space — the one `position: absolute` measures from for a child of a
 * `position: relative` container. Shared by the change-mark bars, which need
 * the raw local point but never clamp or flip.
 */
export function localizePoint(
	point: { x: number; y: number },
	container: Pick<
		BubbleContainerGeometry,
		"hostRect" | "scrollLeft" | "scrollTop"
	>,
): { x: number; y: number } {
	return {
		x: point.x - container.hostRect.left + container.scrollLeft,
		y: point.y - container.hostRect.top + container.scrollTop,
	};
}

/**
 * The selection bubble's own placement: `localizePoint`'s conversion for
 * the anchor rect's center-top/bottom, then clamped into the container's
 * currently visible window and flipped below the selection when there is
 * not enough room above. Returns `null` when the anchor has no overlap at
 * all with the container's visible window (scrolled fully out of view) —
 * the caller should hide the bubble rather than pin it to nothing visible.
 */
export function computeBubblePlacement(
	anchor: BubbleAnchorRect,
	container: BubbleContainerGeometry,
	bubbleSize: BubbleSize = DEFAULT_BUBBLE_SIZE,
): BubblePlacement | null {
	const { hostRect, scrollLeft, scrollTop, clientWidth, clientHeight } =
		container;

	const localLeft = anchor.left - hostRect.left + scrollLeft;
	const localRight = anchor.right - hostRect.left + scrollLeft;
	const localTop = anchor.top - hostRect.top + scrollTop;
	const localBottom = anchor.bottom - hostRect.top + scrollTop;
	const anchorX = (localLeft + localRight) / 2;

	if (clientWidth <= 0 || clientHeight <= 0) {
		return { x: anchorX, y: localTop, placement: "above" };
	}

	const visibleLeft = scrollLeft;
	const visibleRight = scrollLeft + clientWidth;
	const visibleTop = scrollTop;
	const visibleBottom = scrollTop + clientHeight;

	const outOfView =
		localBottom < visibleTop ||
		localTop > visibleBottom ||
		localRight < visibleLeft ||
		localLeft > visibleRight;
	if (outOfView) return null;

	const x = clamp(
		anchorX,
		visibleLeft + EDGE_MARGIN_PX + bubbleSize.width / 2,
		visibleRight - EDGE_MARGIN_PX - bubbleSize.width / 2,
	);

	const spaceAbove = localTop - visibleTop;
	const placement: "above" | "below" =
		spaceAbove >= bubbleSize.height + SELECTION_GAP_PX ? "above" : "below";

	const y =
		placement === "above"
			? clamp(
					localTop - SELECTION_GAP_PX,
					visibleTop + bubbleSize.height,
					visibleBottom,
				)
			: clamp(
					localBottom + SELECTION_GAP_PX,
					visibleTop,
					visibleBottom - bubbleSize.height,
				);

	return { x, y, placement };
}
