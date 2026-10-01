/**
 * Resizing several blocks together, as a pure function of the blocks and of a
 * handle dragged: no component, no flow library, so the arithmetic is tested
 * without a browser and the part that draws the box is the only code that needs
 * the screen. Loaded on demand with the group box (`group-parts.ts`): the
 * editor's first paint never carries it.
 *
 * What is scaled. The reader's picked blocks, and the notes inside a picked
 * frame (picked or not: they are part of the frame, as they are when it is
 * moved). The box is the union of the PICKED blocks' rectangles, as drawn. A
 * handle scales that box about the opposite corner (a corner handle: both ways;
 * an edge handle: one), and every block's place and size scale with it, so the
 * arrangement keeps its shape.
 *
 * What is held. Each kind has a smallest size (`BLOCK_META.minSize`, the same one
 * a single block's corner stops at). The group stops shrinking where the block
 * that runs out first reaches its own: one factor for all, so nothing is squeezed
 * past what is readable and nothing overlaps because of a clamp. A block already
 * smaller than its minimum (a note Alfy made small) is not made to grow by it.
 *
 * Whole numbers throughout, in the space each block stores: a block inside a frame
 * is stored relative to the frame, so its new position is taken from the frame's
 * NEW corner when the frame is scaled with it, and from the frame's corner as it is
 * when the frame is not part of the group.
 */
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { metaFor } from "./block-meta";
import { absoluteOf, nodeRect, type Rect } from "./board";

/** Where on the box a handle is: corners scale both ways, edges one. */
export type GroupHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";

/** What a block becomes: its place (in the space it is stored in) and its size. */
export type GroupPatch = { position: Pt; width: number; height: number };

type Item = {
	id: string;
	/** Where it is on the board, as drawn. */
	rect: Rect;
	/** The smallest it may be made. */
	min: { width: number; height: number };
	parentId: string | undefined;
};

export type Group = {
	/** The box around what was picked, in board units. */
	box: Rect;
	/** Everything the box scales: the picked blocks and the notes of a picked frame. */
	items: readonly Item[];
	/** Where a frame that holds an item, and is not scaled with it, has its corner. */
	origins: ReadonlyMap<string, Pt>;
};

function unionOf(rects: readonly Rect[]): Rect {
	const left = Math.min(...rects.map((rect) => rect.x));
	const top = Math.min(...rects.map((rect) => rect.y));
	const right = Math.max(...rects.map((rect) => rect.x + rect.width));
	const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/** The group the picked blocks make, or null while fewer than two are picked. */
export function groupOf(nodes: readonly CanvasNode[]): Group | null {
	const picked = nodes.filter((node) => node.selected);
	if (picked.length < 2) return null;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const pickedIds = new Set(picked.map((node) => node.id));
	// A block is in the group when it, or a frame above it, is picked.
	const inGroup = (node: CanvasNode): boolean => {
		const seen = new Set<string>();
		let at: CanvasNode | undefined = node;
		while (at && !seen.has(at.id)) {
			if (pickedIds.has(at.id)) return true;
			seen.add(at.id);
			at = at.parentId === undefined ? undefined : byId.get(at.parentId);
		}
		return false;
	};
	const members = nodes.filter(inGroup);
	const memberIds = new Set(members.map((node) => node.id));
	const origins = new Map<string, Pt>();
	for (const node of members) {
		const parent =
			node.parentId === undefined ? undefined : byId.get(node.parentId);
		if (parent && !memberIds.has(parent.id)) {
			origins.set(parent.id, absoluteOf(parent, nodes));
		}
	}
	return {
		box: unionOf(picked.map((node) => nodeRect(node, nodes))),
		items: members.map((node) => ({
			id: node.id,
			rect: nodeRect(node, nodes),
			min: metaFor(node.type).minSize,
			parentId: node.parentId,
		})),
		origins,
	};
}

/**
 * The factor a side may be scaled to, for the box being dragged to `wanted`: no
 * smaller than the one at which the first block reaches its own minimum, never
 * forced above 1 by a block that is below its minimum already.
 */
function factor(
	size: number,
	wanted: number,
	items: readonly Item[],
	side: "width" | "height",
): number {
	if (size <= 0) return 1;
	const floor = Math.min(
		1,
		Math.max(
			0,
			...items.map((item) =>
				item.rect[side] > 0 ? item.min[side] / item.rect[side] : 0,
			),
		),
	);
	return Math.max(wanted, size * floor) / size;
}

/**
 * The group with `handle` dragged by `delta` (board units, from where the drag
 * began): the box as it becomes and what each block becomes. A drag the handle's
 * axis does not use is ignored (an edge handle).
 */
export function resizeGroup(
	group: Group,
	handle: GroupHandle,
	delta: Pt,
): { box: Rect; patches: Map<string, GroupPatch> } {
	const { box, items, origins } = group;
	const toward = {
		x: handle.includes("e") ? 1 : handle.includes("w") ? -1 : 0,
		y: handle.includes("s") ? 1 : handle.includes("n") ? -1 : 0,
	};
	const sx =
		toward.x === 0
			? 1
			: factor(box.width, box.width + toward.x * delta.x, items, "width");
	const sy =
		toward.y === 0
			? 1
			: factor(box.height, box.height + toward.y * delta.y, items, "height");
	// The corner (or edge) opposite the handle stays where it is.
	const anchor = {
		x: toward.x === -1 ? box.x + box.width : box.x,
		y: toward.y === -1 ? box.y + box.height : box.y,
	};
	const about = (value: number, at: number, scale: number) =>
		Math.round(at + (value - at) * scale);

	const rects = new Map<string, Rect>(
		items.map((item) => [
			item.id,
			{
				x: about(item.rect.x, anchor.x, sx),
				y: about(item.rect.y, anchor.y, sy),
				width: Math.round(item.rect.width * sx),
				height: Math.round(item.rect.height * sy),
			},
		]),
	);
	const patches = new Map<string, GroupPatch>();
	for (const item of items) {
		const rect = rects.get(item.id) as Rect;
		const parent =
			item.parentId === undefined
				? undefined
				: (rects.get(item.parentId) ?? origins.get(item.parentId));
		patches.set(item.id, {
			position: {
				x: rect.x - (parent?.x ?? 0),
				y: rect.y - (parent?.y ?? 0),
			},
			width: rect.width,
			height: rect.height,
		});
	}
	return {
		box: {
			x: about(box.x, anchor.x, sx),
			y: about(box.y, anchor.y, sy),
			width: Math.round(box.width * sx),
			height: Math.round(box.height * sy),
		},
		patches,
	};
}
