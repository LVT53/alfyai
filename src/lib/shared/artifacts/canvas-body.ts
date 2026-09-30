/**
 * The Canvas body's two pure halves: `normalizeCanvasBody` reads a stored or
 * client-sent board without trusting it, and `boardJson` writes the ONE
 * canonical JSON a version stores and hashes (ruling 12). Both live in
 * `shared/` because the server stores and validates with them and the board
 * compares with them; neither may import a component, an icon or a server
 * module.
 */
import {
	ANNOTATION_KINDS,
	type Annotation,
	type CanvasBody,
	type CanvasEdge,
	type CanvasNode,
	type Pt,
	type StoredCanvasNode,
} from "./canvas";
import {
	BLOCK_DATA_SCHEMAS,
	isBlockKind,
	withUniqueEntryIds,
} from "./canvas-blocks";

/** A board past this is a rendering problem, not a deployment preference (perf budget). */
export const MAX_NODES_PER_BOARD = 400;
/** `content_text` is one SQLite text column; the cap is the storage shape. */
export const MAX_BODY_BYTES = 1024 * 1024;
export const MAX_ANNOTATIONS_PER_BOARD = 600;
/** Decimated by distance, so the cap never clips an end. */
export const MAX_POINTS_PER_STROKE = 1200;

const ID_MAX_CHARS = 128;
const EDGE_LABEL_MAX_CHARS = 500;
const ANNOTATION_COLOR_MAX_CHARS = 64;
export const ANNOTATION_TEXT_MAX_CHARS = 2_000;
const ANNOTATION_SIZE_MAX = 1_000;

export type CanvasDropReport = {
	nodes: string[];
	edges: string[];
	annotations: string[];
};

export function emptyCanvasBody(): CanvasBody {
	return {
		version: 1,
		nodes: [],
		edges: [],
		viewport: { x: 0, y: 0, zoom: 1 },
		annotations: [],
	};
}

// ── Reading ──────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readId(value: unknown): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= ID_MAX_CHARS
		? value
		: null;
}

function readPt(value: unknown): Pt | null {
	if (!isRecord(value)) return null;
	const x = finite(value.x);
	const y = finite(value.y);
	return x === null || y === null ? null : { x, y };
}

/** What a dropped entry is called in the report: its id, or `#<index>` when it has none. */
function dropName(value: unknown, index: number): string {
	const id = isRecord(value) ? readId(value.id) : null;
	return id ?? `#${index}`;
}

function readNode(value: unknown): StoredCanvasNode | null {
	if (!isRecord(value)) return null;
	const id = readId(value.id);
	const position = readPt(value.position);
	const type = value.type;
	if (id === null || position === null || !isBlockKind(type)) return null;
	// The kind's own schema decides: a node whose data is not that kind's is
	// dropped, and one whose `type` and `data.kind` disagree cannot parse.
	const data = BLOCK_DATA_SCHEMAS[type].safeParse(value.data);
	if (!data.success) return null;
	const node: StoredCanvasNode = { id, type, position, data: data.data };
	const parentId = readId(value.parentId);
	if (parentId !== null) node.parentId = parentId;
	const width = finite(value.width);
	if (width !== null && width > 0) node.width = width;
	const height = finite(value.height);
	if (height !== null && height > 0) node.height = height;
	return node;
}

/**
 * The frame structure of a set of nodes, made sound: a parent must be an
 * existing frame other than the node itself, no chain of parents may loop, and
 * a parent comes before its children (Svelte Flow needs that order). A child
 * whose frame is gone is taken out of the frame and KEPT, at the position it
 * was stored with — its stored position is all that is left to say where it is.
 * Linear time whatever the input: a board is user-editable JSON.
 */
function settleFrames(nodes: StoredCanvasNode[]): StoredCanvasNode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	for (const node of nodes) {
		if (node.parentId === undefined) continue;
		const parent = byId.get(node.parentId);
		if (!parent || parent.type !== "frame" || parent.id === node.id) {
			delete node.parentId;
		}
	}

	// Each node has at most one parent, so a loop is found by walking up until
	// something already seen turns up; the loop's earliest member (array order)
	// lets go of its parent.
	const order = new Map(nodes.map((node, index) => [node.id, index]));
	const settled = new Set<string>();
	for (const start of nodes) {
		if (settled.has(start.id)) continue;
		const path: StoredCanvasNode[] = [];
		const onPath = new Set<string>();
		let cursor: StoredCanvasNode | undefined = start;
		while (cursor && !settled.has(cursor.id) && !onPath.has(cursor.id)) {
			onPath.add(cursor.id);
			path.push(cursor);
			cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
		}
		if (cursor && onPath.has(cursor.id)) {
			const loop = path.slice(path.indexOf(cursor));
			let first = loop[0];
			for (const member of loop) {
				if ((order.get(member.id) ?? 0) < (order.get(first.id) ?? 0)) {
					first = member;
				}
			}
			delete first.parentId;
		}
		for (const node of path) settled.add(node.id);
	}

	return parentsFirst(nodes);
}

/**
 * Every parent ahead of its children, changing as little as possible: the very
 * same array when it is already in that order, otherwise each node's not yet
 * placed ancestors go in just before it. Svelte Flow needs parents first, and so
 * do the library's delete cascade and the saved body. One function for the body's
 * frame settling, the create parse and the board (RV-3 Minor 7 found it written
 * three times). A parent that is not in the list is not out of order, a loop
 * ends the walk instead of running it (nobody is placed twice or lost), and it
 * is linear time with no recursion, whatever the input: a board is user-editable
 * JSON.
 */
export function parentsFirst<T extends { id: string; parentId?: string }>(
	nodes: readonly T[],
): T[] {
	const byId = new Map<string, T>();
	for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
	const emitted = new Set<T>();
	const ordered: T[] = [];
	for (const node of nodes) {
		const pending: T[] = [];
		const onPath = new Set<T>();
		let cursor: T | undefined = node;
		while (cursor && !emitted.has(cursor) && !onPath.has(cursor)) {
			onPath.add(cursor);
			pending.push(cursor);
			cursor =
				cursor.parentId === undefined ? undefined : byId.get(cursor.parentId);
		}
		for (const ancestorFirst of pending.reverse()) {
			emitted.add(ancestorFirst);
			ordered.push(ancestorFirst);
		}
	}
	return ordered.every((placed, index) => placed === nodes[index])
		? (nodes as T[])
		: ordered;
}

function readEdge(value: unknown): CanvasEdge | null {
	if (!isRecord(value)) return null;
	const id = readId(value.id);
	const source = readId(value.source);
	const target = readId(value.target);
	if (id === null || source === null || target === null) return null;
	const edge: CanvasEdge = { id, source, target };
	if (
		typeof value.label === "string" &&
		value.label.length <= EDGE_LABEL_MAX_CHARS
	) {
		edge.label = value.label;
	}
	return edge;
}

/**
 * Thins a stroke to `max` points by DISTANCE along the path, not by index: a
 * pointer that lingered records hundreds of points in one spot and a fast
 * flick records a few, and thinning by index would keep the lingering and lose
 * the flick. Picks the recorded points nearest to evenly spaced marks along the
 * path, always keeps both ends, and never invents a point.
 */
export function decimateStroke(points: Pt[], max: number): Pt[] {
	if (points.length <= max) return points;
	const last = points.length - 1;
	const along = new Array<number>(points.length);
	along[0] = 0;
	for (let i = 1; i < points.length; i += 1) {
		along[i] =
			along[i - 1] +
			Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
	}
	const total = along[last];
	// A stroke that never moved is a dot: its two ends say all there is.
	if (total === 0) return [points[0], points[last]];
	const kept: Pt[] = [points[0]];
	let picked = 0;
	let cursor = 0;
	for (let mark = 1; mark < max - 1; mark += 1) {
		const target = (total * mark) / (max - 1);
		while (cursor < last && along[cursor + 1] < target) cursor += 1;
		const next = Math.min(cursor + 1, last);
		const nearest =
			target - along[cursor] <= along[next] - target ? cursor : next;
		if (nearest > picked && nearest < last) {
			kept.push(points[nearest]);
			picked = nearest;
		}
	}
	kept.push(points[last]);
	return kept;
}

function readAnnotation(value: unknown): Annotation | null {
	if (!isRecord(value)) return null;
	const id = readId(value.id);
	const kind = ANNOTATION_KINDS.find((known) => known === value.kind);
	const size = finite(value.size);
	if (
		id === null ||
		kind === undefined ||
		typeof value.color !== "string" ||
		value.color.length === 0 ||
		value.color.length > ANNOTATION_COLOR_MAX_CHARS ||
		size === null ||
		size <= 0 ||
		size > ANNOTATION_SIZE_MAX
	) {
		return null;
	}
	const annotation: Annotation = { id, kind, color: value.color, size };
	if (kind === "pen" || kind === "highlighter") {
		const points = (Array.isArray(value.points) ? value.points : [])
			.map(readPt)
			.filter((point): point is Pt => point !== null);
		if (points.length === 0) return null;
		annotation.points = decimateStroke(points, MAX_POINTS_PER_STROKE);
	} else if (kind === "text") {
		const at = readPt(value.at);
		if (
			at === null ||
			typeof value.text !== "string" ||
			value.text.length === 0 ||
			value.text.length > ANNOTATION_TEXT_MAX_CHARS
		) {
			return null;
		}
		annotation.at = at;
		annotation.text = value.text;
	} else {
		const from = readPt(value.from);
		const to = readPt(value.to);
		if (from === null || to === null) return null;
		annotation.from = from;
		annotation.to = to;
	}
	return annotation;
}

function readViewport(value: unknown): CanvasBody["viewport"] {
	const record = isRecord(value) ? value : {};
	const zoom = finite(record.zoom);
	return {
		x: finite(record.x) ?? 0,
		y: finite(record.y) ?? 0,
		zoom: zoom !== null && zoom > 0 ? zoom : 1,
	};
}

/**
 * Reads a board without trusting it. A stored snapshot is user-editable JSON
 * and can be a version behind, so this validates instead of throwing: what it
 * cannot read (an unknown block kind, data that is not its kind's, an edge to a
 * node that is not there, a duplicate id, an annotation past the cap) is
 * dropped and NAMED in `dropped`, and the rest of the board opens.
 *
 * One thing is repaired instead of dropped (RV-3 C1): a block whose own list
 * holds two entries with one id (a checklist's items, a photo block's pictures,
 * a web block's links) keeps every word and gets fresh ids for the later ones,
 * because the board draws those rows by id and two with one id would keep the
 * panel from ever opening. `repaired` names the blocks it did that to.
 */
export function normalizeCanvasBody(raw: unknown): {
	body: CanvasBody;
	dropped: CanvasDropReport;
	repaired: string[];
} {
	const dropped: CanvasDropReport = { nodes: [], edges: [], annotations: [] };
	const source = isRecord(raw) ? raw : {};

	const nodeIds = new Set<string>();
	const read: StoredCanvasNode[] = [];
	const repaired: string[] = [];
	(Array.isArray(source.nodes) ? source.nodes : []).forEach((value, index) => {
		const node = readNode(value);
		if (node === null) {
			dropped.nodes.push(dropName(value, index));
		} else if (nodeIds.has(node.id)) {
			dropped.nodes.push(node.id);
		} else {
			nodeIds.add(node.id);
			const unique = withUniqueEntryIds(node.data);
			if (unique.renamed.length > 0) {
				node.data = unique.data;
				repaired.push(node.id);
			}
			read.push(node);
		}
	});
	const nodes = settleFrames(read);

	const edgeIds = new Set<string>();
	const edges: CanvasEdge[] = [];
	(Array.isArray(source.edges) ? source.edges : []).forEach((value, index) => {
		const edge = readEdge(value);
		if (
			edge === null ||
			!nodeIds.has(edge.source) ||
			!nodeIds.has(edge.target) ||
			edgeIds.has(edge.id)
		) {
			dropped.edges.push(dropName(value, index));
			return;
		}
		edgeIds.add(edge.id);
		edges.push(edge);
	});

	const annotationIds = new Set<string>();
	const annotations: Annotation[] = [];
	(Array.isArray(source.annotations) ? source.annotations : []).forEach(
		(value, index) => {
			const annotation = readAnnotation(value);
			if (
				annotation === null ||
				annotationIds.has(annotation.id) ||
				annotations.length >= MAX_ANNOTATIONS_PER_BOARD
			) {
				dropped.annotations.push(dropName(value, index));
				return;
			}
			annotationIds.add(annotation.id);
			annotations.push(annotation);
		},
	);

	return {
		body: {
			version: 1,
			nodes,
			edges,
			viewport: readViewport(source.viewport),
			annotations,
		},
		dropped,
		repaired,
	};
}

// ── Writing ──────────────────────────────────────────────────────────────

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/** A geometry number, rounded so a pointer's float noise cannot move a hash; never NaN, never null. */
function geometry(value: unknown, fallback = 0): number {
	return typeof value === "number" && Number.isFinite(value)
		? round3(value)
		: fallback;
}

function canonicalPt(point: Pt): Pt {
	return { x: geometry(point?.x), y: geometry(point?.y) };
}

function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeysDeep);
	if (!isRecord(value)) return value;
	const sorted: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) {
		if (value[key] !== undefined) sorted[key] = sortKeysDeep(value[key]);
	}
	return sorted;
}

/**
 * A node's data in its kind's own key order (the schema's), with the library's
 * and the caller's extra keys gone. Data that no longer fits its kind is still
 * written, key-sorted, so this never throws and a save is never lost to it.
 */
function canonicalData(kind: string, data: unknown): unknown {
	if (isBlockKind(kind)) {
		const parsed = BLOCK_DATA_SCHEMAS[kind].safeParse(data);
		if (parsed.success) {
			const canonical = parsed.data;
			return canonical.kind === "frame"
				? {
						...canonical,
						width: geometry(canonical.width),
						height: geometry(canonical.height),
					}
				: canonical;
		}
	}
	return sortKeysDeep(data);
}

function canonicalNode(node: CanvasNode): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: node.id,
		type: node.type,
		position: canonicalPt(node.position),
	};
	if (node.parentId !== undefined) out.parentId = node.parentId;
	if (node.width !== undefined) out.width = geometry(node.width);
	if (node.height !== undefined) out.height = geometry(node.height);
	out.data = canonicalData(node.type, node.data);
	return out;
}

function canonicalEdge(edge: CanvasEdge): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: edge.id,
		source: edge.source,
		target: edge.target,
	};
	if (edge.label !== undefined) out.label = edge.label;
	return out;
}

function canonicalAnnotation(annotation: Annotation): Record<string, unknown> {
	const out: Record<string, unknown> = {
		id: annotation.id,
		kind: annotation.kind,
		color: annotation.color,
		size: geometry(annotation.size, 1),
	};
	if (annotation.points !== undefined) {
		out.points = annotation.points.map(canonicalPt);
	}
	if (annotation.from !== undefined) out.from = canonicalPt(annotation.from);
	if (annotation.to !== undefined) out.to = canonicalPt(annotation.to);
	if (annotation.at !== undefined) out.at = canonicalPt(annotation.at);
	if (annotation.text !== undefined) out.text = annotation.text;
	return out;
}

/**
 * The canonical persisted JSON (ruling 12) — the one string a version stores
 * and its hash is taken over. It is NOT `JSON.stringify(body)`:
 *
 * - keys in a fixed order: `version, nodes, edges, viewport, annotations`; a
 *   node `id, type, position, parentId, width, height, data`; an annotation
 *   `id, kind, color, size, points, from, to, at, text`; a node's data in its
 *   kind's schema order;
 * - the library's write-backs (`measured, selected, dragging, zIndex, extent,
 *   highlight`) are dropped, and an `undefined` optional is omitted, never
 *   `null`;
 * - geometry is finite and rounded to 3 decimals, so a pointer-derived
 *   `412.00000000000006` and a reloaded `412` are the same board;
 * - the camera IS included: a pan changes the string, which is why a pan is not
 *   saved by itself and why the client compares this output, not identity.
 */
export function boardJson(body: CanvasBody): string {
	return JSON.stringify({
		version: 1,
		nodes: body.nodes.map(canonicalNode),
		edges: body.edges.map(canonicalEdge),
		viewport: {
			x: geometry(body.viewport?.x),
			y: geometry(body.viewport?.y),
			zoom: Math.max(geometry(body.viewport?.zoom, 1), 0.001),
		},
		annotations: body.annotations.map(canonicalAnnotation),
	});
}
