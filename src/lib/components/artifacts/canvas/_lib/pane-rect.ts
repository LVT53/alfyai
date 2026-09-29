/**
 * Where the visible pane sits on the board, in board units: what a
 * pointer-capturing overlay must be sized from.
 *
 * The trap this exists for (measured on the prototype): an overlay sized
 * `inset: 0` inside `<ViewportPortal>` is as big as the NODES, not as big as
 * what is on screen. On a 163-block board fitted to view it covered 6 of 144
 * sample points, and the board silently stopped being drawable the moment the
 * camera zoomed out. Size every overlay that takes the pointer from the pane and
 * the camera instead.
 */

export type PaneSize = { width: number; height: number };
export type ViewportLike = { x: number; y: number; zoom: number };
export type PaneRect = {
	left: number;
	top: number;
	width: number;
	height: number;
};

const NOWHERE: PaneRect = { left: 0, top: 0, width: 0, height: 0 };

/**
 * The board-space rectangle the pane is showing, `margin` board units larger on
 * every side. The viewport element is `translate(x, y) scale(zoom)` from the
 * pane's top-left, so the visible rectangle is `[-pan / zoom, (-pan + pane) /
 * zoom]`. An all-zero rectangle before the pane has been measured (the caller
 * then falls back to something else: a 1x1 box in the middle of nowhere is
 * worse than none).
 */
export function visibleBoardRect(
	pane: PaneSize,
	viewport: ViewportLike,
	margin = 0,
): PaneRect {
	if (!(pane.width > 0) || !(pane.height > 0) || !(viewport.zoom > 0)) {
		return NOWHERE;
	}
	return {
		// `0 - x`, not `-x`: a camera at the origin is +0, never -0.
		left: (0 - viewport.x) / viewport.zoom - margin,
		top: (0 - viewport.y) / viewport.zoom - margin,
		width: pane.width / viewport.zoom + margin * 2,
		height: pane.height / viewport.zoom + margin * 2,
	};
}
