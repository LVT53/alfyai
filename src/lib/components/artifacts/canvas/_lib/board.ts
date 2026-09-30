/**
 * The board's geometry, and nothing that draws: where a block is in board
 * space, which frame holds a point, and what must change when a block is
 * dropped somewhere new. Pure, so the hit test is unit-tested without a browser.
 *
 * Svelte Flow moves a child with its frame and honours `parentId`, but it never
 * ADOPTS: a block dragged over a frame stays where it was in the body until we
 * rewrite its `parentId` and re-base its position. `reparentOnDrop` is that
 * decision; the board applies its answer from `onnodedragstop` (lowercase: the
 * camelCase spelling is accepted as an unknown prop and silently never runs).
 *
 * Conventions this module holds to, all from the body protocol (S3-P):
 * - a child's `position` is relative to its frame; a frame's own position is
 *   relative to ITS frame when it has one, else to the board;
 * - a frame is never adopted by the UI. The protocol allows a frame inside a
 *   frame (Alfy can make one), and such a frame is drawn inside its parent and
 *   moves with it, but nothing a reader drags ever nests one — and dragging a
 *   nested frame out of its parent releases it to the board;
 * - nodes come parents-first (the library's own cascade depends on it too).
 */
import type { CanvasEdge, CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import {
	estimatedNodeHeight,
	NODE_WIDTH,
} from "$lib/shared/artifacts/canvas-blocks";
import { metaFor } from "./block-meta";

type Size = { width: number; height: number };
export type Rect = { x: number; y: number; width: number; height: number };

/** The change a drop makes to a block. `parentId: undefined` is a release, and is named on purpose: a merge (`{ ...node, ...patch }`) would keep the old parent if the key were absent. */
export type ReparentPatch = {
	parentId: string | undefined;
	position: Pt;
	extent: undefined;
};

function indexById(all: readonly CanvasNode[]): Map<string, CanvasNode> {
	return new Map(all.map((node) => [node.id, node]));
}

function isFrame(node: CanvasNode): boolean {
	return node.data.kind === "frame";
}

function absoluteIn(byId: Map<string, CanvasNode>, node: CanvasNode): Pt {
	let x = node.position.x;
	let y = node.position.y;
	const seen = new Set([node.id]);
	let parentId = node.parentId;
	while (parentId !== undefined && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) break;
		x += parent.position.x;
		y += parent.position.y;
		parentId = parent.parentId;
	}
	return { x, y };
}

/** Frame-relative to board-absolute, walking the chain of frames. A frame that is not on the board is skipped, and a cycle stops the walk. */
export function absoluteOf(node: CanvasNode, all: readonly CanvasNode[]): Pt {
	return absoluteIn(indexById(all), node);
}

function sizeOf(node: CanvasNode, measured?: Size): Size {
	if (measured) return measured;
	if (node.measured) return node.measured;
	const own = node.data.kind === "frame" ? node.data : null;
	return {
		width: node.width ?? own?.width ?? NODE_WIDTH,
		height: estimatedNodeHeight(node),
	};
}

function rectIn(
	byId: Map<string, CanvasNode>,
	node: CanvasNode,
	measured?: Size,
): Rect {
	return { ...absoluteIn(byId, node), ...sizeOf(node, measured) };
}

/**
 * A block's rectangle in board space. Its size is what the panel measured, else
 * what it stores, else the footprint a block with no size is taken to have:
 * `NODE_WIDTH` wide and as tall as its words or items make it
 * (`estimatedNodeHeight`, the very numbers the model reads, RV-3 C2).
 */
export function nodeRect(
	node: CanvasNode,
	all: readonly CanvasNode[],
	measured?: Size,
): Rect {
	return rectIn(indexById(all), node, measured);
}

function contains(rect: Rect, point: Pt): boolean {
	return (
		point.x >= rect.x &&
		point.x <= rect.x + rect.width &&
		point.y >= rect.y &&
		point.y <= rect.y + rect.height
	);
}

function depthOf(byId: Map<string, CanvasNode>, node: CanvasNode): number {
	let depth = 0;
	const seen = new Set([node.id]);
	let parentId = node.parentId;
	while (parentId !== undefined && !seen.has(parentId)) {
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (!parent) break;
		depth += 1;
		parentId = parent.parentId;
	}
	return depth;
}

function descendsFrom(
	byId: Map<string, CanvasNode>,
	node: CanvasNode,
	ancestorId: string,
): boolean {
	const seen = new Set([node.id]);
	let parentId = node.parentId;
	while (parentId !== undefined && !seen.has(parentId)) {
		if (parentId === ancestorId) return true;
		seen.add(parentId);
		parentId = byId.get(parentId)?.parentId;
	}
	return false;
}

/**
 * The frame that holds `point`, innermost first: the deepest in the chain of
 * frames, then the smallest, then the one drawn later. `exceptId` and whatever
 * sits inside it are never the answer (a frame is not its own drop target).
 */
export function frameAt(
	point: Pt,
	all: readonly CanvasNode[],
	exceptId?: string,
): CanvasNode | null {
	const byId = indexById(all);
	let best: CanvasNode | null = null;
	let bestDepth = -1;
	let bestArea = Number.POSITIVE_INFINITY;
	for (const candidate of all) {
		if (!isFrame(candidate)) continue;
		if (
			exceptId !== undefined &&
			(candidate.id === exceptId || descendsFrom(byId, candidate, exceptId))
		) {
			continue;
		}
		const rect = rectIn(byId, candidate);
		if (!contains(rect, point)) continue;
		const depth = depthOf(byId, candidate);
		const area = rect.width * rect.height;
		if (depth > bestDepth || (depth === bestDepth && area <= bestArea)) {
			best = candidate;
			bestDepth = depth;
			bestArea = area;
		}
	}
	return best;
}

/**
 * What a drop changes about `node`, or null when it changes nothing (which is
 * what keeps a nudge inside a frame from being rewritten). `all` holds the node
 * at its dropped position. The hit point is the block's CENTRE.
 *
 * - a block whose centre is in a frame it does not belong to joins it, its
 *   position re-based to that frame;
 * - a block whose centre is in no frame, dragged out of the one it was in,
 *   leaves it and keeps its place on the board;
 * - a frame is never adopted (only released, when it was nested and left).
 */
export function reparentOnDrop(
	node: CanvasNode,
	all: readonly CanvasNode[],
	measured?: Size,
): ReparentPatch | null {
	const byId = indexById(all);
	const rect = rectIn(byId, node, measured);
	const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
	const canJoin = metaFor(node.type).structural !== true && !isFrame(node);
	const target = canJoin ? frameAt(centre, all, node.id) : null;
	if (target) {
		if (target.id === node.parentId) return null;
		const origin = absoluteIn(byId, target);
		return {
			parentId: target.id,
			position: { x: rect.x - origin.x, y: rect.y - origin.y },
			extent: undefined,
		};
	}
	if (node.parentId === undefined) return null;
	// A block that is still inside the frame it belongs to stays there.
	const parent = byId.get(node.parentId);
	if (parent && contains(rectIn(byId, parent), centre)) return null;
	return {
		parentId: undefined,
		position: { x: rect.x, y: rect.y },
		extent: undefined,
	};
}

/**
 * What happens to the blocks inside frames that are being removed: they are NOT
 * taken with them (a frame removed to tidy up must not cost a reader their
 * notes — the ops protocol re-homes the same way). Each block that sat directly
 * in a removed frame moves up to the nearest frame that survives, or to the
 * board, at the same place on screen. Keyed by block id; a block that sits in a
 * frame that stays is not in the answer.
 */
export function rehomeOnRemoval(
	removed: ReadonlySet<string>,
	all: readonly CanvasNode[],
): Map<string, { parentId: string | undefined; position: Pt }> {
	const byId = indexById(all);
	const patches = new Map<
		string,
		{ parentId: string | undefined; position: Pt }
	>();
	for (const node of all) {
		if (removed.has(node.id)) continue;
		if (node.parentId === undefined || !removed.has(node.parentId)) continue;
		let parentId: string | undefined = node.parentId;
		const seen = new Set([node.id]);
		while (
			parentId !== undefined &&
			removed.has(parentId) &&
			!seen.has(parentId)
		) {
			seen.add(parentId);
			parentId = byId.get(parentId)?.parentId;
		}
		const survivor = parentId === undefined ? undefined : byId.get(parentId);
		const here = absoluteIn(byId, node);
		const origin = survivor ? absoluteIn(byId, survivor) : { x: 0, y: 0 };
		patches.set(node.id, {
			parentId: survivor?.id,
			position: { x: here.x - origin.x, y: here.y - origin.y },
		});
	}
	return patches;
}

/**
 * Every parent ahead of its children, changing as little as possible: the very
 * same array when it is already in that order. A block adopted by a frame that
 * sits later in the list needs the frame moved up (the library's delete cascade
 * and the saved body both read parents first). The body's frame settling and the
 * create parse order nodes the same way, so it is one function, shared.
 */
export { parentsFirst } from "$lib/shared/artifacts/canvas-body";

/**
 * The sides an edge should use, from where its two ends are: it leaves the side
 * of the source that faces the target and arrives at the side of the target
 * that faces back. A stored edge carries no handle ids (the body has none), so
 * without this every edge would run from a block's bottom to another's top, and
 * an edge drawn sideways would change shape when the board is reopened.
 */
export function facingHandles(
	source: CanvasNode,
	target: CanvasNode,
	all: readonly CanvasNode[],
): { sourceHandle: string; targetHandle: string } {
	const byId = indexById(all);
	const from = rectIn(byId, source);
	const to = rectIn(byId, target);
	const dx = to.x + to.width / 2 - (from.x + from.width / 2);
	const dy = to.y + to.height / 2 - (from.y + from.height / 2);
	if (Math.abs(dx) > Math.abs(dy)) {
		return dx > 0
			? { sourceHandle: "right", targetHandle: "left" }
			: { sourceHandle: "left", targetHandle: "right" };
	}
	return dy >= 0
		? { sourceHandle: "bottom", targetHandle: "top" }
		: { sourceHandle: "top", targetHandle: "bottom" };
}

/** The edges whose two ends are on the board: no edge may point at a block that is not there. The same array when nothing had to go. */
export function withoutDanglingEdges<E extends CanvasEdge>(
	edges: readonly E[],
	nodes: readonly CanvasNode[],
): E[] {
	const ids = new Set(nodes.map((node) => node.id));
	const kept = edges.filter(
		(edge) => ids.has(edge.source) && ids.has(edge.target),
	);
	return kept.length === edges.length ? (edges as E[]) : kept;
}
