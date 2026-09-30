/**
 * What a comment thread means on a board, and nothing that draws: where its pin
 * sits, whether the block it was left on is still there, the number it wears,
 * and which block a click landed on. Pure, so it is unit-tested without a
 * browser and the components (`CommentLayer`, the list) only draw what it says.
 *
 * Whether a thread is orphaned is never decided here by asking "is there such a
 * node": it is the resolver's answer (`canvasAnchorResolver`, ruling 11), so a
 * board and a Document read one shape of "the thing it was on is gone".
 */
import type { ArtifactComment } from "$lib/server/services/artifacts/types";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { CanvasNode, Pt } from "$lib/shared/artifacts/canvas";
import { canvasAnchorResolver } from "$lib/shared/artifacts/comments";
import { nodeRect } from "./board";
import { excerpt } from "./excerpt";

/** How many characters of a note's words name it in a comment's quote line. */
const NAME_MAX_CHARS = 40;

/** A thread whose block is gone, or whose anchor could not be read at all: it stays in the list, dimmed, and draws no pin. */
export function isOrphaned(
	thread: ArtifactComment,
	nodes: readonly CanvasNode[],
): boolean {
	if (!thread.anchor) return true;
	return (
		canvasAnchorResolver.resolve(thread.anchor, nodes).state === "orphaned"
	);
}

/**
 * The board-space point an anchor sits at: the node's top-right corner, or the
 * raw point. Null when it is orphaned (no pin is drawn). A block's corner is
 * where the panel measured it, else where it is stored, and a note inside a
 * frame is placed through the frame.
 */
export function anchorPoint(
	anchor: Anchor | null,
	nodes: readonly CanvasNode[],
): Pt | null {
	if (
		!anchor ||
		canvasAnchorResolver.resolve(anchor, nodes).state === "orphaned"
	) {
		return null;
	}
	if (anchor.kind === "point") return { x: anchor.x, y: anchor.y };
	if (anchor.kind !== "node") return null;
	const node = nodes.find((candidate) => candidate.id === anchor.nodeId);
	if (!node) return null;
	const rect = nodeRect(node, nodes, node.measured);
	return { x: rect.x + rect.width, y: rect.y };
}

/** The board-space point a thread's pin sits at, or null when it draws none. */
export function pinAt(
	thread: ArtifactComment,
	nodes: readonly CanvasNode[],
): Pt | null {
	return anchorPoint(thread.anchor, nodes);
}

/** The number a thread's pin wears: its 1-based place in the list, kept when it is resolved; `?` for an id the list does not know, never pin 0. */
export function pinLabel(
	threads: readonly ArtifactComment[],
	id: string,
): string {
	const index = threads.findIndex((thread) => thread.id === id);
	return index === -1 ? "?" : String(index + 1);
}

export function threadCounts(threads: readonly ArtifactComment[]): {
	open: number;
	resolved: number;
} {
	const resolved = threads.filter(
		(thread) => thread.status === "resolved",
	).length;
	return { open: threads.length - resolved, resolved };
}

/**
 * The block a board point falls on, or null. A frame is never the answer: its
 * inside is board, so a click there is a spot, and a frame is commented on by
 * selecting it. Of blocks that overlap the later one wins, as it is drawn on top.
 */
export function nodeAt(
	point: Pt,
	nodes: readonly CanvasNode[],
): CanvasNode | null {
	let hit: CanvasNode | null = null;
	for (const node of nodes) {
		if (node.data.kind === "frame") continue;
		const rect = nodeRect(node, nodes, node.measured);
		if (
			point.x >= rect.x &&
			point.x <= rect.x + rect.width &&
			point.y >= rect.y &&
			point.y <= rect.y + rect.height
		) {
			hit = node;
		}
	}
	return hit;
}

/**
 * A block's own words, for the line that says what a comment is on ("Trains
 * card"): a note's text cut short, a frame's, a list's or a chart's label.
 * Null when it has none; the caller then names its kind.
 */
export function nodeWords(node: CanvasNode): string | null {
	const data = node.data;
	switch (data.kind) {
		case "sticky":
		case "text":
			return excerpt(data.text, NAME_MAX_CHARS) || null;
		case "frame":
			return data.label.trim() || null;
		case "checklist":
		case "chart":
			return data.label?.trim() || null;
		case "map":
			return data.route.trim() || null;
		case "file":
			return data.name.trim() || null;
		case "app":
			return data.title.trim() || null;
		case "liveweb":
			return data.query.trim() || null;
		case "photo":
			return null;
	}
}
