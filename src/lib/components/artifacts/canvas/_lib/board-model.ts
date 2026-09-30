/**
 * The board's state as Svelte Flow holds it, and back to the body that is
 * stored. Pure: no component, no hook, so it is tested without a browser.
 *
 * Svelte Flow writes `measured`, `selected` and `dragging` back onto the nodes it
 * was handed, and takes its own fields (`zIndex`, `dragHandle`, `style`), so the
 * live node is a superset of the stored one. `boardJson` (the canonical writer,
 * ruling 12) is what narrows it again; this module only adds what the canonical
 * form has to be told about — a frame's size, which lives on the node AND in its
 * data — and the library fields a kind asks for.
 */
import type {
	Annotation,
	CanvasBody,
	CanvasEdge,
	CanvasNode,
} from "$lib/shared/artifacts/canvas";
import {
	type CanvasBlockData,
	NODE_WIDTH,
	type PosterRef,
} from "$lib/shared/artifacts/canvas-blocks";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { metaFor } from "./block-meta";
import { facingHandles, withoutDanglingEdges } from "./board";

type Camera = CanvasBody["viewport"];

/** Where a board that was never panned or zoomed looks from; a board with nodes and no other camera is fitted on open. */
export const DEFAULT_CAMERA: Camera = { x: 0, y: 0, zoom: 1 };

/** A node as Svelte Flow is handed it: the live node plus the fields the library reads. */
export type FlowNode = CanvasNode & { dragHandle?: string; style?: string };

/** An edge as Svelte Flow is handed it: the stored one plus the sides it runs between (the body stores none). */
export type FlowEdge = CanvasEdge & {
	sourceHandle?: string;
	targetHandle?: string;
};

type BoardState = {
	nodes: readonly CanvasNode[];
	edges: readonly CanvasEdge[];
	viewport: Camera;
	annotations: readonly Annotation[];
};

/**
 * Stored nodes to library nodes: each kind's own hints (a frame sits behind what
 * it groups, is dragged by its chip, and lets pointers through) copied on, and a
 * frame that has no size of its own on the node takes the one in its data. Any
 * other block stored with no width (a board made before Alfy's blocks carried
 * one) is DRAWN at `NODE_WIDTH`, the width Alfy reads it at, instead of as wide
 * as its words run (RV-3 C2). It is a drawing hint (the wrapper's `style`), not a
 * width on the node: the board's data, and the diff between two boards, stay what
 * was stored, and a resize still sets a width of its own, which wins.
 */
export function toFlowNodes(nodes: readonly CanvasNode[]): FlowNode[] {
	return nodes.map((node) => {
		const flow = metaFor(node.type).flow;
		const live: FlowNode = { ...node, ...(flow ?? {}) };
		if (node.data.kind === "frame") {
			live.width = node.width ?? node.data.width;
			live.height = node.height ?? node.data.height;
		} else if (node.width === undefined) {
			live.style = `${flow?.style ?? ""}width: ${NODE_WIDTH}px;`;
		}
		return live;
	});
}

/**
 * Stored edges to library edges: each takes the sides that face its two ends
 * (`facingHandles`), because the body carries no handle ids and the library
 * would otherwise run every edge from a block's bottom to another's top. An
 * edge with an end that is not on the board is handed over as it is.
 */
export function toFlowEdges(
	edges: readonly CanvasEdge[],
	nodes: readonly CanvasNode[],
): FlowEdge[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	return edges.map((edge) => {
		const source = byId.get(edge.source);
		const target = byId.get(edge.target);
		return source && target
			? { ...edge, ...facingHandles(source, target, nodes) }
			: { ...edge };
	});
}

/** A frame's size is on the node and in its data, and the two are kept equal: the node's (which a resize moves) wins. */
function withFrameSizeInData(node: CanvasNode): CanvasNode {
	if (node.data.kind !== "frame") return node;
	const width = node.width ?? node.data.width;
	const height = node.height ?? node.data.height;
	return { ...node, width, height, data: { ...node.data, width, height } };
}

/** The body the board holds right now, ready for `boardJson`. */
export function bodyOfState(state: BoardState): CanvasBody {
	return {
		version: 1,
		nodes: state.nodes.map(withFrameSizeInData),
		// The library adds fields of its own to an edge (handles, selection);
		// the body keeps four. No edge may point at a block that is not there.
		edges: withoutDanglingEdges(state.edges, state.nodes).map(
			({ id, source, target, label }) => ({
				id,
				source,
				target,
				...(label ? { label } : {}),
			}),
		),
		viewport: { ...state.viewport },
		annotations: [...state.annotations],
	};
}

/**
 * The board's canonical JSON with the camera taken out: what makes one board
 * state different from another for history and for "has anything changed".
 * A pan changes the camera and nothing else, and is not a change.
 */
export function structuralJson(body: CanvasBody): string {
	return boardJson({ ...body, viewport: DEFAULT_CAMERA });
}

/** True when the body's camera is anywhere but the default: the reader (or a save) put it there. */
export function hasStoredCamera(body: CanvasBody): boolean {
	const camera = body.viewport;
	return (
		camera.x !== DEFAULT_CAMERA.x ||
		camera.y !== DEFAULT_CAMERA.y ||
		camera.zoom !== DEFAULT_CAMERA.zoom
	);
}

/**
 * The nodes with one block's data replaced — a live-web block's new snapshot — or
 * null when there is no such block or it is a block of another kind (the reader
 * deleted it, or something else took its place, while the search ran). Only the
 * data changes: the block stays where it is, at its size, in its frame. The nodes
 * it is given are not touched.
 */
export function withBlockData<N extends CanvasNode>(
	nodes: readonly N[],
	id: string,
	data: CanvasBlockData,
): N[] | null {
	const target = nodes.find((node) => node.id === id);
	if (!target || target.data.kind !== data.kind) return null;
	return nodes.map((node) => (node === target ? { ...node, data } : node));
}

/**
 * The nodes with one block's still image set (or, with null, taken off), or null
 * when there is no such block or it is a kind that has no poster. Only the
 * poster changes; the block's own data, place and size are the ones it had. The
 * nodes it is given are not touched.
 */
export function withBlockPoster<N extends CanvasNode>(
	nodes: readonly N[],
	id: string,
	poster: PosterRef | null,
): N[] | null {
	const target = nodes.find((node) => node.id === id);
	if (!target || !metaFor(target.type).needsPoster) return null;
	const { poster: _dropped, ...rest } = target.data as CanvasBlockData & {
		poster?: PosterRef;
	};
	const data = (poster ? { ...rest, poster } : rest) as CanvasBlockData;
	return nodes.map((node) => (node === target ? { ...node, data } : node));
}
