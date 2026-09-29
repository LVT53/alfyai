// What the model sees of a Canvas, and what it is told when a Canvas call is
// refused (Feature 2 · Artifacts, Slice 3; decisions.md ruling 62). The three
// tools' Canvas handlers (create.ts, read.ts, edit.ts) are thin over this: it is
// pure — no database, no abort signal — so the eval harness (`scripts/eval-
// artifact-contracts/suites/canvas.ts`) reads the same payload and refuses with
// the same words the app does, rather than a copy of them.
//
// Three things live here:
//   - `canvasReadBlocks`: read_artifact's `blocks` for a board;
//   - `parseCanvasCreateBody`: what a create_artifact body becomes, judged by the
//     board's own vocabulary (`board-ops.ts`) so a made board and an edited one
//     accept exactly the same nodes — one validator, never a twin;
//   - `canvasEditFailureMessage` and `BLOCK_SHAPES_HINT`: the words for an edit
//     the board could not take at all. A refusal that names the fix (the valid
//     ops, the five blocks the model may add and their fields, the ids that
//     exist) is corrected in one step; one that only says no is guessed at.

import type { OpsEnvelopeResult } from "$lib/server/services/artifacts";
import {
	applyOp,
	BOARD_OP_NAMES,
	BOARD_REFUSAL_REASONS,
	type BoardOp,
	type BoardRefusalReason,
	MAX_NEW_NODES_PER_DIFF,
	MAX_OPS_PER_DIFF,
	validateBoardDiff,
} from "$lib/shared/artifacts/board-ops";
import type {
	CanvasBody,
	CanvasEdge,
	CanvasNode,
} from "$lib/shared/artifacts/canvas";
import { MODEL_CREATABLE_DATA_SCHEMAS } from "$lib/shared/artifacts/canvas-blocks";
import { emptyCanvasBody } from "$lib/shared/artifacts/canvas-body";
import type { OpRefusal } from "$lib/shared/artifacts/ops";

// ── What read_artifact shows ─────────────────────────────────────────────

/**
 * The footprint a node without a stored size is given: the same constants
 * `_lib/board.ts`'s `nodeRect` falls back to before the panel has measured it
 * (slice-3.md §The board `_lib` modules). A model arranging a board needs sizes
 * to keep notes from covering each other; a frame always carries its own.
 */
export const BOARD_NODE_WIDTH = 190;
export const BOARD_DEFAULT_NODE_HEIGHT = 84;

/** Enough of a note to know which one it is; `detail: "full"` has the rest. */
const LABEL_MAX_CHARS = 300;

function clip(text: string): string {
	const chars = Array.from(text);
	return chars.length > LABEL_MAX_CHARS
		? `${chars.slice(0, LABEL_MAX_CHARS - 1).join("")}…`
		: text;
}

/** A node's own words: what a reader would call it. */
function labelOf(node: CanvasNode): string {
	const data = node.data;
	switch (data.kind) {
		case "frame":
			return data.label;
		case "sticky":
		case "text":
			return clip(data.text);
		case "checklist":
		case "chart":
			return data.label ?? "";
		case "map":
			return data.route;
		case "file":
			return data.name;
		case "app":
			return data.title;
		case "photo":
			return data.items.length === 1
				? "1 photo"
				: `${data.items.length} photos`;
		case "liveweb":
			return data.query;
	}
}

function readNodeBlock(node: CanvasNode): Record<string, unknown> {
	const data = node.data;
	const frame = data.kind === "frame" ? data : null;
	return {
		id: node.id,
		kind: node.type,
		label: labelOf(node),
		x: node.position.x,
		y: node.position.y,
		width: node.width ?? frame?.width ?? BOARD_NODE_WIDTH,
		height: node.height ?? frame?.height ?? BOARD_DEFAULT_NODE_HEIGHT,
		...(node.parentId === undefined ? {} : { parentId: node.parentId }),
		...(data.kind === "sticky" ? { tone: data.tone } : {}),
		...(data.kind === "checklist"
			? {
					items: data.items.map((item) => ({
						id: item.id,
						text: clip(item.text),
						done: item.done,
					})),
				}
			: {}),
	};
}

function readEdgeBlock(edge: CanvasEdge): Record<string, unknown> {
	return {
		id: edge.id,
		kind: "edge",
		source: edge.source,
		target: edge.target,
		...(edge.label ? { label: edge.label } : {}),
	};
}

/**
 * read_artifact's `blocks` for a board: one entry per node in board order (a
 * frame before what is inside it), then one per edge. `x`/`y` are in the node's
 * own space — relative to its frame when it has a `parentId`, which is the space
 * `move` and `add_node` take — so what the model reads is what it writes back.
 * Everything an op must name is here: node and edge ids, a sticky's tone, a
 * checklist's item ids.
 */
export function canvasReadBlocks(body: CanvasBody): Record<string, unknown>[] {
	return [...body.nodes.map(readNodeBlock), ...body.edges.map(readEdgeBlock)];
}

// ── What a board must look like when it is made ──────────────────────────

const BLOCK_KINDS_PHRASE = (
	Object.keys(MODEL_CREATABLE_DATA_SCHEMAS) as Array<
		keyof typeof MODEL_CREATABLE_DATA_SCHEMAS
	>
)
	.map(
		(kind) =>
			`${kind}: ${Object.keys(MODEL_CREATABLE_DATA_SCHEMAS[kind].shape).join(", ")}`,
	)
	.join("; ");

/**
 * The five blocks the model may add and the fields of each one's `data`, read
 * off the schemas the validator parses with, so a refusal can never name a field
 * the block does not have. Appended to what a diff or a board that could not be
 * read is answered with, because a zod issue alone says what is wrong and not
 * what would have been right.
 */
export const BLOCK_SHAPES_HINT = `Blocks you can add, and the fields of their data — ${BLOCK_KINDS_PHRASE}. A sticky's tone is one of ${MODEL_CREATABLE_DATA_SCHEMAS.sticky.shape.tone.options.slice(0, -1).join(", ")} or ${MODEL_CREATABLE_DATA_SCHEMAS.sticky.shape.tone.options.at(-1)}; a checklist item is {id, text, done}; type must equal data.kind.`;

const CREATE_SHAPE_HINT = `A board is {"nodes":[{"id","type","position":{"x","y"},"data":{"kind",...}}],"edges":[{"id","source","target"}]}, or {} for an empty board. ${BLOCK_SHAPES_HINT}`;

/** At most this many problems are spelled out; a runaway list helps nobody. */
const MAX_PROBLEMS_SHOWN = 6;

type Origin = { list: "nodes" | "edges"; index: number; id: string };
type Problem = { origin: Origin | null; text: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isPoint(value: unknown): boolean {
	return (
		isRecord(value) &&
		typeof value.x === "number" &&
		Number.isFinite(value.x) &&
		typeof value.y === "number" &&
		Number.isFinite(value.y)
	);
}

/** The id an entry carries, for a message that has to name it. */
function nameOf(value: unknown): string {
	return isRecord(value) && typeof value.id === "string" ? value.id : "";
}

function describeValue(value: unknown): string {
	if (Array.isArray(value)) return "an array";
	if (value === null) return "null";
	return `a ${typeof value}`;
}

/** What is wrong with a node's shape, or `null`; its meaning is the vocabulary's to judge. */
function nodeShapeProblem(value: unknown): string | null {
	if (!isRecord(value)) {
		return `must be an object {id, type, position, data}, not ${describeValue(value)}.`;
	}
	const missing: string[] = [];
	if (!isText(value.id, 128))
		missing.push("id (a string of 1 to 128 characters)");
	if (!isText(value.type, 64)) missing.push("type (a block kind)");
	if (!isPoint(value.position))
		missing.push('position ({"x": number, "y": number})');
	if (!isRecord(value.data)) missing.push("data (an object with a kind)");
	if (value.parentId !== undefined && !isText(value.parentId, 128)) {
		missing.push("parentId (the id of a frame, or leave it out)");
	}
	return missing.length > 0 ? `needs ${missing.join(", ")}.` : null;
}

function edgeShapeProblem(value: unknown): string | null {
	if (!isRecord(value)) {
		return `must be an object {id, source, target}, not ${describeValue(value)}.`;
	}
	const missing: string[] = [];
	if (!isText(value.id, 128)) missing.push("id");
	if (!isText(value.source, 128)) missing.push("source (a node id)");
	if (!isText(value.target, 128)) missing.push("target (a node id)");
	if (
		value.label !== undefined &&
		!(typeof value.label === "string" && value.label.length <= 500)
	) {
		missing.push("label (a short string, or leave it out)");
	}
	return missing.length > 0 ? `needs ${missing.join(", ")}.` : null;
}

/** Frames before what is inside them; anything that cannot be placed (a loop, a missing parent) keeps its place so the validator names it. */
function parentsFirst(
	entries: Array<{ index: number; node: Record<string, unknown> }>,
): Array<{ index: number; node: Record<string, unknown> }> {
	const ids = new Set(entries.map((entry) => String(entry.node.id)));
	const placed = new Set<string>();
	const ordered: typeof entries = [];
	let pending = entries;
	while (pending.length > 0) {
		const ready = pending.filter((entry) => {
			const parent = entry.node.parentId;
			return (
				typeof parent !== "string" || !ids.has(parent) || placed.has(parent)
			);
		});
		if (ready.length === 0) {
			ordered.push(...pending);
			break;
		}
		for (const entry of ready) {
			ordered.push(entry);
			placed.add(String(entry.node.id));
		}
		const readySet = new Set(ready);
		pending = pending.filter((entry) => !readySet.has(entry));
	}
	return ordered;
}

function problemsMessage(problems: readonly Problem[]): string {
	const shown = problems.slice(0, MAX_PROBLEMS_SHOWN).map((problem) => {
		const where = problem.origin
			? `${problem.origin.list}[${problem.origin.index}]${problem.origin.id ? ` "${problem.origin.id}"` : ""}: `
			: "";
		return `- ${where}${problem.text}`;
	});
	const more = problems.length - shown.length;
	return [
		`Nothing was created: the board could not be made as written.`,
		...shown,
		...(more > 0 ? [`(+${more} more)`] : []),
		`Fix ${problems.length === 1 ? "it" : "them"} and call create_artifact again with the whole board, or make an empty board with body {} and add the blocks with edit_artifact.`,
	].join("\n");
}

export type CanvasCreateResult =
	| { ok: true; body: CanvasBody }
	| { ok: false; error: string };

/**
 * What a create_artifact `body` becomes. Empty, or `{}`, is an empty board;
 * otherwise `{ nodes, edges }`. Every node and edge is judged by the same
 * vocabulary an edit is (`validateBoardDiff` over a growing board), so a node the
 * model may not make, data that is not its kind's, a parent that is not a frame,
 * a duplicate id and an edge to nothing are each refused with the message the
 * edit tool would give — and refuse the WHOLE create: a board that is quietly
 * thinner than the one the model described is worse than one that says why it was
 * not made. Chunked (40 ops, 24 new nodes) only because that is the vocabulary's
 * unit; a made board may be larger than one change.
 */
export function parseCanvasCreateBody(raw: string): CanvasCreateResult {
	const text = raw.trim();
	if (text === "") return { ok: true, body: emptyCanvasBody() };

	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		const why = error instanceof Error ? error.message : "it could not be read";
		return {
			ok: false,
			error: `The body is not valid JSON (${why}). ${CREATE_SHAPE_HINT} If the JSON keeps failing, make an empty board with body {} and add the blocks with edit_artifact.`,
		};
	}
	if (!isRecord(value)) {
		return {
			ok: false,
			error: `The body must be a JSON object with "nodes" and "edges", not ${describeValue(value)}. ${CREATE_SHAPE_HINT}`,
		};
	}
	const stray = Object.keys(value).filter(
		(key) => key !== "nodes" && key !== "edges",
	);
	if (stray.length > 0) {
		return {
			ok: false,
			error: `A board has no field ${stray.map((key) => `"${key}"`).join(", ")}: it holds only "nodes" and "edges". ${CREATE_SHAPE_HINT}`,
		};
	}
	const nodes = value.nodes ?? [];
	const edges = value.edges ?? [];
	if (!Array.isArray(nodes) || !Array.isArray(edges)) {
		return {
			ok: false,
			error: `"nodes" and "edges" must each be an array. ${CREATE_SHAPE_HINT}`,
		};
	}

	const problems: Problem[] = [];
	const entries: Array<{ index: number; node: Record<string, unknown> }> = [];
	nodes.forEach((node, index) => {
		const shape = nodeShapeProblem(node);
		if (shape) {
			problems.push({
				origin: { list: "nodes", index, id: nameOf(node) },
				text: shape,
			});
		} else {
			entries.push({ index, node: node as Record<string, unknown> });
		}
	});

	// One op per node (frames included: `add_node` of type frame), then one per
	// edge, each remembering which entry of the body it came from.
	const ops: BoardOp[] = [];
	const origins: Origin[] = [];
	for (const entry of parentsFirst(entries)) {
		const { id, type, parentId, position, data } = entry.node;
		ops.push({
			op: "add_node",
			node: {
				id,
				type,
				...(parentId === undefined ? {} : { parentId }),
				position,
				data,
			},
		} as BoardOp);
		origins.push({ list: "nodes", index: entry.index, id: String(id) });
	}
	edges.forEach((edge, index) => {
		const shape = edgeShapeProblem(edge);
		if (shape) {
			problems.push({
				origin: { list: "edges", index, id: nameOf(edge) },
				text: shape,
			});
			return;
		}
		const { id, source, target, label } = edge as Record<string, unknown>;
		ops.push({
			op: "add_edge",
			edge: { id, source, target, ...(label === undefined ? {} : { label }) },
		} as BoardOp);
		origins.push({ list: "edges", index, id: String(id) });
	});
	if (problems.length > 0) {
		return {
			ok: false,
			error: `${problemsMessage(problems)}\n${CREATE_SHAPE_HINT}`,
		};
	}

	// The vocabulary judges a batch of at most 40 ops and 24 new nodes, against
	// the board the ops before it left behind.
	let board = emptyCanvasBody();
	let start = 0;
	while (start < ops.length) {
		let end = start;
		let created = 0;
		while (end < ops.length && end - start < MAX_OPS_PER_DIFF) {
			const isNode = ops[end].op === "add_node";
			if (isNode && created === MAX_NEW_NODES_PER_DIFF) break;
			if (isNode) created += 1;
			end += 1;
		}
		const chunk = ops.slice(start, end);
		const { accepted, refused } = validateBoardDiff(
			{ id: "create", summary: "Made the board", ops: chunk },
			board,
		);
		for (const refusal of refused) {
			problems.push({
				origin: origins[start + refusal.index],
				text: refusal.detail,
			});
		}
		for (const op of accepted) board = applyOp(board, op);
		start = end;
	}
	if (problems.length > 0) {
		return { ok: false, error: problemsMessage(problems) };
	}
	return { ok: true, body: board };
}

// ── What an edit the board could not take at all is answered with ────────

/**
 * The words for an edit `applyArtifactOps` refused as a whole (an op refused on
 * its own is answered per op, by the vocabulary's own detail). Each one says what
 * to do next: an unreadable diff names the valid ops and the blocks that may be
 * added; a conflict says to read the board again.
 */
export function canvasEditFailureMessage(
	failure: Extract<OpsEnvelopeResult, { ok: false }>,
): string {
	switch (failure.reason) {
		case "invalid_diff":
			return `The ops could not be read: ${failure.detail ?? "they do not match the schema"} ${BLOCK_SHAPES_HINT} Nothing was applied — fix that and send the whole change again.`;
		case "version_conflict":
			return "The board changed while this edit was being applied. Nothing was applied: call read_artifact to see it as it is now, then send the change again.";
		case "not_found":
			return "This board could not be found; it may have been deleted. Nothing was changed.";
		case "too_large":
			return "The change would make the board larger than it may be. Nothing was applied: remove something first, or send a smaller change.";
		case "unsupported_kind":
			return failure.detail ?? "This item cannot be changed with ops.";
	}
}

/** One refused op, as the model reads it: which op, what it addressed, why, and what would have worked. */
export interface BoardRefusalForModel {
	target?: string;
	reason: BoardRefusalReason;
	opIndex: number;
	detail: string;
}

export type CanvasEditOutcome =
	| { ok: true; applied: number; refused: BoardRefusalForModel[] }
	| { ok: false; error: string; refused: BoardRefusalForModel[] };

function isBoardRefusalReason(value: string): value is BoardRefusalReason {
	return (BOARD_REFUSAL_REASONS as readonly string[]).includes(value);
}

/**
 * What the model is told of a diff the board judged: the ops that landed, and per
 * refused op its own reason and detail. A batch in which nothing landed is a
 * FAILURE, not a success with zero applied — a model told `success: true` would
 * say the board changed — and it says so in a sentence that points at the
 * details. (A highlight lands without changing the board, and counts.)
 */
export function canvasEditOutcome(run: {
	applied: number;
	refused: readonly OpRefusal[];
}): CanvasEditOutcome {
	const refused: BoardRefusalForModel[] = run.refused.map((item) => ({
		...(item.id === undefined ? {} : { target: item.id }),
		reason: isBoardRefusalReason(item.reason) ? item.reason : "invalid_data",
		opIndex: item.index,
		detail: item.detail,
	}));
	if (run.applied === 0) {
		return {
			ok: false,
			error:
				"Nothing was changed: every op was refused. Each refusal below says what would have worked; fix those ops and send them again.",
			refused,
		};
	}
	return { ok: true, applied: run.applied, refused };
}

/**
 * What a Canvas edit that carried no ops is answered with: patches are a
 * Document's and Slides' word, a board takes ops — and the message names the ones
 * it takes.
 */
export function canvasOpsRequiredMessage(givenPatches: boolean): string {
	const names = BOARD_OP_NAMES.join(", ");
	return givenPatches
		? `Canvas boards take ops, not patches. Send ops: each op's "op" must be one of: ${names}.`
		: `Send ops: each op's "op" must be one of: ${names}.`;
}
