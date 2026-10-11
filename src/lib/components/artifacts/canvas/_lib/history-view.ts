/**
 * What History draws on a board's preview (ruling 76, versioning.md §5.4): which
 * blocks are ringed, which are new, where a moved one stood, what is gone, and the
 * list of changes the stepper and a screen reader walk. Pure: it compares two stored
 * boards (`diffBoards`, the very comparison the review landing and the server's
 * "waiting" count are made from, so the three cannot disagree about what a change
 * touched) and says nothing about pixels but the places things were: the layer that
 * draws it reads each block's live rectangle from the board.
 *
 * "This version's changes" compares a version with the one before it; "Compared
 * with now" compares it with the newest, which is what Restore would change. Either
 * way the board shown is the selected version's own, and what it has that the other
 * does not is "new", what only the other has is a ghost where it stood.
 */
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import { diffBoards } from "$lib/shared/artifacts/board-diff";
import { nodeRect, type Rect } from "./board";
import { excerpt } from "./excerpt";

export type BoardChangeKind =
	"added" | "changed" | "moved" | "linked" | "removed";

export interface BoardChange {
	id: string;
	kind: BoardChangeKind;
	/** The block's own words in a few of them, or `null` when it has none: the view then names its kind. */
	label: string | null;
	/** The block's kind (`sticky`, `frame`, `chart`…), for the name a block with no words gets. */
	blockKind: string;
}

export interface HistoryBoardView {
	/** The stepper's stops and the screen-reader list: what is still on the board in its own order, then what is gone. */
	changes: BoardChange[];
	/** Blocks on the board that this comparison touched, ringed. */
	ringIds: string[];
	/** Blocks that are new, tagged "New". */
	newIds: string[];
	/** Blocks that stand somewhere else: where each stood on the board (not in its frame), for the trail. */
	moved: { id: string; from: Rect }[];
	/** What is gone, as a dashed outline where it stood. */
	ghosts: { id: string; rect: Rect; label: string | null; blockKind: string }[];
}

/** Longest label a change carries: a few words, not a paragraph. */
const LABEL_CHARS = 40;

const EMPTY_VIEW: HistoryBoardView = {
	changes: [],
	ringIds: [],
	newIds: [],
	moved: [],
	ghosts: [],
};

/** The words a block carries, whatever its kind: its text, else its label, its title or its query. */
function labelOf(node: CanvasNode): string | null {
	const data = node.data as unknown as Record<string, unknown>;
	for (const key of ["text", "label", "title", "query"]) {
		const value = data[key];
		if (typeof value === "string" && value.trim() !== "") {
			return excerpt(value, LABEL_CHARS);
		}
	}
	return null;
}

function centreOf(rect: Rect): { x: number; y: number } {
	return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

/** A block that ends up within a couple of pixels of where it was on the board has not moved, whatever its frame did. */
const SAME_PLACE_PX = 2;

export function buildHistoryView(
	base: CanvasBody | null,
	target: CanvasBody,
): HistoryBoardView {
	if (base === null) return EMPTY_VIEW;
	const delta = diffBoards(base, target);
	const targetById = new Map(target.nodes.map((node) => [node.id, node]));
	const baseById = new Map(base.nodes.map((node) => [node.id, node]));
	const added = new Set(delta.addedNodes);
	const changed = new Set(delta.changedNodes);
	const movedIds = new Set([
		...delta.movedNodes.map((entry) => entry.id),
		...delta.reparentedNodes,
	]);

	const changes: BoardChange[] = [];
	const ringIds: string[] = [];
	const moved: HistoryBoardView["moved"] = [];
	for (const id of delta.touched) {
		const node = targetById.get(id);
		if (!node) continue;
		ringIds.push(id);
		const kind: BoardChangeKind = added.has(id)
			? "added"
			: changed.has(id)
				? "changed"
				: movedIds.has(id)
					? "moved"
					: "linked";
		changes.push({
			id,
			kind,
			label: labelOf(node),
			blockKind: node.data.kind,
		});
		const was = baseById.get(id);
		if (movedIds.has(id) && was) {
			const from = nodeRect(was, base.nodes);
			const now = nodeRect(node, target.nodes);
			const a = centreOf(from);
			const b = centreOf(now);
			if (
				Math.abs(a.x - b.x) > SAME_PLACE_PX ||
				Math.abs(a.y - b.y) > SAME_PLACE_PX
			) {
				moved.push({ id, from });
			}
		}
	}

	const ghosts: HistoryBoardView["ghosts"] = [];
	for (const id of delta.removedNodes) {
		const node = baseById.get(id);
		if (!node) continue;
		const label = labelOf(node);
		ghosts.push({
			id,
			rect: nodeRect(node, base.nodes),
			label,
			blockKind: node.data.kind,
		});
		changes.push({ id, kind: "removed", label, blockKind: node.data.kind });
	}

	return {
		changes,
		ringIds,
		newIds: delta.addedNodes.filter((id) => targetById.has(id)),
		moved,
		ghosts,
	};
}

// ---- The camera ------------------------------------------------------------

/** What the board lets the camera zoom to (`CanvasBoard`'s `MIN_ZOOM`); a preview never magnifies past 1:1. */
export const PREVIEW_MIN_ZOOM = 0.2;
export const PREVIEW_MAX_ZOOM = 1;

/** Room kept clear round what the camera is fitted to, in pixels: the top has the "New" tags and the change note, the bottom the zoom control. */
const FIT_PADDING = { top: 56, right: 40, bottom: 56, left: 40 } as const;

export type Camera = { x: number; y: number; zoom: number };

/**
 * The camera that shows `box` whole in the pane, centred in what the padding
 * leaves, as large as the board allows and never past 1:1 (a small change is not
 * blown up to fill the pane). A pane that has not been measured gets a camera of
 * 1:1 on the box's corner, so nothing downstream sees NaN.
 */
export function fitCamera(
	box: Rect,
	pane: { width: number; height: number },
): Camera {
	if (!(pane.width > 0) || !(pane.height > 0)) {
		return { x: -box.x, y: -box.y, zoom: PREVIEW_MAX_ZOOM };
	}
	const roomWidth = Math.max(1, pane.width - FIT_PADDING.left - FIT_PADDING.right);
	const roomHeight = Math.max(
		1,
		pane.height - FIT_PADDING.top - FIT_PADDING.bottom,
	);
	const zoom = Math.min(
		PREVIEW_MAX_ZOOM,
		Math.max(
			PREVIEW_MIN_ZOOM,
			Math.min(roomWidth / Math.max(1, box.width), roomHeight / Math.max(1, box.height)),
		),
	);
	return {
		x: FIT_PADDING.left + (roomWidth - box.width * zoom) / 2 - box.x * zoom,
		y: FIT_PADDING.top + (roomHeight - box.height * zoom) / 2 - box.y * zoom,
		zoom,
	};
}

/** The one rectangle that holds all of these, or `null` when there are none. */
export function unionOf(rects: readonly Rect[]): Rect | null {
	if (rects.length === 0) return null;
	let left = Number.POSITIVE_INFINITY;
	let top = Number.POSITIVE_INFINITY;
	let right = Number.NEGATIVE_INFINITY;
	let bottom = Number.NEGATIVE_INFINITY;
	for (const rect of rects) {
		left = Math.min(left, rect.x);
		top = Math.min(top, rect.y);
		right = Math.max(right, rect.x + rect.width);
		bottom = Math.max(bottom, rect.y + rect.height);
	}
	return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * What the camera is fitted to: the marked blocks where they are now, what is gone
 * where it stood and where a moved block came from, so none of the change is off
 * the screen; the whole board when nothing is marked.
 */
export function focusRects(
	view: HistoryBoardView,
	nodes: readonly CanvasNode[],
): Rect[] {
	const marked = new Set(view.ringIds);
	const rects: Rect[] = [];
	for (const node of nodes) {
		if (marked.has(node.id)) rects.push(nodeRect(node, nodes, node.measured));
	}
	for (const ghost of view.ghosts) rects.push(ghost.rect);
	for (const entry of view.moved) rects.push(entry.from);
	if (rects.length > 0) return rects;
	return nodes.map((node) => nodeRect(node, nodes, node.measured));
}
