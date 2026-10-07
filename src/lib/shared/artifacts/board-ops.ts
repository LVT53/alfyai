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
import { diffBoards } from "./board-diff";
import { FRAME_INSET, placeBlock } from "./board-placement";
import type { BoardRefusalReason } from "./board-refusals";
import { type CanvasBody, type CanvasNode, type Pt, ptSchema } from "./canvas";
import {
	BLOCK_DATA_SCHEMAS,
	type BlockKind,
	type CanvasBlockData,
	defaultNodeWidth,
	repeatedEntryIds,
} from "./canvas-blocks";
import { boardJson, MAX_BODY_BYTES, MAX_NODES_PER_BOARD } from "./canvas-body";
import {
	isModelCreatableKind,
	MODEL_CREATABLE_DATA_SCHEMAS,
	MODEL_CREATABLE_KINDS,
	modelCreatableBlockDataSchema,
	modelUpdatableFields,
	storedBlockData,
} from "./canvas-model-blocks";
import { mermaidSourceProblem } from "./mermaid-source";
import { plannedNodeSize } from "./node-size";
import type { OpRefusal, OpsJudgeContext, OpsVocabulary } from "./ops";

/** A batch is one transaction; 40 ops is already a whole board. */
export const MAX_OPS_PER_DIFF = 40;
/** One arrangement creates frames and blocks, not a board. */
export const MAX_NEW_NODES_PER_DIFF = 24;

// ── The schema the model is shown and the server parses ─────────────────

const idSchema = z.string().min(1).max(128);
const labelSchema = z.string().max(500);

const NEAR_DESCRIPTION =
	"The id of a block to put this one beside: to its right, else under it, in its frame if it has one. Leave position out when you use it.";

const boardOpSchema = z.discriminatedUnion("op", [
	z.object({
		op: z.literal("add_frame"),
		id: idSchema.describe("A new id you choose for the frame."),
		label: labelSchema.describe("The frame's title."),
		position: ptSchema
			.optional()
			.describe(
				"The frame's top-left corner, in board coordinates. Leave it out and the frame is placed on free ground.",
			),
		near: idSchema.optional().describe(NEAR_DESCRIPTION),
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
					`The block kind: one of ${MODEL_CREATABLE_KINDS.join(", ")} (mermaid is a flowchart or other diagram). It must equal data.kind.`,
				),
			parentId: idSchema
				.optional()
				.describe(
					"The id of a frame: the node then sits inside it and position is relative to the frame's top-left corner.",
				),
			position: ptSchema
				.optional()
				.describe(
					"Board coordinates, or relative to the frame's top-left corner when parentId is set. Leave it out and the block is placed for you: beside near, else in the next free place of its parentId frame (the frame grows to fit), else on free ground.",
				),
			near: idSchema.optional().describe(NEAR_DESCRIPTION),
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

// Declared in `board-refusals.ts` (the editor reads them without the vocabulary);
// the server and the tests reach them through here, as before.
export {
	BOARD_REFUSAL_REASONS,
	type BoardRefusalReason,
	refusalLabelKey,
} from "./board-refusals";

export type BoardRefusal = OpRefusal<BoardRefusalReason>;

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
						position: { x: op.position?.x ?? 0, y: op.position?.y ?? 0 },
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
				position: { x: position?.x ?? 0, y: position?.y ?? 0 },
				data: data as CanvasBlockData,
			};
			if (parentId !== undefined) added.parentId = parentId;
			if (data.kind === "frame") {
				// A frame's size is on the node and in its data; the two move together.
				added.width = data.width;
				added.height = data.height;
			} else {
				// The model has no width to give a block and is told how wide one is, so
				// it is stored: the board would otherwise draw it as wide as its words
				// run (RV-3 C2). The width is its kind's own: a chart's plot and a
				// checklist's rows need more than a note's (RC-3 N1). No height: a block
				// is as tall as its content.
				added.width = defaultNodeWidth(added.type);
			}
			return {
				...body,
				nodes: growFramesAround([...body.nodes, added], added),
			};
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

/**
 * A block added inside a frame never sticks out of it: when it would, the frame
 * grows (down and to the right, a margin past the block), and so does the frame
 * it is in, if it then sticks out of that. The judge only lets a block be added
 * where the ground it grows the frame into is free (`placeBlock`), so this is
 * the arithmetic of that decision and not a second one.
 */
function growFramesAround(
	nodes: CanvasNode[],
	added: CanvasNode,
): CanvasNode[] {
	let result = nodes;
	let child = added;
	for (let depth = 0; depth < 8 && child.parentId !== undefined; depth += 1) {
		const frame = result.find((node) => node.id === child.parentId);
		if (!frame || frame.data.kind !== "frame") break;
		const { width: childWidth, height: childHeight } = plannedNodeSize(child);
		const inside = plannedNodeSize(frame);
		const right = child.position.x + childWidth;
		const bottom = child.position.y + childHeight;
		const width =
			right > inside.width + 1 ? right + FRAME_INSET.x : inside.width;
		const height =
			bottom > inside.height + 1 ? bottom + FRAME_INSET.bottom : inside.height;
		if (width === inside.width && height === inside.height) break;
		const grown: CanvasNode = {
			...frame,
			width,
			height,
			data: { ...frame.data, width, height },
		};
		result = result.map((node) => (node.id === frame.id ? grown : node));
		child = grown;
	}
	return result;
}

// ── Judging a diff ───────────────────────────────────────────────────────

type Problem = { reason: BoardRefusalReason; id?: string; detail: string };
/** What judging one op came to: the board it leaves, and the op as it was applied (an add with its place settled), or why it was refused. */
type Step =
	| { ok: true; next: CanvasBody; op?: BoardOp }
	| { ok: false; problem: Problem };

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

/**
 * Blocks and arrows are listed together when the model reads a board, each under
 * its id, so a later op could not say which of two it means: an id is taken when
 * either has it (RV-3 Minor 5). A block is refused an arrow's id and an arrow a
 * block's, each saying which it clashes with.
 */
function takenByArrow(body: CanvasBody, id: string): Step | null {
	return body.edges.some((edge) => edge.id === id)
		? refuse(
				"duplicate_id",
				`"${id}" is already the id of an arrow, and blocks and arrows are read back under one list of ids; choose a new id for the block.`,
				id,
			)
		: null;
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

/**
 * A checklist whose items share an id cannot be drawn (its rows are keyed by
 * item id, and two with one id took the whole board down: RV-3 C1), so the
 * model is refused it, told which id and what to do. The stored schema cannot
 * say "unique" in the JSON Schema the model is shown, so this is the
 * validator's rule and the refusal is where the model learns it.
 */
function repeatedIdsProblem(data: CanvasBlockData): string | null {
	const repeated = repeatedEntryIds(data);
	if (repeated.length === 0) return null;
	const quoted = repeated.map((id) => `"${id}"`).join(", ");
	return `checklist item ids must be unique: ${quoted} ${repeated.length === 1 ? "is" : "are"} used more than once. Give every item its own id, for example "i1", "i2", "i3".`;
}

function exceedsByteCap(body: CanvasBody): boolean {
	return new TextEncoder().encode(boardJson(body)).length > MAX_BODY_BYTES;
}

/** An op that makes the board bigger is judged against the board it would leave. */
function grow(next: CanvasBody, id: string, op?: BoardOp): Step {
	return exceedsByteCap(next)
		? refuse(
				"limit_exceeded",
				"The board would be larger than it may be; make room by removing something first.",
				id,
			)
		: { ok: true, next, ...(op ? { op } : {}) };
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
	const arrowHasIt = takenByArrow(body, op.id);
	if (arrowHasIt) return arrowHasIt;
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
	const unknownNear = unknownNearProblem(body, op.near);
	if (unknownNear) return unknownNear;
	const limited = creationLimit(body, created, op.id);
	if (limited) return limited;
	// Where it goes is settled here, once: the op that lands names a place.
	const placed = placeBlock(body, {
		id: op.id,
		asFrame: true,
		size: { width: op.size.width, height: op.size.height },
		position: op.position,
		near: op.near,
	});
	const settled: BoardOp = {
		op: "add_frame",
		id: op.id,
		label: op.label,
		position: placed.position,
		size: op.size,
	};
	return grow(applyOp(body, settled), op.id, settled);
}

/** A `near` that names nothing on the board (or created earlier in this change) is an address that is wrong, like any other. */
function unknownNearProblem(
	body: CanvasBody,
	near: string | undefined,
): Step | null {
	if (near === undefined || findNode(body, near)) return null;
	return refuse(
		"unknown_id",
		`near names "${near}", and there is no node by that id on the board (or created earlier in this change). Node ids: ${idList(body.nodes.map((node) => node.id))}. Leave near out to have the block placed for you.`,
		near,
	);
}

function stepAddNode(
	op: Extract<BoardOp, { op: "add_node" }>,
	body: CanvasBody,
	created: number,
): Step {
	const spec = op.node;
	if (findNode(body, spec.id)) return duplicateNode(spec.id);
	const arrowHasIt = takenByArrow(body, spec.id);
	if (arrowHasIt) return arrowHasIt;
	if (!isModelCreatableKind(spec.type)) {
		return refuse(
			"unknown_kind",
			`"${spec.type}" is not a block you can add. Add one of: ${MODEL_CREATABLE_KINDS.join(", ")}.`,
			spec.id,
		);
	}
	const written = storedBlockData(spec.data);
	const data = MODEL_CREATABLE_DATA_SCHEMAS[spec.type].safeParse(written);
	if (!data.success) {
		const declared = isRecord(written) ? written.kind : undefined;
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
	// A chart's config was written as text above, so this is a block as it is stored.
	const block = data.data as CanvasBlockData;
	const repeated = repeatedIdsProblem(block);
	if (repeated !== null) return refuse("invalid_data", repeated, spec.id);
	if (data.data.kind === "mermaid") {
		const unsafe = mermaidSourceProblem(data.data.code);
		if (unsafe !== null) return refuse("invalid_data", unsafe, spec.id);
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
	const unknownNear = unknownNearProblem(body, spec.near);
	if (unknownNear) return unknownNear;
	const limited = creationLimit(body, created, spec.id);
	if (limited) return limited;
	// Where it goes is settled here, once: the op that lands names a place and a
	// frame, and no longer a `near`.
	const kind = block.kind;
	const size =
		block.kind === "frame"
			? { width: block.width, height: block.height }
			: plannedNodeSize({
					type: spec.type,
					width: defaultNodeWidth(spec.type),
					data: block,
				});
	const placed = placeBlock(body, {
		id: spec.id,
		asFrame: kind === "frame",
		size,
		position: spec.position,
		parentId: spec.parentId,
		near: spec.near,
	});
	const settled = {
		op: "add_node",
		node: {
			id: spec.id,
			type: spec.type,
			...(placed.parentId === undefined ? {} : { parentId: placed.parentId }),
			position: placed.position,
			data: written,
		},
	} as BoardOp;
	return grow(applyOp(body, settled), spec.id, settled);
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
	// A chart's config written as an object is the JSON text the block holds.
	const patch: Record<string, unknown> =
		target.type === "chart" && isRecord(op.data.code)
			? { ...op.data, code: JSON.stringify(op.data.code) }
			: op.data;
	const schema = BLOCK_DATA_SCHEMAS[target.type];
	const fields = Object.keys(schema.shape);
	const stray = Object.keys(patch).filter((key) => !fields.includes(key));
	if (stray.length > 0) {
		return refuse(
			"invalid_data",
			`A ${target.type} has no field ${stray.map((key) => `"${key}"`).join(", ")}. Fields of ${target.type}: ${fields.join(", ")}.`,
			op.id,
		);
	}
	// What the app vouches for is set by the app, never by an op (ruling 67).
	const settable = modelUpdatableFields(target.type);
	const owned = Object.keys(patch).filter(
		(key) => key !== "kind" && !settable.includes(key),
	);
	if (owned.length > 0) {
		return refuse(
			"invalid_data",
			`${owned.map((key) => `"${key}"`).join(", ")} on a ${target.type} ${owned.length === 1 ? "is" : "are"} set by the app (the Insert menu, Refresh, the screenshot it takes), never by an op. ${settable.length > 0 ? `You may change only: ${settable.join(", ")}.` : `You may change nothing on a ${target.type} block; you can still move it or remove it.`}`,
			op.id,
		);
	}
	if (target.type === "mermaid" && typeof patch.code === "string") {
		const unsafe = mermaidSourceProblem(patch.code);
		if (unsafe !== null) return refuse("invalid_data", unsafe, op.id);
	}
	// The merged data has to be a whole, valid block of the node's own kind.
	const merged = schema.safeParse({ ...target.data, ...patch });
	if (!merged.success) {
		return refuse(
			"invalid_data",
			`${issuesOf(merged.error)}. Fields of ${target.type}: ${fields.join(", ")}.`,
			op.id,
		);
	}
	const repeated = repeatedIdsProblem(merged.data);
	if (repeated !== null) return refuse("invalid_data", repeated, op.id);
	const settled: BoardOp = { ...op, data: patch };
	return grow(applyOp(body, settled), op.id, settled);
}

/**
 * The ids of the blocks the reader changed, moved or took into another frame
 * between the board the model last read and the board now. A block the reader
 * added after the read is not here (there was nothing to overwrite), and one
 * they removed is not either: an op naming it is refused as an unknown id.
 */
function changedSince(read: CanvasBody, now: CanvasBody): Set<string> {
	const delta = diffBoards(read, now);
	return new Set([
		...delta.changedNodes,
		...delta.movedNodes.map((moved) => moved.id),
		...delta.reparentedNodes,
	]);
}

/**
 * Ruling 67: Alfy never overwrites the reader's newer words. An op that would
 * change or destroy a block the reader changed after the model read the board
 * (an update, a move, a removal) is refused `stale`, and the rest of the batch
 * still applies. A highlight, and an arrow to or from the block, take nothing
 * from the reader, so they are not judged.
 */
function staleStep(op: BoardOp, staleIds: ReadonlySet<string>): Step | null {
	if (op.op !== "update_node" && op.op !== "move" && op.op !== "remove_node") {
		return null;
	}
	if (!staleIds.has(op.id)) return null;
	return refuse(
		"stale",
		`The reader changed "${op.id}" after you read the board, so this ${op.op} was not applied and their change stands. Call read_artifact to see the board as it is now, then send the change again if it still makes sense.`,
		op.id,
	);
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
			if (findNode(body, op.edge.id)) {
				return refuse(
					"duplicate_id",
					`"${op.edge.id}" is already the id of a block, and blocks and arrows are read back under one list of ids; choose a new id for the arrow.`,
					op.edge.id,
				);
			}
			for (const end of [op.edge.source, op.edge.target]) {
				if (!findNode(body, end)) return unknownNode(body, end);
			}
			if (op.edge.source === op.edge.target) {
				return refuse(
					"invalid_data",
					`An arrow joins two different blocks, and "${op.edge.source}" is both ends. Set source and target to two ids of blocks on the board.`,
					op.edge.id,
				);
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
	context?: OpsJudgeContext<CanvasBody>,
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
	const staleIds = context?.readDoc
		? changedSince(context.readDoc, body)
		: new Set<string>();
	let working = body;
	let created = 0;
	ops.forEach((op, index) => {
		let outcome: Step;
		try {
			outcome = staleStep(op, staleIds) ?? step(op, working, created);
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
		accepted.push(outcome.op ?? op);
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
	context?: { readBoard?: CanvasBody },
): { accepted: BoardOp[]; refused: BoardRefusal[] } {
	return validateOps(diff.ops, body, { readDoc: context?.readBoard });
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

// ── What the model is told about where its blocks went ─────────────────

/**
 * One block whose place the app had a hand in, as the model reads it after an
 * edit: where it is (`x`, `y`, in the frame it is in, if any), and when there is
 * more to say — it was moved off a taken place, the frame it asked for grew, or
 * there was no room and it is beside the frame — what that was. A block that
 * went exactly where the model said it should is not listed.
 */
export interface PlacedNote {
	id: string;
	x: number;
	y: number;
	in?: string;
	note?: string;
}

function addedId(op: BoardOp): string | undefined {
	if (op.op === "add_frame") return op.id;
	if (op.op === "add_node") return op.node?.id;
	return undefined;
}

function sizeIn(
	body: CanvasBody,
	id: string,
): { width: number; height: number } | null {
	const found = body.nodes.find((node) => node.id === id);
	return found ? plannedNodeSize(found) : null;
}

/**
 * Compares what the model asked for with what the judge settled: for every
 * accepted add, was the place its own, and did a frame grow to hold it. Pure; the
 * boards are the one the diff was judged against and the one it left. A block
 * that went where it was told, in a frame that did not grow, is not listed.
 */
export function placementNotes(
	before: CanvasBody,
	after: CanvasBody,
	asked: readonly BoardOp[],
	settled: readonly BoardOp[],
): PlacedNote[] {
	const askedById = new Map<string, BoardOp>();
	const askedFrameSize = new Map<string, { width: number; height: number }>();
	for (const op of asked) {
		const id = addedId(op);
		if (id === undefined) continue;
		askedById.set(id, op);
		if (op.op === "add_frame") askedFrameSize.set(id, op.size);
		if (op.op === "add_node" && op.node?.data?.kind === "frame") {
			askedFrameSize.set(id, op.node.data);
		}
	}
	const found: Array<{ entry: PlacedNote; silent: boolean }> = [];
	const lastInFrame = new Map<string, number>();
	for (const op of settled) {
		const id = addedId(op);
		const at =
			op.op === "add_frame"
				? op.position
				: op.op === "add_node"
					? op.node.position
					: undefined;
		if (id === undefined || !at) continue;
		const parent = op.op === "add_node" ? op.node.parentId : undefined;
		const asking = askedById.get(id);
		const given =
			asking?.op === "add_frame"
				? asking.position
				: asking?.op === "add_node"
					? asking.node.position
					: undefined;
		const askedParent =
			asking?.op === "add_node" ? asking.node.parentId : undefined;
		const near =
			asking?.op === "add_frame"
				? asking.near
				: asking?.op === "add_node"
					? asking.node.near
					: undefined;
		const nearParent = near
			? before.nodes.find((node) => node.id === near)?.parentId
			: undefined;
		const wantedFrame = askedParent ?? nearParent;
		const outside = wantedFrame !== undefined && parent !== wantedFrame;
		const adopted =
			wantedFrame === undefined && parent !== undefined && given !== undefined;
		const moved =
			given !== undefined &&
			!adopted &&
			!outside &&
			(given.x !== at.x || given.y !== at.y);
		const entry: PlacedNote = {
			id,
			x: at.x,
			y: at.y,
			...(parent === undefined ? {} : { in: parent }),
		};
		if (outside) {
			entry.note = `there was no room in "${wantedFrame}" and it could not grow: this is beside it, not in it`;
		} else if (moved) {
			entry.note = "that place was taken: moved to free ground";
		} else if (adopted) {
			entry.note = `its middle was over "${parent}", so it is in that frame`;
		}
		found.push({
			entry,
			silent: given !== undefined && !outside && !moved && !adopted,
		});
		if (parent !== undefined) lastInFrame.set(parent, found.length - 1);
	}
	// A frame that had to grow says so once, on the last block it grew for.
	for (const [frameId, index] of lastInFrame) {
		const was = sizeIn(before, frameId) ?? askedFrameSize.get(frameId);
		const now = sizeIn(after, frameId);
		if (!was || !now) continue;
		if (now.width > was.width || now.height > was.height) {
			const grew = `frame "${frameId}" grew to ${now.width}x${now.height} to hold it`;
			const mark = found[index];
			mark.entry.note = mark.entry.note ? `${mark.entry.note}; ${grew}` : grew;
			mark.silent = false;
		}
	}
	return found.filter((item) => !item.silent).map((item) => item.entry);
}

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
