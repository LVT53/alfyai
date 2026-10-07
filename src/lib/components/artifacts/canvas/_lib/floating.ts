/**
 * What the layers that float over the pane have in common (RC-3 N3): a rectangle
 * on the screen, in the pane's own pixels, and the room they leave at its edge.
 * Pure, with no imports, so the change pill's and the selection pill's geometry
 * (and the lazy entries they load with) can share it.
 */

/** A rectangle on the screen, in the pane's own pixels. */
export type ScreenRect = {
	left: number;
	top: number;
	right: number;
	bottom: number;
};

/** How far a floating layer stands inside the edge of the pane, on the screen. */
export const PANE_EDGE_GAP = 8;

/** How much of the pane's bottom edge the board's own toolbar and zoom control take. */
export const BOARD_TOOLBAR_CLEARANCE = 72;

/** How far a selected block's small toolbar hangs clear of it, on the screen (the library's own `offset`). */
export const TOOLBAR_OFFSET = 12;

/** How close one floating layer may come to another before they count as meeting. */
const AVOID_GAP = 6;

type Size = { width: number; height: number };

/** Where a block's toolbar hangs: `over` is held at the pane's edge, over a block that has no room beside it on either side. */
type ToolbarPlacement = {
	side: "above" | "below" | "over";
	rect: ScreenRect;
};

/**
 * Where the small toolbar of a selected block hangs, in the pane's own pixels
 * (CV-B2): above the block, centred and `TOOLBAR_OFFSET` clear of it, and below
 * it when the pane has no room above; always inside the pane, a gap clear of its
 * edge, clear of the board's own toolbar along the bottom and off `avoid` (the
 * change pill). A block with no room beside it on either side (taller than the
 * pane, its top out of view) holds it at the top of the pane, over the block; one
 * the pill covers on both sides keeps it above, in the pane. Before the pane is
 * measured it hangs where the library would have put it. Pure, so it is
 * unit-tested without a browser.
 */
export function placeToolbar(
	block: ScreenRect,
	pane: Size,
	size: Size,
	avoid: ScreenRect | null = null,
): ToolbarPlacement {
	const known = pane.width > 0 && pane.height > 0;
	let left = (block.left + block.right) / 2 - size.width / 2;
	if (known) {
		const most = Math.max(
			PANE_EDGE_GAP,
			pane.width - PANE_EDGE_GAP - size.width,
		);
		left = Math.min(Math.max(left, PANE_EDGE_GAP), most);
	}
	const at = (top: number): ScreenRect => ({
		left,
		top,
		right: left + size.width,
		bottom: top + size.height,
	});
	const above = at(block.top - TOOLBAR_OFFSET - size.height);
	if (!known) return { side: "above", rect: above };
	const free = (rect: ScreenRect, floor: number) =>
		rect.top >= PANE_EDGE_GAP &&
		rect.bottom <= floor &&
		(!avoid || !rectsMeet(rect, avoid, AVOID_GAP));
	if (free(above, pane.height - PANE_EDGE_GAP))
		return { side: "above", rect: above };
	const below = at(block.bottom + TOOLBAR_OFFSET);
	if (free(below, pane.height - BOARD_TOOLBAR_CLEARANCE)) {
		return { side: "below", rect: below };
	}
	const top = Math.min(
		Math.max(above.top, PANE_EDGE_GAP),
		Math.max(PANE_EDGE_GAP, pane.height - PANE_EDGE_GAP - size.height),
	);
	return { side: top === above.top ? "above" : "over", rect: at(top) };
}

/** Whether two rectangles come within `gap` of each other (touching with no gap is not meeting). */
export function rectsMeet(a: ScreenRect, b: ScreenRect, gap = 0): boolean {
	return (
		a.left < b.right + gap &&
		a.right > b.left - gap &&
		a.top < b.bottom + gap &&
		a.bottom > b.top - gap
	);
}

/**
 * An attachment that tells `onsize` how big an element is laid out, now and
 * whenever that changes. `offsetWidth` and `offsetHeight`, not a bounding box:
 * the floating layers are scaled by the camera's counter-zoom, and what is
 * wanted is the size they have on the screen, which is their own layout size.
 * Without a `ResizeObserver` (jsdom) it reads once.
 */
export function measuredBy(
	onsize: (size: { width: number; height: number }) => void,
): (element: HTMLElement) => undefined | (() => void) {
	return (element) => {
		const read = () =>
			onsize({ width: element.offsetWidth, height: element.offsetHeight });
		read();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(read);
		observer.observe(element);
		return () => observer.disconnect();
	};
}
