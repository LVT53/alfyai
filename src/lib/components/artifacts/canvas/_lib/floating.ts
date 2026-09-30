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
