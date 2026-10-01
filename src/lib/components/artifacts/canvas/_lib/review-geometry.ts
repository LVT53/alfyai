/**
 * Where Alfy's change is on the board, in board space, and nothing that draws:
 * the rectangle of each block it touched, the one that holds them all (the dashed
 * arranging frame goes around it), where the change pill hangs (from the block the
 * review bar is on, never from the box that holds them all), and how far a frame
 * stands off what it surrounds. Pure, so it is unit-tested without a browser; the
 * layer only draws what it says.
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

/** The change pill's size on the screen (its widest, with Keep and Undo), and how far clear of its point it hangs. The layer scales it by 1 / zoom, so it is this size at any zoom. */
const PILL_WIDTH = 280;
const PILL_HEIGHT = 28;
const PILL_LIFT = 16;

type Camera = { x: number; y: number; zoom: number };
type Size = { width: number; height: number };

/**
 * How the change pill is laid against the point it hangs from: which of its edges
 * is at the point (`end`: its right edge, and it runs to the left; `start`: its
 * left edge, and it runs to the right) and whether it is lifted above the point or
 * dropped below it, clear of it by the same 16 either way.
 */
export type PillPlacement = {
	at: Pt;
	align: "end" | "start";
	side: "above" | "below";
};

function overlapArea(a: Box, b: Box): number {
	const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
	const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
	return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Where the change pill hangs: from the block the review bar is on (`current`),
 * never from the box that holds every touched block, which for a change spread over
 * the board is an empty corner (or, past the pane, the pane's edge) near none of
 * them. It goes above the block's top-right corner, where a reader looks for it;
 * when that would put it on blocks Alfy left alone (`obstacles`: every block but a
 * frame, which is a backdrop) it is tried above the block's top-left corner, then
 * below its bottom-right one, then below its bottom-left one: the first that is
 * clear, else the one with the least under it. `size` is the pill's size on the
 * screen, measured, else its widest; it is the same size at any zoom, so in board
 * units it grows as the board is zoomed out.
 */
export function changePillPlacement(input: {
	current: Box;
	obstacles: readonly Box[];
	zoom: number;
	size?: Size;
}): PillPlacement {
	const { current, obstacles } = input;
	const inv = input.zoom > 0 ? 1 / input.zoom : 1;
	const size = input.size ?? { width: PILL_WIDTH, height: PILL_HEIGHT };
	const width = size.width * inv;
	const height = size.height * inv;
	const lift = PILL_LIFT * inv;
	const right = current.x + current.width;
	const bottom = current.y + current.height;
	const candidates: PillPlacement[] = [
		{ at: { x: right, y: current.y }, align: "end", side: "above" },
		{ at: { x: current.x, y: current.y }, align: "start", side: "above" },
		{ at: { x: right, y: bottom }, align: "end", side: "below" },
		{ at: { x: current.x, y: bottom }, align: "start", side: "below" },
	];
	const under = (placement: PillPlacement): number => {
		const pill: Box = {
			x: placement.align === "end" ? placement.at.x - width : placement.at.x,
			y:
				placement.side === "above"
					? placement.at.y - lift - height
					: placement.at.y + lift,
			width,
			height,
		};
		return obstacles.reduce((total, box) => total + overlapArea(pill, box), 0);
	};
	let best = candidates[0];
	let bestUnder = under(best);
	for (const candidate of candidates.slice(1)) {
		if (bestUnder === 0) break;
		const area = under(candidate);
		if (area < bestUnder) {
			best = candidate;
			bestUnder = area;
		}
	}
	return best;
}

/** Where the change pill is on the screen, in the pane's pixels, when it hangs as `placement` says: 16 clear of its point, above or below it, running left or right from it. */
export function changePillScreenRect(
	placement: PillPlacement,
	camera: Camera,
	size: Size = { width: PILL_WIDTH, height: PILL_HEIGHT },
): ScreenRect {
	const x = placement.at.x * camera.zoom + camera.x;
	const y = placement.at.y * camera.zoom + camera.y;
	const left = placement.align === "end" ? x - size.width : x;
	const top =
		placement.side === "above" ? y - PILL_LIFT - size.height : y + PILL_LIFT;
	return { left, top, right: left + size.width, bottom: top + size.height };
}

/**
 * The change pill's placement moved along the screen until the pill is inside the
 * pane (RC-3 N3): a block near an edge put it half outside, and one near the top
 * put it over the pane's header. A gap inside the edge, and above the board's own
 * toolbar along the bottom; the left and top edges win when the pane is smaller
 * than the pill. The arithmetic is on the screen (the pill is the same size at any
 * zoom), the answer in board units. Before the pane is measured the placement is
 * left as it is.
 */
export function keepPillInPane(input: {
	placement: PillPlacement;
	camera: Camera;
	pane: Size;
	/** The pill's size on the screen: measured, else its widest. */
	size?: Size;
}): PillPlacement {
	const { placement, camera, pane } = input;
	if (!(pane.width > 0) || !(pane.height > 0) || !(camera.zoom > 0)) {
		return placement;
	}
	const rect = changePillScreenRect(placement, camera, input.size);
	let dx = 0;
	let dy = 0;
	if (rect.right > pane.width - PANE_EDGE_GAP) {
		dx = pane.width - PANE_EDGE_GAP - rect.right;
	}
	if (rect.left + dx < PANE_EDGE_GAP) dx = PANE_EDGE_GAP - rect.left;
	if (rect.bottom > pane.height - BOARD_TOOLBAR_CLEARANCE) {
		dy = pane.height - BOARD_TOOLBAR_CLEARANCE - rect.bottom;
	}
	if (rect.top + dy < PANE_EDGE_GAP) dy = PANE_EDGE_GAP - rect.top;
	if (dx === 0 && dy === 0) return placement;
	return {
		...placement,
		at: {
			x: placement.at.x + dx / camera.zoom,
			y: placement.at.y + dy / camera.zoom,
		},
	};
}

/**
 * Whether a block is wholly outside the pane: nothing of it can be seen, so a pill
 * that hung from it would be at the edge of the pane beside nothing. The pill is not
 * drawn then (the review bar still offers the decision, and its stepper brings the
 * block back). A block that is partly in view, or only under the board's toolbar, is
 * in view. False before the pane is measured.
 */
export function outOfView(box: Box, camera: Camera, pane: Size): boolean {
	if (!(pane.width > 0) || !(pane.height > 0)) return false;
	const left = box.x * camera.zoom + camera.x;
	const top = box.y * camera.zoom + camera.y;
	return (
		left + box.width * camera.zoom <= 0 ||
		left >= pane.width ||
		top + box.height * camera.zoom <= 0 ||
		top >= pane.height
	);
}
