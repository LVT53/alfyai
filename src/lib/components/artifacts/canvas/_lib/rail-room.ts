/**
 * Where the board slides when the comments column takes room from its pane (RC-A #7).
 * A board the reader has the camera of is not re-fitted for a narrower pane, so what
 * was on its right side ended under the column. The zoom is theirs and stays: the board
 * slides over by what is needed to keep in view what they were looking at, never by more
 * than the column took. Pure: the boxes are the blocks as the reader sees them, in pixels
 * from the pane's top left corner; the lazy comment layer reads them from the page.
 */

/** A rectangle in the pane's pixels, from its top left corner. */
export interface PaneBox {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** The room kept between the last block in view and the column. */
export const COLUMN_MARGIN = 24;
/** A column takes at least this much of the pane: a drawer over the board, or a sheet, takes none, and the board stays as it is. */
export const MIN_COLUMN_WIDTH = 120;

/**
 * How far to slide the board to the left, in pixels (a positive number, 0 when nothing
 * that was in view is now behind the column). `pane` is what is left of the pane
 * beside the column, and `taken` what the column took of it: the reader was looking at
 * the pane `taken` wider than this one.
 */
export function slideForColumn(
	boxes: readonly PaneBox[],
	pane: { width: number; height: number },
	taken: number,
	margin: number = COLUMN_MARGIN,
): number {
	const wasWidth = pane.width + taken;
	let right = Number.NEGATIVE_INFINITY;
	for (const box of boxes) {
		const inView =
			box.right > 0 &&
			box.left < wasWidth &&
			box.bottom > 0 &&
			box.top < pane.height;
		if (inView) right = Math.max(right, Math.min(box.right, wasWidth));
	}
	if (right === Number.NEGATIVE_INFINITY) return 0;
	return Math.round(
		Math.max(0, Math.min(taken, right - (pane.width - margin))),
	);
}
