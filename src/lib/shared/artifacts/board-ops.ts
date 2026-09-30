/**
 * The Canvas's vocabulary for the shared ops mechanism (ruling 14): the eight
 * id-addressed ops a model or the panel may send, the one schema they are read
 * with, the rules a diff is judged by, and the pure step that applies one op.
 * It sits in `shared/` because the server validates with it and the board
 * animates with it; the generic half is `ops.ts`, and Slides' `deck-ops.ts` is
 * its twin.
 *
 * Ids are ADDRESSES, not hints: an op touching an id the board does not have
 * (and no earlier op of the same batch created) is refused, never guessed at,
 * and the rest of the batch still applies, so a partly-applied diff is still a
 * coherent board. Each op is judged against the board as the accepted ops
 * before it left it.
 *
 * What the model is SHOWN is what is parsed (ruling 62): `boardOpsArraySchema`
 * is the schema the edit tool advertises and the one the server validates with,
 * and every refusal names what would have been valid.
 */
import { z } from "zod";
import { type CanvasBody, type CanvasNode, type Pt, ptSchema } from "./canvas";
import {
	BLOCK_DATA_SCHEMAS,
	type BlockKind,
	type CanvasBlockData,
	isModelCreatableKind,
	MODEL_CREATABLE_DATA_SCHEMAS,
	MODEL_CREATABLE_KINDS,
	modelCreatableBlockDataSchema,
} from "./canvas-blocks";
import { boardJson, MAX_BODY_BYTES, MAX_NODES_PER_BOARD } from "./canvas-body";
import type { OpRefusal, OpsVocabulary } from "./ops";

/** A batch is one transaction; 40 ops is already a whole board. */
export const MAX_OPS_PER_DIFF = 40;
/** One arrangement creates frames and blocks, not a board. */
export const MAX_NEW_NODES_PER_DIFF = 24;

// ── The schema the model is shown and the server parses ─────────────────

const idSchema = z.string().min(1).max(128);
const labelSchema = z.string().max(500);

const boardOpSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("add_frame"),
		id: idSchema.describe("A new id you choose for the frame."),
		label: labelSchema.describe("The frame's title."),
		position: ptSchema.describe(
			"The frame's top-left corner, in board coordinates.",
		),
		size: z
			.object({ width: z.number().positive(), height: z.number().positive() })
			.describe("The frame's size, in board units."),
	}),
	z.object({
		op: z.literal("add_node"),
		node: z.object({
			id: idSchema.describe("A new id you choose for the node."),
			type: z
				.string()
				.min(1)
				.describe(
					`The block kind: one of ${MODEL_CREATABLE_KINDS.join(", ")}. It must equal data.kind.`,
				),
			parentId: idSchema
				.optional()
				.describe(
					"The id of a frame: the node then sits inside it and position is relative to the frame's top-left corner.",
				),
			position: ptSchema.describe(
				"Board coordinates, or relative to the frame's top-left corner when parentId is set.",
			),
			data: modelCreatableBlockDataSchema,
		}),
	}),
	z.object({
		op: z.literal("move"),
		id: idSchema.describe("The id of the node to move."),
		to: ptSchema.describe(
			"The new position, in the node's own space: relative to its frame for a node inside one.",
		),
	}),
	z.object({
		op: z.literal("add_edge"),
		edge: z.object({
			id: idSchema.describe("A new id you choose for the edge."),
			source: idSchema.describe("The id of the node the edge starts at."),
			target: idSchema.describe("The id of the node the edge ends at."),
			label: labelSchema.optional(),
		}),
	}),
	z.object({
		op: z.literal("remove_edge"),
		id: idSchema.describe("The id of the edge to remove."),
	}),
	z.object({
		op: z.literal("update_node"),
		id: idSchema.describe("The id of the node to change."),
		data: z
			.record(z.string(), z.unknown())
			.describe(
				"Only the fields to change; the node's other fields stay. The kind cannot change.",
			),
	}),
	z.object({
		op: z.literal("remove_node"),
		id: idSchema.describe(
			"The id of the node to remove. Its edges go with it; nodes inside it stay on the board.",
		),
	}),
	z.object({
		op: z.literal("highlight"),
		ids: z
			.array(idSchema)
			.min(1)
			.max(MAX_OPS_PER_DIFF)
			.describe("Node ids to point the reader at. Changes nothing."),
	}),
]);

export type BoardOp = z.infer<typeof boardOpSchema>;

/** The eight op names, read off the schema itself so a refusal can never name one the schema lacks. */
export const BOARD_OP_NAMES: readonly BoardOp["op"][] =
	boardOpSchema.options.map((option) => option.shape.op.value);

/** The `ops` the edit tool advertises and the server validates with: one schema, min 1, max 40. */
export const boardOpsArraySchema = z
	.array(boardOpSchema)
	.min(1)
	.max(MAX_OPS_PER_DIFF);

export const boardDiffSchema = z.object({
	id: z.string().min(1).max(100),
	/** One line: the version's summary and the change pill's label. */
	summary: z.string().min(1).max(200),
	ops: boardOpsArraySchema,
});

export type BoardDiff = z.infer<typeof boardDiffSchema>;

/**
 * One diff that is valid against the fixture board the tests use — the worked
 * example the edit tool's description carries, parsed through the executed
 * schema by a test so it can never drift from what is accepted.
 */
export const BOARD_OPS_EXAMPLE: BoardOp[] = [
	{
		op: "add_frame",
		id: "frame-sunday",
		label: "Sunday",
		position: { x: 40, y: 480 },
		size: { width: 360, height: 260 },
	},
	{
		op: "add_node",
		node: {
			id: "note-brunch",
			type: "sticky",
			parentId: "frame-sunday",
			position: { x: 20, y: 60 },
			data: { kind: "sticky", text: "Brunch at 10:30", tone: "yellow" },
		},
	},
	{ op: "move", id: "note-museum", to: { x: 500, y: 140 } },
	{
		op: "add_edge",
		edge: {
			id: "edge-brunch",
			source: "note-brunch",
			target: "note-museum",
			label: "then",
		},
	},
	{
		op: "update_node",
		id: "text-1",
		data: { text: "Weekend plan (updated)" },
	},
	{ op: "highlight", ids: ["frame-sunday"] },
];

// ── Refusals ─────────────────────────────────────────────────────────────

export const BOARD_REFUSAL_REASONS = [
	"unknown_id",
	"duplicate_id",
	"unknown_kind",
	"kind_mismatch",
	"missing_parent",
	"self_parent",
	"cycle",
	"invalid_data",
	"limit_exceeded",
] as const;

export type BoardRefusalReason = (typeof BOARD_REFUSAL_REASONS)[number];
export type BoardRefusal = OpRefusal<BoardRefusalReason>;

/** Every refusal reason has a message key; the switch is exhaustive so a new reason cannot ship without one. */
export function refusalLabelKey(reason: BoardRefusalReason): string {
	switch (reason) {
		case "unknown_id":
			return "artifacts.canvas.refusal.unknown_id";
		case "duplicate_id":
			return "artifacts.canvas.refusal.duplicate_id";
		case "unknown_kind":
			return "artifacts.canvas.refusal.unknown_kind";
		case "kind_mismatch":
			return "artifacts.canvas.refusal.kind_mismatch";
		case "missing_parent":
			return "artifacts.canvas.refusal.missing_parent";
		case "self_parent":
			return "artifacts.canvas.refusal.self_parent";
		case "cycle":
			return "artifacts.canvas.refusal.cycle";
		case "invalid_data":
			return "artifacts.canvas.refusal.invalid_data";
		case "limit_exceeded":
			return "artifacts.canvas.refusal.limit_exceeded";
		default: {
			const unreachable: never = reason;
			return unreachable;
		}
	}
}

// ── Applying one op ──────────────────────────────────────────────────────

/**
 * One accepted op → the mutated board. Pure: the board it is handed is never
 * touched. A highlight changes nothing on the board (it is what the reader is
 * pointed at for a moment), so it answers the board it was given.
 *
 * Removing a node takes its edges with it and lets go of what sat inside it: a
 * child of a removed frame is not deleted with it — it moves up to the frame's
 * own parent (or to the board) and keeps its place on screen, because a frame
 * removed to tidy up should not take a reader's notes with it.
 */
export function applyOp(body: CanvasBody, op: BoardOp): CanvasBody {
	switch (op.op) {
		case "add_frame":
			return {
				...body,
				nodes: [
					...body.nodes,
					{
						id: op.id,
						type: "frame",
						position: { x: op.position.x, y: op.position.y },
						width: op.size.width,
						height: op.size.height,
						data: {
							kind: "frame",
							label: op.label,
							width: op.size.width,
							height: op.size.height,
						},
					},
				],
			};
		case "add_node": {
			const { id, type, parentId, position, data } = op.node;
			const added: CanvasNode = {
				id,
				type: type as BlockKind,
				position: { x: position.x, y: position.y },
				data: data as CanvasBlockData,
			};
			if (parentId !== undefined) added.parentId = parentId;
			// A frame's size is on the node and in its data; the two move together.
			if (data.kind === "frame") {
				added.width = data.width;
				added.height = data.height;
			}
			return { ...body, nodes: [...body.nodes, added] };
		}
		case "move":
			return {
				...body,
				nodes: body.nodes.map((node) =>
					node.id === op.id
						? { ...node, position: { x: op.to.x, y: op.to.y } }
						: node,
				),
			};
		case "add_edge":
			return { ...body, edges: [...body.edges, { ...op.edge }] };
		case "remove_edge":
			return { ...body, edges: body.edges.filter((edge) => edge.id !== op.id) };
		case "update_node":
			return {
				...body,
				nodes: body.nodes.map((node) => {
					if (node.id !== op.id) return node;
					const data = { ...node.data, ...op.data } as CanvasBlockData;
					return data.kind === "frame"
						? { ...node, data, width: data.width, height: data.height }
						: { ...node, data };
				}),
			};
		case "remove_node": {
			const removed = body.nodes.find((node) => node.id === op.id);
			if (!removed) return body;
			const nodes = body.nodes
				.filter((node) => node.id !== op.id)
				.map((node) => {
					if (node.parentId !== op.id) return node;
					const { parentId: _gone, ...rest } = node;
					return {
						...rest,
						...(removed.parentId !== undefined
							? { parentId: removed.parentId }
							: {}),
						position: {
							x: node.position.x + removed.position.x,
							y: node.position.y + removed.position.y,
						},
					};
				});
			return {
				...body,
				nodes,
				edges: body.edges.filter(
					(edge) => edge.source !== op.id && edge.target !== op.id,
				),
			};
		}
		case "highlight":
			return body;
	}
}

// ── Judging a diff ───────────────────────────────────────────────────────

type Problem = { reason: BoardRefusalReason; id?: string; detail: string };
type Step = { ok: true; next: CanvasBody } | { ok: false; problem: Problem };

function refuse(reason: BoardRefusalReason, detail: string, id?: string): Step {
	return {
		ok: false,
		problem: { reason, detail, ...(id === undefined ? {} : { id }) },
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

const HINT_IDS_SHOWN = 20;

/** "a, b, c (+12 more)": enough ids for a model to pick one that exists. */
function idList(ids: readonly string[]): string {
	if (ids.length === 0) return "none";
	const shown = ids.slice(0, HINT_IDS_SHOWN).join(", ");
	return ids.length > HINT_IDS_SHOWN
		? `${shown} (+${ids.length - HINT_IDS_SHOWN} more)`
		: shown;
}

function findNode(body: CanvasBody, id: string): CanvasNode | undefined {
	return body.nodes.find((node) => node.id === id);
}

function unknownNode(body: CanvasBody, id: string): Step {
	return refuse(
		"unknown_id",
		`There is no node "${id}" on the board (or created earlier in this change). Node ids: ${idList(body.nodes.map((node) => node.id))}.`,
		id,
	);
}

function duplicateNode(id: string): Step {
	return refuse(
		"duplicate_id",
		`A node "${id}" already exists (on the board or earlier in this change); choose a new id.`,
		id,
	);
}

/** A zod issue list, short and pointed: where, and what was wrong. */
function issuesOf(error: z.ZodError): string {
	return error.issues
		.slice(0, 3)
		.map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`)
		.join("; ");
}

function fieldsOf(kind: BlockKind): string {
	return Object.keys(BLOCK_DATA_SCHEMAS[kind].shape).join(", ");
}

function exceedsByteCap(body: CanvasBody): boolean {
	return new TextEncoder().encode(boardJson(body)).length > MAX_BODY_BYTES;
}

/** An op that makes the board bigger is judged against the board it would leave. */
function grow(next: CanvasBody, id: string): Step {
	return exceedsByteCap(next)
		? refuse(
				"limit_exceeded",
				"The board would be larger than it may be; make room by removing something first.",
				id,
			)
		: { ok: true, next };
}

function creationLimit(
	body: CanvasBody,
	created: number,
	id: string,
): Step | null {
	if (created >= MAX_NEW_NODES_PER_DIFF) {
		return refuse(
			"limit_exceeded",
			`One change may add at most ${MAX_NEW_NODES_PER_DIFF} nodes; send the rest in a second change.`,
			id,
		);
	}
	if (body.nodes.length >= MAX_NODES_PER_BOARD) {
		return refuse(
			"limit_exceeded",
			`The board already holds the most it can (${MAX_NODES_PER_BOARD} nodes); remove nodes it does not need first.`,
			id,
		);
	}
	return null;
}

/** Whether giving `parentId` to the new node `id` would close a loop through frames already on the board. */
function closesLoop(body: CanvasBody, id: string, parentId: string): boolean {
	const seen = new Set<string>();
	let cursor: string | undefined = parentId;
	while (cursor !== undefined) {
		if (cursor === id || seen.has(cursor)) return true;
		seen.add(cursor);
		cursor = findNode(body, cursor)?.parentId;
	}
	return false;
}

function stepAddFrame(
	op: Extract<BoardOp, { op: "add_frame" }>,
	body: CanvasBody,
	created: number,
): Step {
	if (findNode(body, op.id)) return duplicateNode(op.id);
	const data = MODEL_CREATABLE_DATA_SCHEMAS.frame.safeParse({
		kind: "frame",
		label: op.label,
		width: op.size?.width,
		height: op.size?.height,
	});
	if (!data.success) {
		return refuse(
			"invalid_data",
			`${issuesOf(data.error)}. A frame needs a label and a size with width and height above 0.`,
			op.id,
		);
	}
	return creationLimit(body, created, op.id) ?? grow(applyOp(body, op), op.id);
}

function stepAddNode(
	op: Extract<BoardOp, { op: "add_node" }>,
	body: CanvasBody,
	created: number,
): Step {
	const spec = op.node;
	if (findNode(body, spec.id)) return duplicateNode(spec.id);
	if (!isModelCreatableKind(spec.type)) {
		return refuse(
			"unknown_kind",
			`"${spec.type}" is not a block you can add. Add one of: ${MODEL_CREATABLE_KINDS.join(", ")}.`,
			spec.id,
		);
	}
	const data = MODEL_CREATABLE_DATA_SCHEMAS[spec.type].safeParse(spec.data);
	if (!data.success) {
		const declared = isRecord(spec.data) ? spec.data.kind : undefined;
		if (typeof declared === "string" && declared !== spec.type) {
			return refuse(
				"kind_mismatch",
				`type is "${spec.type}" but data.kind is "${declared}": they must be the same kind.`,
				spec.id,
			);
		}
		return refuse(
			"invalid_data",
			`${issuesOf(data.error)}. Fields of ${spec.type}: ${fieldsOf(spec.type)}.`,
			spec.id,
		);
	}
	if (spec.parentId !== undefined) {
		if (spec.parentId === spec.id) {
			return refuse(
				"self_parent",
				"A node cannot be inside itself. Set parentId to another frame's id, or leave it out.",
				spec.id,
			);
		}
		const parent = findNode(body, spec.parentId);
		if (!parent || parent.type !== "frame") {
			const frames = body.nodes
				.filter((node) => node.type === "frame")
				.map((node) => node.id);
			return refuse(
				"missing_parent",
				`parentId "${spec.parentId}" is not a frame on the board. Frames: ${idList(frames)}. A frame created in this change must come earlier in the list than what goes inside it.`,
				spec.id,
			);
		}
		if (closesLoop(body, spec.id, spec.parentId)) {
			return refuse(
				"cycle",
				`A frame cannot sit inside a frame that is inside it ("${spec.parentId}"). Set parentId to another frame's id, or leave it out.`,
				spec.id,
			);
		}
	}
	return (
		creationLimit(body, created, spec.id) ?? grow(applyOp(body, op), spec.id)
	);
}

function stepUpdateNode(
	op: Extract<BoardOp, { op: "update_node" }>,
	body: CanvasBody,
): Step {
	const target = findNode(body, op.id);
	if (!target) return unknownNode(body, op.id);
	if (!isRecord(op.data)) {
		return refuse(
			"invalid_data",
			`data must be an object with the fields to change. Fields of ${target.type}: ${fieldsOf(target.type)}.`,
			op.id,
		);
	}
	if ("kind" in op.data && op.data.kind !== target.type) {
		return refuse(
			"kind_mismatch",
			`"${op.id}" is a ${target.type}; a block cannot change kind in place. Remove it and add the new one: remove_node, then add_node.`,
			op.id,
		);
	}
	const schema = BLOCK_DATA_SCHEMAS[target.type];
	const fields = Object.keys(schema.shape);
	const stray = Object.keys(op.data).filter((key) => !fields.includes(key));
	if (stray.length > 0) {
		return refuse(
			"invalid_data",
			`A ${target.type} has no field ${stray.map((key) => `"${key}"`).join(", ")}. Fields of ${target.type}: ${fields.join(", ")}.`,
			op.id,
		);
	}
	// The merged data has to be a whole, valid block of the node's own kind.
	const merged = schema.safeParse({ ...target.data, ...op.data });
	if (!merged.success) {
		return refuse(
			"invalid_data",
			`${issuesOf(merged.error)}. Fields of ${target.type}: ${fields.join(", ")}.`,
			op.id,
		);
	}
	return grow(applyOp(body, op), op.id);
}

function step(op: BoardOp, body: CanvasBody, created: number): Step {
	switch (op.op) {
		case "add_frame":
			return stepAddFrame(op, body, created);
		case "add_node":
			return stepAddNode(op, body, created);
		case "move":
			return findNode(body, op.id)
				? { ok: true, next: applyOp(body, op) }
				: unknownNode(body, op.id);
		case "add_edge": {
			if (body.edges.some((edge) => edge.id === op.edge.id)) {
				return refuse(
					"duplicate_id",
					`An edge "${op.edge.id}" already exists; choose a new id.`,
					op.edge.id,
				);
			}
			for (const end of [op.edge.source, op.edge.target]) {
				if (!findNode(body, end)) return unknownNode(body, end);
			}
			return grow(applyOp(body, op), op.edge.id);
		}
		case "remove_edge":
			return body.edges.some((edge) => edge.id === op.id)
				? { ok: true, next: applyOp(body, op) }
				: refuse(
						"unknown_id",
						`There is no edge "${op.id}" on the board. Edge ids: ${idList(body.edges.map((edge) => edge.id))}.`,
						op.id,
					);
		case "update_node":
			return stepUpdateNode(op, body);
		case "remove_node":
			return findNode(body, op.id)
				? { ok: true, next: applyOp(body, op) }
				: unknownNode(body, op.id);
		case "highlight": {
			if (op.ids.length === 0) {
				return refuse("invalid_data", "highlight needs at least one node id.");
			}
			const missing = op.ids.find((id) => !findNode(body, id));
			return missing === undefined
				? { ok: true, next: body }
				: unknownNode(body, missing);
		}
	}
}

/** The id an op addresses, for a refusal that has to name one. */
function targetOf(op: BoardOp): string | undefined {
	switch (op.op) {
		case "add_frame":
		case "move":
		case "remove_edge":
		case "update_node":
		case "remove_node":
			return op.id;
		case "add_node":
			return op.node?.id;
		case "add_edge":
			return op.edge?.id;
		case "highlight":
			return op.ids?.[0];
	}
}

function validateOps(
	ops: readonly BoardOp[],
	body: CanvasBody,
): { accepted: BoardOp[]; refused: BoardRefusal[] } {
	const refusalFor = (
		op: BoardOp,
		index: number,
		problem: Problem,
	): BoardRefusal => {
		const id = problem.id ?? targetOf(op);
		return {
			index,
			op: String(op?.op),
			...(id === undefined ? {} : { id }),
			reason: problem.reason,
			detail: problem.detail,
		};
	};

	// A runaway batch is not partly applied.
	if (ops.length > MAX_OPS_PER_DIFF) {
		return {
			accepted: [],
			refused: ops.map((op, index) =>
				refusalFor(op, index, {
					reason: "limit_exceeded",
					detail: `One change may hold at most ${MAX_OPS_PER_DIFF} ops; nothing was applied. Send fewer.`,
				}),
			),
		};
	}

	const accepted: BoardOp[] = [];
	const refused: BoardRefusal[] = [];
	let working = body;
	let created = 0;
	ops.forEach((op, index) => {
		let outcome: Step;
		try {
			outcome = step(op, working, created);
		} catch {
			// A direct caller can hand this an op the schema never saw.
			outcome = refuse("invalid_data", "The op could not be read.");
		}
		if (!outcome.ok) {
			refused.push(refusalFor(op, index, outcome.problem));
			return;
		}
		working = outcome.next;
		if (op.op === "add_frame" || op.op === "add_node") created += 1;
		accepted.push(op);
	});
	return { accepted, refused };
}

/**
 * Server-side validation. Returns the ops that apply, in order, plus one
 * refusal per rejected op so the model can react. The rules: a batch over
 * `MAX_OPS_PER_DIFF` is refused whole; then, op by op against the board as the
 * accepted ops before it left it — a duplicate id, an id the board lacks, a
 * block kind the model may not add, data that is not the kind's, a parent that
 * is not an earlier frame (or is the node itself, or would loop), and a board
 * that would pass its caps.
 */
export function validateBoardDiff(
	diff: BoardDiff,
	body: CanvasBody,
): { accepted: BoardOp[]; refused: BoardRefusal[] } {
	return validateOps(diff.ops, body);
}

export const boardOpsVocabulary: OpsVocabulary<
	CanvasBody,
	BoardOp,
	BoardRefusalReason
> = {
	opNames: BOARD_OP_NAMES,
	diffSchema: boardDiffSchema,
	validate: validateOps,
	apply: applyOp,
};

// ── What a client animates with ─────────────────────────────────────────

/** Everything except the position moves, which the board tweens. */
export function structuralOps(diff: { ops: readonly BoardOp[] }): BoardOp[] {
	return diff.ops.filter((op) => op.op !== "move");
}

export function moveOps(diff: {
	ops: readonly BoardOp[];
}): { id: string; to: Pt }[] {
	const moves: { id: string; to: Pt }[] = [];
	for (const op of diff.ops) {
		if (op.op === "move") moves.push({ id: op.id, to: op.to });
	}
	return moves;
}

/** The ids the diff points the reader at, once each, in the order they were named. */
export function highlightedIds(diff: { ops: readonly BoardOp[] }): string[] {
	const ids = new Set<string>();
	for (const op of diff.ops) {
		if (op.op === "highlight") for (const id of op.ids) ids.add(id);
	}
	return [...ids];
}
