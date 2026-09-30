/**
 * Where Alfy's change is on the board, in board space, and nothing that draws:
 * the rectangle of each block it touched, the one that holds them all (the change
 * pill sits at its top-right corner, the dashed arranging frame goes around it),
 * and how far a frame stands off what it surrounds. Pure, so it is unit-tested
 * without a browser; the layer only draws what it says.
 */
import type { CanvasNode } from "$lib/shared/artifacts/canvas";
import { nodeRect } from "./board";

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
