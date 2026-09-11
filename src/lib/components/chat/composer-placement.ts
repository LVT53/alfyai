/**
 * Where the composer's "+" menu and its sub-pickers land on a desktop.
 *
 * Both of these used to be CSS offsets — `bottom: calc(100% + 8px)` for the
 * menu, `bottom: 100%` for the pickers inside it — which is the same bug
 * twice: an offset cannot see the viewport, so a menu opened from a composer
 * at the bottom of a 720px window grew straight off the top of the screen,
 * and a picker opened from a row inside that menu grew straight over the
 * rows above it.
 *
 * Positioning that has to measure belongs in a function that takes the
 * measurements and returns numbers, so the arithmetic can be stated once and
 * tested without a browser. The components do the two things only a browser
 * can do — read the rects, write the style — and nothing else.
 */

/** The parts of a `DOMRect` this module reads. */
export interface PlacementRect {
	top: number;
	left: number;
	right: number;
	bottom: number;
	width: number;
	height: number;
}

export interface PlacementViewport {
	width: number;
	height: number;
}

/** Gap between a surface and the thing it hangs off. */
export const MENU_GAP = 8;
/** How close a surface may come to the edge of the screen. */
export const MENU_MARGIN = 16;
/**
 * Below this much room above the trigger, the menu opens downward instead.
 *
 * Not "whatever fits": a menu that technically fits in 120px is a scrollbar
 * with rows in it. 320px is roughly the point where the menu shows its
 * sections rather than a sliver of the first one.
 */
export const MENU_MIN_SPACE_ABOVE = 320;
/** The desktop menu's width — `min(17.5rem, …)` in the component's CSS. */
export const MENU_WIDTH = 280;

export interface MenuPlacement {
	left: number;
	/** Set when the menu hangs above the trigger; `null` when it drops below. */
	bottom: number | null;
	/** Set when the menu drops below the trigger; `null` when it hangs above. */
	top: number | null;
	maxHeight: number;
	placement: "above" | "below";
}

function clamp(value: number, min: number, max: number): number {
	if (max < min) return min;
	return Math.min(Math.max(value, min), max);
}

/**
 * The "+" menu, measured against the viewport rather than its trigger alone.
 *
 * It hangs above the trigger — that is where the composer is and where the
 * menu has always opened — but it is capped at the room that is actually up
 * there, and it flips below when there is so little room above that the cap
 * would leave a sliver. The flip is only taken when downward is genuinely
 * roomier: in a window too short for either direction, opening downward off
 * the bottom is not an improvement on opening upward off the top.
 */
export function computeMenuPlacement(
	triggerRect: PlacementRect,
	viewport: PlacementViewport,
	width: number = MENU_WIDTH,
): MenuPlacement {
	const spaceAbove = triggerRect.top;
	const spaceBelow = viewport.height - triggerRect.bottom;

	const left = clamp(
		triggerRect.left,
		MENU_MARGIN,
		viewport.width - width - MENU_MARGIN,
	);

	const flip = spaceAbove < MENU_MIN_SPACE_ABOVE && spaceBelow > spaceAbove;

	if (flip) {
		return {
			left,
			top: triggerRect.bottom + MENU_GAP,
			bottom: null,
			maxHeight: Math.max(0, spaceBelow - MENU_MARGIN),
			placement: "below",
		};
	}

	return {
		left,
		top: null,
		bottom: viewport.height - triggerRect.top + MENU_GAP,
		maxHeight: Math.max(0, spaceAbove - MENU_MARGIN),
		placement: "above",
	};
}

/** Gap between the menu and a flyout hanging off its side. */
export const FLYOUT_GAP = 8;
/** How close a flyout may come to the edge of the screen. */
export const FLYOUT_MARGIN = 12;

export interface FlyoutPlacement {
	left: number;
	top: number;
	maxHeight: number;
	placement: "right" | "left";
}

/**
 * A picker opened from a row of the menu, as a flyout beside it.
 *
 * The old behaviour was "upward from the row", which put the model list on
 * top of the Atlas row it was opened underneath — the menu covering its own
 * contents. Beside the menu nothing overlaps: the flyout's left edge starts
 * where the menu's right edge ends, and it flips to the menu's left when the
 * window has no room on the right.
 *
 * `rowRect` is the row the picker belongs to, so the flyout's top lines up
 * with the thing that opened it rather than with the top of the menu.
 */
export function computeFlyoutPlacement(
	rowRect: PlacementRect,
	menuRect: PlacementRect,
	viewport: PlacementViewport,
	size: { width: number; height?: number },
): FlyoutPlacement {
	const roomRight =
		viewport.width - menuRect.right - FLYOUT_GAP - FLYOUT_MARGIN;
	const roomLeft = menuRect.left - FLYOUT_GAP - FLYOUT_MARGIN;
	const placement: "right" | "left" =
		roomRight >= size.width || roomRight >= roomLeft ? "right" : "left";

	const rawLeft =
		placement === "right"
			? menuRect.right + FLYOUT_GAP
			: menuRect.left - FLYOUT_GAP - size.width;
	const left = clamp(
		rawLeft,
		FLYOUT_MARGIN,
		viewport.width - size.width - FLYOUT_MARGIN,
	);

	const maxHeight = Math.max(0, viewport.height - FLYOUT_MARGIN * 2);
	const height = Math.min(size.height ?? maxHeight, maxHeight);
	const top = clamp(
		rowRect.top,
		FLYOUT_MARGIN,
		viewport.height - FLYOUT_MARGIN - height,
	);

	return { left, top, maxHeight, placement };
}
