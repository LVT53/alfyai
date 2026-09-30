/**
 * What a change did to a board, as the difference between the board before it
 * and the board after (Feature 2 · Artifacts, Slice 3, ruling 63). Pure and
 * browser-safe: the client draws a landing from it (which blocks glide to a new
 * place, which get a ring) and the server computes what is still waiting for
 * the reader from it (`services/artifacts/canvas-review.ts`), so the two cannot
 * disagree about what a change touched.
 *
 * It compares two boards, not a list of ops, on purpose: an `@Alfy` comment's
 * ops are applied on the server and only the new board reaches the browser, and
 * a change made an hour ago is only its two versions. The camera and the
 * reader's marks are not compared: no op can change them.
 */
import type { CanvasBody, CanvasEdge, CanvasNode, Pt } from "./canvas";

export interface BoardDelta {
	addedNodes: string[];
	removedNodes: string[];
	/** The same block in the same frame (or on the board), somewhere else: where it was and where it went, each in its own space. */
	movedNodes: { id: string; from: Pt; to: Pt }[];
	/** The block now sits in another frame, or is out of the one it was in (a frame was removed): its place changed with its parent. */
	reparentedNodes: string[];
	/** Its words, its fields or its size changed. */
	changedNodes: string[];
	addedEdges: string[];
	removedEdges: string[];
	/** The arrow now joins other blocks, or says something else. */
	changedEdges: string[];
	/**
	 * The blocks ON THE NEW BOARD this change touched, in the board's own order
	 * (a frame before what is inside it): every one that was added, moved,
	 * re-homed or changed, and the two ends of an arrow that was added, removed
	 * or changed, where they still exist. A block that was removed is not here:
	 * there is nothing left to point at.
	 */
	touched: string[];
}

/** JSON with the keys of every object in order, so two equal values are equal as text whatever order they were built in. */
function stable(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function samePoint(a: Pt, b: Pt): boolean {
	return a.x === b.x && a.y === b.y;
}

/** The parts of a block that are its content: everything except where it is and which frame it is in. */
function contentOf(node: CanvasNode): string {
	return stable({
		type: node.type,
		width: node.width,
		height: node.height,
		data: node.data,
	});
}

function edgeShape(edge: CanvasEdge): string {
	return stable({
		source: edge.source,
		target: edge.target,
		label: edge.label ?? "",
	});
}

export function diffBoards(before: CanvasBody, after: CanvasBody): BoardDelta {
	const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
	const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
	const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
	const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));

	const delta: BoardDelta = {
		addedNodes: [],
		removedNodes: [],
		movedNodes: [],
		reparentedNodes: [],
		changedNodes: [],
		addedEdges: [],
		removedEdges: [],
		changedEdges: [],
		touched: [],
	};
	const touched = new Set<string>();

	for (const node of after.nodes) {
		const was = beforeNodes.get(node.id);
		if (!was) {
			delta.addedNodes.push(node.id);
			touched.add(node.id);
			continue;
		}
		if ((was.parentId ?? null) !== (node.parentId ?? null)) {
			delta.reparentedNodes.push(node.id);
			touched.add(node.id);
		} else if (!samePoint(was.position, node.position)) {
			delta.movedNodes.push({
				id: node.id,
				from: { x: was.position.x, y: was.position.y },
				to: { x: node.position.x, y: node.position.y },
			});
			touched.add(node.id);
		}
		if (contentOf(was) !== contentOf(node)) {
			delta.changedNodes.push(node.id);
			touched.add(node.id);
		}
	}
	for (const node of before.nodes) {
		if (!afterNodes.has(node.id)) delta.removedNodes.push(node.id);
	}

	const touchEnds = (edge: CanvasEdge): void => {
		for (const end of [edge.source, edge.target]) {
			if (afterNodes.has(end)) touched.add(end);
		}
	};
	for (const edge of after.edges) {
		const was = beforeEdges.get(edge.id);
		if (!was) {
			delta.addedEdges.push(edge.id);
			touchEnds(edge);
		} else if (edgeShape(was) !== edgeShape(edge)) {
			delta.changedEdges.push(edge.id);
			touchEnds(was);
			touchEnds(edge);
		}
	}
	for (const edge of before.edges) {
		if (afterEdges.has(edge.id)) continue;
		// An arrow that went because one of its ends went (a removed block takes
		// its arrows with it) says nothing about the end that is left.
		const endRemoved =
			!afterNodes.has(edge.source) || !afterNodes.has(edge.target);
		delta.removedEdges.push(edge.id);
		if (!endRemoved) touchEnds(edge);
	}

	delta.touched = after.nodes
		.map((node) => node.id)
		.filter((id) => touched.has(id));
	return delta;
}

/** Nothing about the blocks or the arrows differs. */
export function isEmptyDelta(delta: BoardDelta): boolean {
	return (
		delta.addedNodes.length === 0 &&
		delta.removedNodes.length === 0 &&
		delta.movedNodes.length === 0 &&
		delta.reparentedNodes.length === 0 &&
		delta.changedNodes.length === 0 &&
		delta.addedEdges.length === 0 &&
		delta.removedEdges.length === 0 &&
		delta.changedEdges.length === 0
	);
}
