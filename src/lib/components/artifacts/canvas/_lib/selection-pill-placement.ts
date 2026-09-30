/**
 * Where the pill a selection raises sits (Feature 2 · Artifacts, Slice 3): below
 * the selected blocks, centred, because their own small toolbar (Delete and the
 * block's controls) is above them; and above that toolbar when there is no room
 * below, the board's own toolbar running along the bottom of the pane. Pure and
 * in board space, like the geometry it reads, so it is unit-tested without a
 * browser.
 */
import type { Box } from "./review-geometry";

/** How far the bottom of the pane is taken by the board's toolbar and the zoom control. */
export const BOARD_TOOLBAR_CLEARANCE = 72;
/** The pill's own height, on screen. */
export const SELECTION_PILL_HEIGHT = 38;
/** The gap between a block and the pill, on screen. */
const GAP = 14;

export type SelectionPillPlacement = {
	side: "below" | "above";
	/** The point the pill hangs from, in board space: its centre line, and the edge of the box it is on. */
	x: number;
	y: number;
};

export function selectionPillPlacement(
	box: Box,
	camera: { x: number; y: number; zoom: number },
	pane: { width: number; height: number },
): SelectionPillPlacement {
	const x = box.x + box.width / 2;
	const screenBottom = (box.y + box.height) * camera.zoom + camera.y;
	const needed = screenBottom + GAP + SELECTION_PILL_HEIGHT;
	const noRoom =
		pane.height > 0 && needed > pane.height - BOARD_TOOLBAR_CLEARANCE;
	return noRoom
		? { side: "above", x, y: box.y }
		: { side: "below", x, y: box.y + box.height };
}
