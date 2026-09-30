/**
 * Where Alfy's change is on the board, in board space, and nothing that draws:
 * the rectangle of each block it touched, the one that holds them all (the dashed
 * arranging frame goes around it, and the change pill hangs from its top-right
 * corner unless that corner would put the pill on a block Alfy left alone), and
 * how far a frame stands off what it surrounds. Pure, so it is unit-tested without
 * a browser; the layer only draws what it says.
 */
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { nodeRect } from "./board";
import {
	BOARD_TOOLBAR_CLEARANCE,
	PANE_EDGE_GAP,
	type ScreenRect,
} from "./floating";

export type Box = { x: number; y: number; width: number; height: number };

/** The rectangle of each of these blocks that is on the board, in the order they are named. */
export function rectsOf(
	ids: readonly string[],
	nodes: readonly CanvasNode[],
): { id: string; box: Box }[] {
	const rects: { id: string; box: Box }[] = [];
	for (const id of ids) {
		const node = nodes.find((candidate) => candidate.id === id);
		if (node) rects.push({ id, box: nodeRect(node, nodes, node.measured) });
	}
	return rects;
}

/** The one rectangle that holds all of these blocks, or null when none is on the board. */
export function boxOf(
	ids: readonly string[],
	nodes: readonly CanvasNode[],
): Box | null {
	const rects = rectsOf(ids, nodes);
	if (rects.length === 0) return null;
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const { box } of rects) {
		left = Math.min(left, box.x);
		top = Math.min(top, box.y);
		right = Math.max(right, box.x + box.width);
		bottom = Math.max(bottom, box.y + box.height);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

export function padded(box: Box, by: number): Box {
	return {
		x: box.x - by,
		y: box.y - by,
		width: box.width + by * 2,
		height: box.height + by * 2,
	};
}

/** The change pill's size on the screen (its widest, with Keep and Undo), and how far above its corner it hangs. The layer scales it by 1 / zoom, so it is this size at any zoom. */
const PILL_WIDTH = 280;
const PILL_HEIGHT = 28;
const PILL_LIFT = 16;

function overlapArea(a: Box, b: Box): number {
	const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The point the change pill hangs from: its right edge, and the edge of the block
 * above which it sits. It is the top-right corner of the box that holds every
 * touched block (the place a reader looks for it) unless that would put the pill
 * over blocks Alfy left alone (`obstacles`: every block but a frame, which is a
 * backdrop); then the top-right corner of a touched block with the least under it,
 * the highest first (RV-3 Minor 2). Null when nothing is touched.
 */
export function changePillAnchor(input: {
	touched: readonly Box[];
	obstacles: readonly Box[];
	zoom: number;
}): Pt | null {
	if (input.touched.length === 0) return null;
	const inv = input.zoom > 0 ? 1 / input.zoom : 1;
	const width = PILL_WIDTH * inv;
	const height = PILL_HEIGHT * inv;
	const lift = PILL_LIFT * inv;
	const corners = input.touched
		.map((box) => ({ x: box.x + box.width, y: box.y }))
		.sort((a, b) => a.y - b.y || b.x - a.x);
	const union = {
		x: Math.max(...corners.map((corner) => corner.x)),
		y: Math.min(...corners.map((corner) => corner.y)),
	};
	const under = (corner: Pt): number => {
		const pill = {
			x: corner.x - width,
			y: corner.y - lift - height,
			width,
			height,
		};
		return input.obstacles.reduce(
			(total, box) => total + overlapArea(pill, box),
			0,
		);
	};
	let best = union;
	let bestUnder = under(union);
	for (const corner of corners) {
		if (bestUnder === 0) break;
		const area = under(corner);
		if (area < bestUnder) {
			best = corner;
			bestUnder = area;
		}
	}
	return best;
}

type Camera = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };

/** Where the change pill is on the screen, in the pane's pixels, when it hangs from `anchor`: its right edge at the anchor, 16 above it. */
export function changePillScreenRect(
	anchor: Pt,
	camera: Camera,
	size: Size = { width: PILL_WIDTH, height: PILL_HEIGHT },
): ScreenRect {
	const right = anchor.x * camera.zoom + camera.x;
	const bottom = anchor.y * camera.zoom + camera.y - PILL_LIFT;
	return { left: right - size.width, top: bottom - size.height, right, bottom };
}

/**
 * The change pill's anchor moved along the screen until the pill is inside the
 * pane (RC-3 N3): it hangs to the LEFT of its corner and above it, so a block
 * near the left edge put it half outside, and one near the top put it over the
 * pane's header. A gap inside the edge, and above the board's own toolbar along
 * the bottom; the left edge wins when the pane is narrower than the pill. The
 * arithmetic is on the screen (the pill is the same size at any zoom), the answer
 * in board units. Before the pane is measured the anchor is left as it is.
 */
export function keepPillInPane(input: {
	anchor: Pt;
	camera: Camera;
	pane: Size;
	/** The pill's size on the screen: measured, else its widest. */
	size?: Size;
}): Pt {
	const { anchor, camera, pane } = input;
	const size = input.size ?? { width: PILL_WIDTH, height: PILL_HEIGHT };
	if (!(pane.width > 0) || !(pane.height > 0) || !(camera.zoom > 0)) {
		return anchor;
	}
	const screenX = anchor.x * camera.zoom + camera.x;
	const screenY = anchor.y * camera.zoom + camera.y;
	const x = Math.max(
		Math.min(screenX, pane.width - PANE_EDGE_GAP),
		PANE_EDGE_GAP + size.width,
	);
	const y = Math.max(
		Math.min(screenY, pane.height - BOARD_TOOLBAR_CLEARANCE + PILL_LIFT),
		PANE_EDGE_GAP + PILL_LIFT + size.height,
	);
	if (x === screenX && y === screenY) return anchor;
	return { x: (x - camera.x) / camera.zoom, y: (y - camera.y) / camera.zoom };
}
