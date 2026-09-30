/**
 * The reader's step that is not saved yet, put on top of the board the server holds
 * now (RV-3 I2). Alfy's version can land while the reader's last step is still in
 * the browser: their save is then against a version the server is past, and it used
 * to be refused, with a Reload as the one way out that took the step away. Nothing
 * is refused now: the two are put together, block by block.
 *
 * Three boards, as a three-way merge: `base` is what the reader started from (the
 * last board the server acknowledged), `server` is what it holds now (Alfy changed
 * `base`), and `reader` is what the reader has now. For every block, connection and
 * mark, a side that did not change it takes what the other side made of it; where
 * both changed the same thing the reader's stands (they typed it, and the newer
 * version is one click away in History), and the block is named so the board can say
 * so: nothing is set aside silently.
 *
 * A block is merged in three parts: where it is (its frame and its place in that
 * frame, one thing, because a place means nothing without its frame), how big it is,
 * and each field of its content (a note's words and its colour are separate). Pure:
 * no component, no hook.
 */
import type {
	Annotation,
	CanvasBody,
	CanvasEdge,
	CanvasNode,
	Pt,
} from "$lib/shared/artifacts/canvas";
import { normalizeCanvasBody } from "$lib/shared/artifacts/canvas-body";

export interface Rebased {
	/** The board with both steps in it, the camera the reader's. */
	body: CanvasBody;
	/** The blocks where the reader's version stood over a different newer one (or the reader's removal over the newer version's change): what the board tells the reader about. Each block once. */
	kept: string[];
}

/** JSON with the keys of every object in order and nothing undefined, so two equal values are equal as text whatever order they were built in. */
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

function same(a: unknown, b: unknown): boolean {
	return stable(a) === stable(b);
}

/** One value, three versions of it: whichever side did not change it takes the other's; both changed it differently, the reader's. */
function pick<T>(
	base: T,
	server: T,
	reader: T,
): { value: T; conflict: boolean } {
	if (same(reader, base)) return { value: server, conflict: false };
	if (same(server, base) || same(server, reader)) {
		return { value: reader, conflict: false };
	}
	return { value: reader, conflict: true };
}

type Placement = { parentId: string | undefined; position: Pt };
type Size = { width: number | undefined; height: number | undefined };

const placementOf = (node: CanvasNode): Placement => ({
	parentId: node.parentId,
	position: node.position,
});
const sizeOf = (node: CanvasNode): Size => ({
	width: node.width,
	height: node.height,
});

/** A node as it is stored: the live fields the library writes onto the reader's blocks (selection, measurement) are not part of it. */
function stored(
	id: string,
	type: CanvasNode["type"],
	placement: Placement,
	size: Size,
	data: CanvasNode["data"],
): CanvasNode {
	return {
		id,
		type,
		position: placement.position,
		...(placement.parentId === undefined
			? {}
			: { parentId: placement.parentId }),
		...(size.width === undefined ? {} : { width: size.width }),
		...(size.height === undefined ? {} : { height: size.height }),
		data,
	};
}

function storedCopy(node: CanvasNode): CanvasNode {
	return stored(node.id, node.type, placementOf(node), sizeOf(node), node.data);
}

function mergeNode(
	base: CanvasNode,
	server: CanvasNode,
	reader: CanvasNode,
): { node: CanvasNode; conflict: boolean } {
	// A block cannot change its kind (the ops refuse it), so the kinds differing is
	// a block that is not the same block any more: the reader's stands.
	if (server.type !== reader.type || base.type !== reader.type) {
		return {
			node: storedCopy(reader),
			conflict: !same(storedCopy(server), storedCopy(base)),
		};
	}
	const place = pick(
		placementOf(base),
		placementOf(server),
		placementOf(reader),
	);
	const size = pick(sizeOf(base), sizeOf(server), sizeOf(reader));
	let conflict = place.conflict || size.conflict;

	const baseData = base.data as Record<string, unknown>;
	const serverData = server.data as Record<string, unknown>;
	const readerData = reader.data as Record<string, unknown>;
	const merged: Record<string, unknown> = {};
	for (const key of new Set([
		...Object.keys(baseData),
		...Object.keys(serverData),
		...Object.keys(readerData),
	])) {
		const field = pick(baseData[key], serverData[key], readerData[key]);
		if (field.conflict) conflict = true;
		if (field.value !== undefined) merged[key] = field.value;
	}
	let data = merged as CanvasNode["data"];
	const width = size.value.width;
	const height = size.value.height;
	// A frame's size lives on the block and in its data, and the block's wins.
	if (reader.type === "frame" && data.kind === "frame") {
		data = {
			...data,
			width: width ?? data.width,
			height: height ?? data.height,
		};
		return {
			node: stored(
				reader.id,
				reader.type,
				place.value,
				{ width: width ?? data.width, height: height ?? data.height },
				data,
			),
			conflict,
		};
	}
	return {
		node: stored(reader.id, reader.type, place.value, size.value, data),
		conflict,
	};
}

function byId<T extends { id: string }>(list: readonly T[]): Map<string, T> {
	return new Map(list.map((item) => [item.id, item]));
}

/** The ids of the newer version, in its order, then the ones only the reader has, in theirs. */
function idsInOrder(
	server: readonly { id: string }[],
	reader: readonly { id: string }[],
): string[] {
	const seen = new Set(server.map((item) => item.id));
	return [
		...server.map((item) => item.id),
		...reader.map((item) => item.id).filter((id) => !seen.has(id)),
	];
}

function mergeNodes(
	base: CanvasBody,
	server: CanvasBody,
	reader: CanvasBody,
): { nodes: CanvasNode[]; kept: string[] } {
	const baseNodes = byId(base.nodes);
	const serverNodes = byId(server.nodes);
	const readerNodes = byId(reader.nodes);
	const nodes: CanvasNode[] = [];
	const kept: string[] = [];
	for (const id of idsInOrder(server.nodes, reader.nodes)) {
		const b = baseNodes.get(id);
		const s = serverNodes.get(id);
		const r = readerNodes.get(id);
		if (s && r) {
			if (b) {
				const merged = mergeNode(b, s, r);
				nodes.push(merged.node);
				if (merged.conflict) kept.push(id);
			} else {
				// Both made a block with this id: the reader's stands.
				nodes.push(storedCopy(r));
				if (!same(storedCopy(s), storedCopy(r))) kept.push(id);
			}
		} else if (s) {
			// The reader has no such block: the newer version made it (it stays) or the
			// reader removed one that was there (their removal stands, and is named when
			// the newer version had changed it).
			if (!b) nodes.push(storedCopy(s));
			else if (!same(storedCopy(s), storedCopy(b))) kept.push(id);
		} else if (r) {
			// The newer version has no such block: the reader made it (it stays) or the
			// newer version removed one that was there (it goes, unless the reader had
			// changed it: their words are not lost).
			if (!b) nodes.push(storedCopy(r));
			else if (!same(storedCopy(r), storedCopy(b))) {
				nodes.push(storedCopy(r));
				kept.push(id);
			}
		}
	}
	return { nodes, kept };
}

const edgeShape = (edge: CanvasEdge) => ({
	source: edge.source,
	target: edge.target,
	label: edge.label ?? "",
});

function mergeEdges(
	base: CanvasBody,
	server: CanvasBody,
	reader: CanvasBody,
): CanvasEdge[] {
	const baseEdges = byId(base.edges);
	const serverEdges = byId(server.edges);
	const readerEdges = byId(reader.edges);
	const edges: CanvasEdge[] = [];
	for (const id of idsInOrder(server.edges, reader.edges)) {
		const b = baseEdges.get(id);
		const s = serverEdges.get(id);
		const r = readerEdges.get(id);
		let edge: CanvasEdge | undefined;
		if (s && r) {
			// One connection, one thing: the reader's when they changed it, else the newer version's.
			edge = b && same(edgeShape(r), edgeShape(b)) ? s : r;
		} else if (s) {
			// Not in the reader's board: removed by them (gone), or made by the newer version.
			edge = b ? undefined : s;
		} else if (r) {
			// Not in the newer version: made by the reader, or removed there (gone unless
			// the reader had changed it).
			edge = !b || !same(edgeShape(r), edgeShape(b)) ? r : undefined;
		}
		if (edge) edges.push({ ...edge });
	}
	return edges;
}

function mergeMarks(
	base: CanvasBody,
	server: CanvasBody,
	reader: CanvasBody,
): Annotation[] {
	const baseMarks = byId(base.annotations);
	const serverMarks = byId(server.annotations);
	const readerMarks = byId(reader.annotations);
	const marks: Annotation[] = [];
	for (const id of idsInOrder(server.annotations, reader.annotations)) {
		const b = baseMarks.get(id);
		const s = serverMarks.get(id);
		const r = readerMarks.get(id);
		if (s && r) marks.push(b && same(r, b) ? s : r);
		else if (s) {
			// The reader erased it, or the newer version drew it.
			if (!b) marks.push(s);
		} else if (r) {
			// The reader drew it, or the newer version erased it (it goes, unless the reader changed it).
			if (!b || !same(r, b)) marks.push(r);
		}
	}
	return marks;
}

/**
 * The board with the reader's step on top of the newer version, and the blocks
 * where both had changed the same thing. The result has been through the same
 * reader as any stored board, so a block the newer version put in a frame the
 * reader deleted stays on the board, out of the frame, rather than being lost.
 */
export function rebaseBoard(
	base: CanvasBody,
	server: CanvasBody,
	reader: CanvasBody,
): Rebased {
	const { nodes, kept } = mergeNodes(base, server, reader);
	const merged: CanvasBody = {
		version: 1,
		nodes,
		edges: mergeEdges(base, server, reader),
		viewport: { ...reader.viewport },
		annotations: mergeMarks(base, server, reader),
	};
	return { body: normalizeCanvasBody(merged).body, kept };
}

/**
 * The editor's call: the board the server last acknowledged (as its JSON), the newer
 * version, and the reader's board as it is now (a board, or its JSON when the board
 * is not drawn). The parsing is here so the editor carries none of it.
 */
export function rebaseOnto(
	savedJson: string,
	server: CanvasBody,
	reader: CanvasBody | string,
): Rebased {
	const read = (json: string) => normalizeCanvasBody(JSON.parse(json)).body;
	return rebaseBoard(
		read(savedJson),
		server,
		typeof reader === "string" ? read(reader) : reader,
	);
}
