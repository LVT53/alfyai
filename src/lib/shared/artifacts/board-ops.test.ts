import { describe, expect, it } from "vitest";
import { z } from "zod";
import artifactsDict from "$lib/i18n/artifacts";
import {
	applyOp,
	BOARD_OP_NAMES,
	BOARD_OPS_EXAMPLE,
	BOARD_REFUSAL_REASONS,
	type BoardDiff,
	type BoardOp,
	boardDiffSchema,
	boardOpsArraySchema,
	boardOpsVocabulary,
	highlightedIds,
	MAX_NEW_NODES_PER_DIFF,
	MAX_OPS_PER_DIFF,
	moveOps,
	refusalLabelKey,
	structuralOps,
	validateBoardDiff,
} from "./board-ops";
import type { CanvasBody, CanvasNode } from "./canvas";
import { NODE_WIDTH } from "./canvas-blocks";
import { boardJson, MAX_BODY_BYTES, MAX_NODES_PER_BOARD } from "./canvas-body";
import { sampleBoard } from "./canvas-fixtures.test-helpers";
import { runOps } from "./ops";

function diff(...ops: BoardOp[]): BoardDiff {
	return { id: "diff-1", summary: "Rearranged the board", ops };
}

/** A diff that never went through the schema: what a direct caller could hand the validator. */
function unchecked(...ops: unknown[]): BoardDiff {
	return diff(...(ops as BoardOp[]));
}

function addSticky(id: string, extra: Record<string, unknown> = {}): BoardOp {
	return {
		op: "add_node",
		node: {
			id,
			type: "sticky",
			position: { x: 10, y: 10 },
			data: { kind: "sticky", text: "hello", tone: "yellow" },
			...extra,
		},
	} as BoardOp;
}

function addFrame(id: string): BoardOp {
	return {
		op: "add_frame",
		id,
		label: id,
		position: { x: 0, y: 0 },
		size: { width: 200, height: 150 },
	};
}

function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) deepFreeze(child);
		Object.freeze(value);
	}
	return value;
}

function node(body: CanvasBody, id: string): CanvasNode {
	const found = body.nodes.find((n) => n.id === id);
	if (!found) throw new Error(`no node ${id}`);
	return found;
}

/** Validate then apply, the way the shared mechanism does. */
function land(body: CanvasBody, ...ops: BoardOp[]) {
	const run = runOps(boardOpsVocabulary, body, diff(...ops));
	if (!run.ok) throw new Error(run.detail);
	return run;
}

function fillBoard(count: number, text = "x"): CanvasBody {
	const body = sampleBoard();
	body.nodes = Array.from({ length: count }, (_, i) => ({
		id: `n${i}`,
		type: "sticky" as const,
		position: { x: i, y: 0 },
		data: { kind: "sticky" as const, text, tone: "plain" as const },
	}));
	body.edges = [];
	body.annotations = [];
	return body;
}

describe("validateBoardDiff — ids are addresses, not hints", () => {
	it("refuses an op touching an id the board does not have, applies the rest, and names the id", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
				{ op: "move", id: "text-1", to: { x: 2, y: 2 } },
			),
			sampleBoard(),
		);
		expect(refused).toEqual([
			expect.objectContaining({
				index: 0,
				op: "move",
				id: "ghost",
				reason: "unknown_id",
			}),
		]);
		expect(accepted).toEqual([
			{ op: "move", id: "text-1", to: { x: 2, y: 2 } },
		]);
	});

	it("returns one refusal per rejected op, in batch order, and accounts for every op", () => {
		const ops: BoardOp[] = [
			{ op: "remove_node", id: "ghost-a" },
			{ op: "move", id: "text-1", to: { x: 5, y: 5 } },
			{ op: "update_node", id: "ghost-b", data: { text: "x" } },
			{ op: "remove_edge", id: "ghost-c" },
			{ op: "highlight", ids: ["text-1"] },
		];
		const { accepted, refused } = validateBoardDiff(
			diff(...ops),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.op, r.reason])).toEqual([
			[0, "remove_node", "unknown_id"],
			[2, "update_node", "unknown_id"],
			[3, "remove_edge", "unknown_id"],
		]);
		expect(accepted.length + refused.length).toBe(ops.length);
		expect(refused.every((r) => r.detail.length > 0)).toBe(true);
	});

	it("accepts an op touching an id the same batch created earlier", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				addSticky("new-1"),
				{ op: "move", id: "new-1", to: { x: 50, y: 50 } },
				{
					op: "add_edge",
					edge: { id: "edge-new", source: "new-1", target: "text-1" },
				},
				{ op: "update_node", id: "new-1", data: { text: "changed" } },
				{ op: "highlight", ids: ["new-1", "text-1"] },
			),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(5);
	});

	it("refuses a later op naming an id an earlier op in the batch removed", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				{ op: "remove_node", id: "text-1" },
				{ op: "move", id: "text-1", to: { x: 1, y: 1 } },
				{ op: "update_node", id: "text-1", data: { text: "x" } },
				{
					op: "add_edge",
					edge: { id: "edge-x", source: "note-museum", target: "text-1" },
				},
				{ op: "highlight", ids: ["text-1"] },
			),
			sampleBoard(),
		);
		expect(accepted).toHaveLength(1);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[1, "unknown_id"],
			[2, "unknown_id"],
			[3, "unknown_id"],
			[4, "unknown_id"],
		]);
	});

	it("does not let a refused op create anything: a later op naming its id is refused too", () => {
		const { refused } = validateBoardDiff(
			unchecked(
				{
					op: "add_node",
					node: {
						id: "m9",
						type: "map",
						position: { x: 0, y: 0 },
						data: {},
					},
				},
				{ op: "move", id: "m9", to: { x: 1, y: 1 } },
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "unknown_kind"],
			[1, "unknown_id"],
		]);
	});

	it("handles the empty diff: nothing accepted, nothing refused, and the schema will not take it", () => {
		expect(validateBoardDiff(diff(), sampleBoard())).toEqual({
			accepted: [],
			refused: [],
		});
		expect(
			boardDiffSchema.safeParse({ id: "d", summary: "s", ops: [] }).success,
		).toBe(false);
	});

	it("refuses a highlight naming an id the board lacks, and one that names none", () => {
		const { refused } = validateBoardDiff(
			unchecked(
				{ op: "highlight", ids: ["text-1", "ghost"] },
				{ op: "highlight", ids: [] },
			),
			sampleBoard(),
		);
		expect(refused).toEqual([
			expect.objectContaining({
				index: 0,
				reason: "unknown_id",
				id: "ghost",
			}),
			expect.objectContaining({ index: 1, reason: "invalid_data" }),
		]);
	});

	it("names a way forward for an unknown id: the ids that are on the board", () => {
		const { refused } = validateBoardDiff(
			diff({ op: "move", id: "ghost", to: { x: 0, y: 0 } }),
			sampleBoard(),
		);
		expect(refused[0].detail).toContain("text-1");
	});
});

describe("validateBoardDiff — duplicates", () => {
	it("refuses creating an id the board already has, and two creations of one id in a batch", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				addSticky("text-1"),
				addSticky("fresh"),
				addSticky("fresh"),
				addFrame("frame-a"),
				addFrame("frame-new"),
				addFrame("frame-new"),
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason, r.id])).toEqual([
			[0, "duplicate_id", "text-1"],
			[2, "duplicate_id", "fresh"],
			[3, "duplicate_id", "frame-a"],
			[5, "duplicate_id", "frame-new"],
		]);
		expect(accepted).toHaveLength(2);
	});

	it("refuses an edge id the board already has, and allows an id to come back after its node was removed", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				{
					op: "add_edge",
					edge: { id: "edge-1", source: "text-1", target: "note-1" },
				},
				{ op: "remove_node", id: "text-1" },
				addSticky("text-1"),
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "duplicate_id"],
		]);
		expect(accepted).toHaveLength(2);
	});

	it("refuses an edge to a node that is not there, naming the missing end", () => {
		const { refused } = validateBoardDiff(
			diff(
				{
					op: "add_edge",
					edge: { id: "e-a", source: "ghost", target: "text-1" },
				},
				{
					op: "add_edge",
					edge: { id: "e-b", source: "text-1", target: "phantom" },
				},
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.reason, r.id])).toEqual([
			["unknown_id", "ghost"],
			["unknown_id", "phantom"],
		]);
	});
});

describe("validateBoardDiff — what a block may be (ruling 64)", () => {
	const mapData = sampleBoard().nodes.find((n) => n.id === "map-1")?.data;

	it("refuses an add_node of a kind the model cannot mint, as unknown_kind naming the five it may add", () => {
		for (const type of ["map", "file", "app", "photo", "liveweb", "banana"]) {
			const { accepted, refused } = validateBoardDiff(
				unchecked({
					op: "add_node",
					node: {
						id: "x1",
						type,
						position: { x: 0, y: 0 },
						data: type === "map" ? mapData : { kind: type },
					},
				}),
				sampleBoard(),
			);
			expect(accepted).toEqual([]);
			expect(refused[0]).toMatchObject({
				index: 0,
				op: "add_node",
				id: "x1",
				reason: "unknown_kind",
			});
			expect(refused[0].detail).toContain(
				"frame, sticky, text, checklist, chart",
			);
		}
	});

	it("refuses a type and a data.kind that disagree as kind_mismatch", () => {
		const { refused } = validateBoardDiff(
			unchecked({
				op: "add_node",
				node: {
					id: "x1",
					type: "text",
					position: { x: 0, y: 0 },
					data: { kind: "sticky", text: "t", tone: "plain" },
				},
			}),
			sampleBoard(),
		);
		expect(refused[0].reason).toBe("kind_mismatch");
	});

	it("refuses data that is not its kind's, naming the field and the fields the kind has", () => {
		const { refused } = validateBoardDiff(
			unchecked(
				{
					op: "add_node",
					node: {
						id: "a",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text: "t", tone: "neon" },
					},
				},
				{
					op: "add_node",
					node: {
						id: "b",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", content: "typo", tone: "plain" },
					},
				},
				{
					op: "add_node",
					node: {
						id: "c",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: "x",
					},
				},
				{
					op: "add_node",
					node: {
						id: "d",
						type: "checklist",
						position: { x: 0, y: 0 },
						data: { kind: "checklist", items: [{ id: "i", text: "t" }] },
					},
				},
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "invalid_data"],
			[1, "invalid_data"],
			[2, "invalid_data"],
			[3, "invalid_data"],
		]);
		expect(refused[0].detail).toContain("tone");
		expect(refused[1].detail).toContain("content");
		expect(refused[1].detail).toContain("text, tone");
		expect(refused[3].detail).toContain("done");
	});

	it("validates an add_frame's label and size", () => {
		const { refused } = validateBoardDiff(
			unchecked(
				{
					op: "add_frame",
					id: "f1",
					label: "ok",
					position: { x: 0, y: 0 },
					size: { width: 0, height: 100 },
				},
				{
					op: "add_frame",
					id: "f2",
					label: "x".repeat(600),
					position: { x: 0, y: 0 },
					size: { width: 100, height: 100 },
				},
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.reason, r.id])).toEqual([
			["invalid_data", "f1"],
			["invalid_data", "f2"],
		]);
	});

	it("refuses an update_node that would change the kind, and one that names a field the kind does not have", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				{ op: "update_node", id: "note-museum", data: { kind: "text" } },
				{
					op: "update_node",
					id: "note-museum",
					data: { kind: "sticky", text: "ok" },
				},
				{ op: "update_node", id: "text-1", data: { tone: "plain" } },
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "kind_mismatch"],
			[2, "invalid_data"],
		]);
		expect(refused[1].detail).toContain("text");
		expect(accepted).toHaveLength(1);
	});

	it("validates an update_node against the node's own full schema: merged data must still be that kind's", () => {
		const { refused } = validateBoardDiff(
			unchecked(
				{ op: "update_node", id: "note-museum", data: { tone: "neon" } },
				{
					op: "update_node",
					id: "todo-1",
					data: { items: [{ id: "i", text: 3 }] },
				},
				{ op: "update_node", id: "chart-1", data: { code: "" } },
				{ op: "update_node", id: "note-museum", data: "text" },
				{ op: "update_node", id: "note-museum", data: ["text"] },
			),
			sampleBoard(),
		);
		expect(refused.map((r) => r.reason)).toEqual([
			"invalid_data",
			"invalid_data",
			"invalid_data",
			"invalid_data",
			"invalid_data",
		]);
	});

	it("lets update_node work on a kind the model cannot create, but only within that kind's own schema", () => {
		const { accepted, refused } = validateBoardDiff(
			unchecked(
				{ op: "update_node", id: "map-1", data: { label: "Saturday's route" } },
				{ op: "update_node", id: "map-1", data: { map: { garbage: true } } },
				{
					op: "update_node",
					id: "photo-1",
					data: {
						items: [
							{ id: "p", imageUrl: "https://evil.example/p.png?d=secret" },
						],
					},
				},
				{
					op: "update_node",
					id: "web-1",
					data: {
						sources: [
							{
								id: "s",
								title: "t",
								url: "javascript:alert(1)",
								provider: "p",
								authorityClass: "c",
								authorityScore: 1,
								publishedAt: null,
								updatedAt: null,
							},
						],
					},
				},
			),
			sampleBoard(),
		);
		expect(accepted).toHaveLength(1);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[1, "invalid_data"],
			[2, "invalid_data"],
			[3, "invalid_data"],
		]);
	});
});

describe("validateBoardDiff — frames", () => {
	it("puts a node inside a frame that is on the board, or one the batch created earlier", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				addSticky("in-existing", { parentId: "frame-a" }),
				addFrame("frame-new"),
				addSticky("in-new", { parentId: "frame-new" }),
			),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(3);
	});

	it("refuses a child whose frame is created LATER in the same batch: parents come before children", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				addSticky("early", { parentId: "frame-late" }),
				addFrame("frame-late"),
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "missing_parent"],
		]);
		expect(accepted).toEqual([addFrame("frame-late")]);
	});

	it("refuses a parent that is not a frame, or not there", () => {
		const { refused } = validateBoardDiff(
			diff(
				addSticky("a", { parentId: "text-1" }),
				addSticky("b", { parentId: "nowhere" }),
			),
			sampleBoard(),
		);
		expect(refused.map((r) => r.reason)).toEqual([
			"missing_parent",
			"missing_parent",
		]);
		expect(refused[1].detail).toContain("frame-a");
	});

	it("refuses a frame parented to itself", () => {
		const { refused } = validateBoardDiff(
			unchecked({
				op: "add_node",
				node: {
					id: "loop",
					type: "frame",
					parentId: "loop",
					position: { x: 0, y: 0 },
					data: { kind: "frame", label: "L", width: 100, height: 100 },
				},
			}),
			sampleBoard(),
		);
		expect(refused[0].reason).toBe("self_parent");
	});

	it("refuses a frame parented to its own descendant", () => {
		// A board that was never normalised: a frame that already names the
		// frame about to be created as its own parent.
		const body = sampleBoard();
		body.nodes.push({
			id: "inner",
			type: "frame",
			parentId: "outer",
			position: { x: 0, y: 0 },
			data: { kind: "frame", label: "inner", width: 50, height: 50 },
		});
		const { refused } = validateBoardDiff(
			unchecked({
				op: "add_node",
				node: {
					id: "outer",
					type: "frame",
					parentId: "inner",
					position: { x: 0, y: 0 },
					data: { kind: "frame", label: "outer", width: 100, height: 100 },
				},
			}),
			body,
		);
		expect(refused[0].reason).toBe("cycle");
	});

	it("allows a frame inside a frame", () => {
		const { refused } = validateBoardDiff(
			unchecked({
				op: "add_node",
				node: {
					id: "nested",
					type: "frame",
					parentId: "frame-a",
					position: { x: 5, y: 5 },
					data: { kind: "frame", label: "Nested", width: 100, height: 80 },
				},
			}),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
	});
});

describe("validateBoardDiff — limits", () => {
	it("refuses a whole batch over the op cap, without applying part of it", () => {
		const ops = Array.from(
			{ length: MAX_OPS_PER_DIFF + 1 },
			(): BoardOp => ({ op: "move", id: "text-1", to: { x: 1, y: 1 } }),
		);
		const { accepted, refused } = validateBoardDiff(
			diff(...ops),
			sampleBoard(),
		);
		expect(accepted).toEqual([]);
		expect(refused).toHaveLength(ops.length);
		expect(refused.every((r) => r.reason === "limit_exceeded")).toBe(true);
		expect(refused.map((r) => r.index)).toEqual(ops.map((_, i) => i));
	});

	it("refuses the nodes that would take the board past its node cap, and keeps the ones that fit", () => {
		const body = fillBoard(MAX_NODES_PER_BOARD - 1);
		const { accepted, refused } = validateBoardDiff(
			diff(addSticky("fits"), addSticky("too-many")),
			body,
		);
		expect(accepted).toHaveLength(1);
		expect(refused).toEqual([
			expect.objectContaining({
				index: 1,
				id: "too-many",
				reason: "limit_exceeded",
			}),
		]);
	});

	it("refuses the creations past the per-batch cap", () => {
		const ops = Array.from({ length: MAX_NEW_NODES_PER_DIFF + 1 }, (_, i) =>
			addSticky(`new-${i}`),
		);
		const { accepted, refused } = validateBoardDiff(
			diff(...ops),
			sampleBoard(),
		);
		expect(accepted).toHaveLength(MAX_NEW_NODES_PER_DIFF);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[MAX_NEW_NODES_PER_DIFF, "limit_exceeded"],
		]);
	});

	it("does not count an edge, a move or an update against the per-batch node cap", () => {
		const ops: BoardOp[] = [
			...Array.from({ length: MAX_NEW_NODES_PER_DIFF }, (_, i) =>
				addSticky(`n-${i}`),
			),
			{ op: "add_edge", edge: { id: "e1", source: "n-0", target: "n-1" } },
			{ op: "move", id: "n-0", to: { x: 9, y: 9 } },
			{ op: "update_node", id: "n-1", data: { text: "again" } },
		];
		const { refused } = validateBoardDiff(diff(...ops), sampleBoard());
		expect(refused).toEqual([]);
	});

	it("refuses the op that would take the board past its byte cap", () => {
		const body = fillBoard(0);
		const big = "x".repeat(20_000);
		let index = 0;
		while (
			new TextEncoder().encode(boardJson(body)).length <
			MAX_BODY_BYTES - 15_000
		) {
			body.nodes.push({
				id: `fat-${index}`,
				type: "sticky",
				position: { x: index, y: 0 },
				data: { kind: "sticky", text: big, tone: "plain" },
			});
			index += 1;
		}
		const { accepted, refused } = validateBoardDiff(
			diff(
				addSticky("small"),
				{
					op: "add_node",
					node: {
						id: "huge",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "sticky", text: big, tone: "plain" },
					},
				},
				{ op: "move", id: "small", to: { x: 3, y: 3 } },
			),
			body,
		);
		expect(refused.map((r) => [r.index, r.id, r.reason])).toEqual([
			[1, "huge", "limit_exceeded"],
		]);
		expect(accepted).toHaveLength(2);
	});
});

describe("applyOp — one accepted op, purely", () => {
	it("returns a new board and leaves the one it was handed alone", () => {
		const body = deepFreeze(sampleBoard());
		const ops: BoardOp[] = [
			addSticky("s1"),
			addFrame("f1"),
			{ op: "move", id: "text-1", to: { x: 1, y: 2 } },
			{
				op: "add_edge",
				edge: { id: "e2", source: "text-1", target: "note-1" },
			},
			{ op: "remove_edge", id: "edge-1" },
			{ op: "update_node", id: "text-1", data: { text: "changed" } },
			{ op: "remove_node", id: "text-1" },
			{ op: "highlight", ids: ["note-1"] },
		];
		for (const op of ops) {
			const next = applyOp(body, op);
			// A highlight changes nothing on the board, so it answers the board itself.
			if (op.op === "highlight") expect(next).toBe(body);
			else expect(next).not.toBe(body);
		}
		expect(body.nodes).toHaveLength(sampleBoard().nodes.length);
	});

	it("adds a node on top and a frame with its size on the node and in its data", () => {
		const body = applyOp(
			applyOp(sampleBoard(), addSticky("s1", { parentId: "frame-a" })),
			addFrame("f1"),
		);
		expect(body.nodes.at(-2)).toMatchObject({
			id: "s1",
			type: "sticky",
			parentId: "frame-a",
			position: { x: 10, y: 10 },
		});
		expect(body.nodes.at(-1)).toMatchObject({
			id: "f1",
			type: "frame",
			position: { x: 0, y: 0 },
			width: 200,
			height: 150,
			data: { kind: "frame", label: "f1", width: 200, height: 150 },
		});
	});

	it("gives a frame made with add_node the size its data says", () => {
		const body = applyOp(sampleBoard(), {
			op: "add_node",
			node: {
				id: "f2",
				type: "frame",
				position: { x: 1, y: 1 },
				data: { kind: "frame", label: "Two", width: 320, height: 240 },
			},
		} as BoardOp);
		expect(node(body, "f2")).toMatchObject({ width: 320, height: 240 });
	});

	it("moves a node in its own space and touches nothing else", () => {
		const before = sampleBoard();
		const after = applyOp(before, {
			op: "move",
			id: "note-1",
			to: { x: 70, y: 80 },
		});
		expect(node(after, "note-1").position).toEqual({ x: 70, y: 80 });
		expect(node(after, "note-1").parentId).toBe("frame-a");
		expect(node(after, "text-1")).toEqual(node(before, "text-1"));
	});

	it("merges an update into the node's data, and keeps a frame's size in step with its data", () => {
		const after = applyOp(sampleBoard(), {
			op: "update_node",
			id: "frame-a",
			data: { label: "Sunday", width: 500 },
		});
		expect(node(after, "frame-a").data).toEqual({
			kind: "frame",
			label: "Sunday",
			width: 500,
			height: 300,
		});
		expect(node(after, "frame-a")).toMatchObject({ width: 500, height: 300 });
		const sticky = applyOp(sampleBoard(), {
			op: "update_node",
			id: "note-museum",
			data: { text: "Museum, 15:00" },
		});
		expect(node(sticky, "note-museum").data).toEqual({
			kind: "sticky",
			text: "Museum, 15:00",
			tone: "mint",
		});
	});

	it("removes a node and the edges that touched it", () => {
		const after = applyOp(sampleBoard(), { op: "remove_node", id: "text-1" });
		expect(after.nodes.some((n) => n.id === "text-1")).toBe(false);
		expect(after.edges).toEqual([]);
	});

	it("takes a removed frame's children out of it and keeps them where they were on the board", () => {
		const after = applyOp(sampleBoard(), { op: "remove_node", id: "frame-a" });
		const child = node(after, "note-1");
		expect(child).not.toHaveProperty("parentId");
		// The frame sat at (40, 40) and the child at (20, 60) inside it.
		expect(child.position).toEqual({ x: 60, y: 100 });
	});

	it("hands a removed frame's children to the frame above it", () => {
		const body = sampleBoard();
		body.nodes = [
			{
				id: "outer",
				type: "frame",
				position: { x: 10, y: 10 },
				data: { kind: "frame", label: "outer", width: 500, height: 500 },
			},
			{
				id: "inner",
				type: "frame",
				parentId: "outer",
				position: { x: 20, y: 20 },
				data: { kind: "frame", label: "inner", width: 200, height: 200 },
			},
			{
				id: "leaf",
				type: "sticky",
				parentId: "inner",
				position: { x: 5, y: 5 },
				data: { kind: "sticky", text: "leaf", tone: "plain" },
			},
		];
		body.edges = [];
		const after = applyOp(body, { op: "remove_node", id: "inner" });
		expect(node(after, "leaf")).toMatchObject({
			parentId: "outer",
			position: { x: 25, y: 25 },
		});
	});

	it("adds and removes an edge, and leaves the board alone for a highlight", () => {
		const added = applyOp(sampleBoard(), {
			op: "add_edge",
			edge: { id: "e2", source: "text-1", target: "note-1", label: "back" },
		});
		expect(added.edges.at(-1)).toEqual({
			id: "e2",
			source: "text-1",
			target: "note-1",
			label: "back",
		});
		expect(applyOp(added, { op: "remove_edge", id: "e2" }).edges).toEqual(
			sampleBoard().edges,
		);
		expect(
			applyOp(sampleBoard(), { op: "highlight", ids: ["text-1"] }),
		).toEqual(sampleBoard());
	});

	it("gives the same board applying a batch as it does applying its accepted ops one by one", () => {
		const ops: BoardOp[] = [
			addFrame("day"),
			addSticky("plan", { parentId: "day" }),
			{ op: "move", id: "note-museum", to: { x: 400, y: 400 } },
			{
				op: "add_edge",
				edge: { id: "e9", source: "plan", target: "note-museum" },
			},
			{ op: "remove_node", id: "text-1" },
		];
		const run = land(sampleBoard(), ...ops);
		let stepwise = sampleBoard();
		for (const op of ops) stepwise = applyOp(stepwise, op);
		expect(boardJson(run.doc)).toBe(boardJson(stepwise));
		expect(run.refused).toEqual([]);
	});
});

describe("the helpers a client animates with", () => {
	const mixed = diff(
		addSticky("s1"),
		{ op: "move", id: "text-1", to: { x: 1, y: 2 } },
		{ op: "highlight", ids: ["s1", "text-1"] },
		{ op: "move", id: "note-museum", to: { x: 3, y: 4 } },
		{ op: "highlight", ids: ["text-1", "note-museum"] },
	);

	it("separates the structural ops from the moves the board tweens", () => {
		expect(structuralOps(mixed).map((op) => op.op)).toEqual([
			"add_node",
			"highlight",
			"highlight",
		]);
		expect(moveOps(mixed)).toEqual([
			{ id: "text-1", to: { x: 1, y: 2 } },
			{ id: "note-museum", to: { x: 3, y: 4 } },
		]);
	});

	it("reports the highlighted ids once each, in the order they were named", () => {
		expect(highlightedIds(mixed)).toEqual(["s1", "text-1", "note-museum"]);
		expect(highlightedIds(diff(addSticky("s2")))).toEqual([]);
	});
});

describe("what the model is shown is what the validator parses (ruling 62)", () => {
	it("derives the op names from the schema itself", () => {
		expect([...BOARD_OP_NAMES]).toEqual([
			"add_frame",
			"add_node",
			"move",
			"add_edge",
			"remove_edge",
			"update_node",
			"remove_node",
			"highlight",
		]);
	});

	it("takes between one and forty ops", () => {
		const move: BoardOp = { op: "move", id: "a", to: { x: 0, y: 0 } };
		expect(boardOpsArraySchema.safeParse([]).success).toBe(false);
		expect(boardOpsArraySchema.safeParse([move]).success).toBe(true);
		expect(
			boardOpsArraySchema.safeParse(Array.from({ length: 40 }, () => move))
				.success,
		).toBe(true);
		expect(
			boardOpsArraySchema.safeParse(Array.from({ length: 41 }, () => move))
				.success,
		).toBe(false);
		expect(MAX_OPS_PER_DIFF).toBe(40);
	});

	it("refuses an op name it does not have at the op, and a missing field at the field", () => {
		const unknownOp = boardOpsArraySchema.safeParse([
			{ op: "move_node", id: "a" },
		]);
		expect(unknownOp.success).toBe(false);
		expect(unknownOp.error?.issues[0].path).toEqual([0, "op"]);
		const missing = boardOpsArraySchema.safeParse([{ op: "move", id: "a" }]);
		expect(missing.error?.issues[0].path).toEqual([0, "to"]);
	});

	it("advertises the five kinds the model may add — and not the five it may not — in the one schema it validates with", () => {
		const advertised = JSON.stringify(z.toJSONSchema(boardOpsArraySchema));
		for (const kind of ["frame", "sticky", "text", "checklist", "chart"]) {
			expect(advertised).toContain(`"const":"${kind}"`);
		}
		for (const kind of ["map", "file", "app", "photo", "liveweb"]) {
			expect(advertised).not.toContain(`"const":"${kind}"`);
		}
		for (const name of BOARD_OP_NAMES)
			expect(advertised).toContain(`"const":"${name}"`);
		expect(advertised).toContain('"maxItems":40');
		// Where an op needs a word of explanation, the schema carries it.
		expect(advertised).toContain("description");
	});

	it("refuses, in the schema itself, data of a kind the model may not add and a field a block does not have", () => {
		const bad = (data: unknown) =>
			boardOpsArraySchema.safeParse([
				{
					op: "add_node",
					node: { id: "x", type: "map", position: { x: 0, y: 0 }, data },
				},
			]).success;
		expect(bad({ kind: "map" })).toBe(false);
		expect(
			bad({ kind: "sticky", text: "t", tone: "plain", content: "typo" }),
		).toBe(false);
		expect(bad({ kind: "sticky", text: "t", tone: "plain" })).toBe(true);
	});

	it("parses the worked example through the executed schema and lands every op on a real board", () => {
		expect(boardOpsArraySchema.safeParse(BOARD_OPS_EXAMPLE).success).toBe(true);
		const wire = JSON.parse(JSON.stringify(BOARD_OPS_EXAMPLE));
		expect(boardOpsArraySchema.safeParse(wire).success).toBe(true);
		const run = land(sampleBoard(), ...BOARD_OPS_EXAMPLE);
		expect(run.refused).toEqual([]);
		expect(run.applied).toBe(BOARD_OPS_EXAMPLE.length);
	});

	it("hands the mechanism the same schema it advertises", () => {
		expect(boardOpsVocabulary.diffSchema).toBe(boardDiffSchema);
		expect(
			boardDiffSchema.safeParse({
				id: "d",
				summary: "s",
				ops: BOARD_OPS_EXAMPLE,
			}).success,
		).toBe(true);
		expect([...boardOpsVocabulary.opNames]).toEqual([...BOARD_OP_NAMES]);
	});

	it("names the valid ops when a diff cannot be read at all", () => {
		const run = runOps(boardOpsVocabulary, sampleBoard(), {
			id: "d",
			summary: "s",
			ops: [{ op: "move_node", id: "a", to: { x: 1, y: 1 } }],
		});
		if (run.ok) throw new Error("expected a refusal");
		expect(run.reason).toBe("invalid_diff");
		for (const name of BOARD_OP_NAMES) expect(run.detail).toContain(name);
	});
});

describe("refusal messages", () => {
	it("maps every refusal reason to a message key that exists in English and Hungarian", () => {
		expect([...BOARD_REFUSAL_REASONS].sort()).toEqual(
			[
				"cycle",
				"duplicate_id",
				"invalid_data",
				"kind_mismatch",
				"limit_exceeded",
				"missing_parent",
				"self_parent",
				"stale",
				"unknown_id",
				"unknown_kind",
			].sort(),
		);
		for (const reason of BOARD_REFUSAL_REASONS) {
			const key = refusalLabelKey(reason);
			expect(key).toBe(`artifacts.canvas.refusal.${reason}`);
			expect(artifactsDict.en).toHaveProperty([key]);
			expect(artifactsDict.hu).toHaveProperty([key]);
		}
	});
});

// Ruling 62: a wrong guess is corrected in one step, so no refusal the model
// reads may stop at "no". Each case is the refusal the model would get, and what
// it must contain to be acted on (the ids that exist, the kinds it may add, the
// fields of the kind, or what to do instead).
describe("every refusal names what would have worked (ruling 62)", () => {
	function refusalOf(body: CanvasBody, ...ops: unknown[]): string {
		const { refused } = validateBoardDiff(unchecked(...ops), body);
		expect(refused).toHaveLength(1);
		return refused[0].detail;
	}

	const CASES: Array<[string, () => string, RegExp[]]> = [
		[
			"unknown_id (a node)",
			() =>
				refusalOf(sampleBoard(), {
					op: "move",
					id: "nope",
					to: { x: 1, y: 1 },
				}),
			[/Node ids: .*note-1/],
		],
		[
			"unknown_id (an edge)",
			() => refusalOf(sampleBoard(), { op: "remove_edge", id: "nope" }),
			[/Edge ids: .*edge-1/],
		],
		[
			"duplicate_id",
			() => refusalOf(sampleBoard(), addSticky("note-1")),
			[/choose a new id/],
		],
		[
			"unknown_kind",
			() =>
				refusalOf(sampleBoard(), {
					op: "add_node",
					node: {
						id: "m",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
				}),
			[/frame, sticky, text, checklist, chart/],
		],
		[
			"kind_mismatch (add_node)",
			() =>
				refusalOf(sampleBoard(), {
					op: "add_node",
					node: {
						id: "k",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "text", text: "t" },
					},
				}),
			[/same kind/],
		],
		[
			"kind_mismatch (update_node)",
			() =>
				refusalOf(sampleBoard(), {
					op: "update_node",
					id: "note-1",
					data: { kind: "text" },
				}),
			[/cannot change kind in place/, /remove_node/, /add_node/],
		],
		[
			"missing_parent",
			() => refusalOf(sampleBoard(), addSticky("p", { parentId: "nowhere" })),
			[/Frames: .*frame-a/, /earlier/],
		],
		[
			"self_parent",
			() =>
				refusalOf(sampleBoard(), {
					op: "add_node",
					node: {
						id: "loop",
						type: "frame",
						parentId: "loop",
						position: { x: 0, y: 0 },
						data: { kind: "frame", label: "L", width: 100, height: 100 },
					},
				}),
			[/parentId/],
		],
		[
			"cycle",
			() => {
				const body = sampleBoard();
				body.nodes.push({
					id: "inner",
					type: "frame",
					parentId: "outer",
					position: { x: 0, y: 0 },
					data: { kind: "frame", label: "inner", width: 50, height: 50 },
				});
				return refusalOf(body, {
					op: "add_node",
					node: {
						id: "outer",
						type: "frame",
						parentId: "inner",
						position: { x: 0, y: 0 },
						data: { kind: "frame", label: "outer", width: 100, height: 100 },
					},
				});
			},
			[/parentId/],
		],
		[
			"invalid_data (a field the block does not have)",
			() =>
				refusalOf(sampleBoard(), {
					op: "update_node",
					id: "note-1",
					data: { colour: "red" },
				}),
			[/Fields of sticky: kind, text, tone/],
		],
		[
			"invalid_data (a value the block does not take)",
			() =>
				refusalOf(sampleBoard(), {
					op: "update_node",
					id: "note-1",
					data: { tone: "red" },
				}),
			[/Fields of sticky: kind, text, tone/],
		],
		[
			"limit_exceeded (a board that is full)",
			() => refusalOf(fillBoard(MAX_NODES_PER_BOARD), addSticky("one-more")),
			[/remove nodes/],
		],
		[
			"limit_exceeded (too many new nodes in one change)",
			() => {
				const ops = Array.from({ length: MAX_NEW_NODES_PER_DIFF + 1 }, (_, i) =>
					addSticky(`new-${i}`),
				);
				const { refused } = validateBoardDiff(diff(...ops), sampleBoard());
				return refused[0].detail;
			},
			[/second change/],
		],
	];

	it.each(CASES)("%s", (_name, detailOf, patterns) => {
		const detail = detailOf();
		for (const pattern of patterns) expect(detail).toMatch(pattern);
	});

	it("names, for a block that cannot change kind, ops the vocabulary really has", () => {
		for (const name of ["remove_node", "add_node"]) {
			expect(BOARD_OP_NAMES as readonly string[]).toContain(name);
		}
	});
});

// RV-3 C1: a checklist whose items share an id could be written by the model and
// then took the whole board down (the block draws its rows by item id). The
// refusal names the id and the fix; a diff is judged per op, so the rest applies.
describe("validateBoardDiff — a checklist's item ids are unique (RV-3 C1)", () => {
	const checklistOp = (items: { id: string; text: string; done: boolean }[]) =>
		({
			op: "add_node",
			node: {
				id: "dup",
				type: "checklist",
				position: { x: 0, y: 900 },
				data: { kind: "checklist", items },
			},
		}) as BoardOp;

	it("refuses an added checklist whose items share an id, names the id and the fix, and lets the rest of the batch apply", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				checklistOp([
					{ id: "1", text: "a", done: false },
					{ id: "1", text: "b", done: false },
				]),
				addSticky("after-it"),
			),
			sampleBoard(),
		);
		expect(accepted.map((op) => op.op)).toEqual(["add_node"]);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({
			index: 0,
			op: "add_node",
			id: "dup",
			reason: "invalid_data",
		});
		expect(refused[0].detail).toContain('"1"');
		expect(refused[0].detail).toMatch(/unique/i);
		expect(refused[0].detail).toMatch(/own id/i);
	});

	it("accepts a checklist whose items each have an id of their own", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				checklistOp([
					{ id: "1", text: "a", done: false },
					{ id: "2", text: "b", done: true },
				]),
			),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(1);
	});

	it("refuses an update_node that would leave two items with one id, and one that keeps them apart passes", () => {
		const { accepted, refused } = validateBoardDiff(
			unchecked(
				{
					op: "update_node",
					id: "todo-1",
					data: {
						items: [
							{ id: "i1", text: "Passport", done: true },
							{ id: "i1", text: "Charger", done: false },
						],
					},
				},
				{
					op: "update_node",
					id: "todo-1",
					data: {
						items: [
							{ id: "i1", text: "Passport", done: true },
							{ id: "i2", text: "Charger", done: false },
							{ id: "i3", text: "Tickets", done: false },
						],
					},
				},
			),
			sampleBoard(),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "invalid_data"],
		]);
		expect(refused[0].detail).toContain('"i1"');
		expect(accepted).toHaveLength(1);
	});

	it("refuses a duplicate item id in a checklist that arrives with a whole made board too (the create path)", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				checklistOp([
					{ id: "x", text: "a", done: false },
					{ id: "y", text: "b", done: false },
					{ id: "x", text: "c", done: false },
				]),
			),
			sampleBoard(),
		);
		expect(accepted).toEqual([]);
		expect(refused[0].detail).toContain('"x"');
	});
});

// RV-3 C2: a block the model adds has no width of its own, and the board drew it as
// wide as its words ran (a 120-character note came out 861 wide, through its
// frame), while the model was told it is 190. What Alfy makes is stored the size
// Alfy is told.
describe("applyOp — what the model adds is stored the width the model is told (RV-3 C2)", () => {
	const addOf = (type: string, data: unknown): BoardOp =>
		({
			op: "add_node",
			node: { id: `new-${type}`, type, position: { x: 0, y: 0 }, data },
		}) as BoardOp;

	it("gives every note-shaped block it adds the shared block width, and no height (a note grows with its words)", () => {
		const cases: [string, unknown][] = [
			["sticky", { kind: "sticky", text: "x", tone: "yellow" }],
			["text", { kind: "text", text: "x" }],
			[
				"checklist",
				{ kind: "checklist", items: [{ id: "a", text: "x", done: false }] },
			],
			[
				"chart",
				{ kind: "chart", code: '{"type":"bar","data":{"datasets":[]}}' },
			],
		];
		for (const [type, data] of cases) {
			const added = node(
				applyOp(sampleBoard(), addOf(type, data)),
				`new-${type}`,
			);
			expect(added.width, type).toBe(NODE_WIDTH);
			expect(added.height, type).toBeUndefined();
		}
	});

	it("leaves a frame the size it was given, whichever op made it", () => {
		const viaFrame = node(applyOp(sampleBoard(), addFrame("f1")), "f1");
		expect(viaFrame).toMatchObject({ width: 200, height: 150 });
		const viaNode = node(
			applyOp(
				sampleBoard(),
				addOf("frame", { kind: "frame", label: "F", width: 320, height: 240 }),
			),
			"new-frame",
		);
		expect(viaNode).toMatchObject({ width: 320, height: 240 });
	});

	it("stores it in what a validated diff lands, so the read, the eval and the board measure one box", () => {
		const run = land(
			sampleBoard(),
			addOf("sticky", { kind: "sticky", text: "hello", tone: "mint" }),
		);
		expect(node(run.doc, "new-sticky").width).toBe(NODE_WIDTH);
		// And it is canonical: the stored JSON carries it.
		expect(
			JSON.parse(boardJson(run.doc)).nodes.find(
				(n: { id: string }) => n.id === "new-sticky",
			).width,
		).toBe(NODE_WIDTH);
	});

	it("does not touch the size of a block that is already on the board when it is updated", () => {
		const after = applyOp(sampleBoard(), {
			op: "update_node",
			id: "note-1",
			data: { text: "Lunch at the market hall, then a slow walk" },
		});
		expect(node(after, "note-1").width).toBe(190);
		expect(node(after, "note-museum").width).toBeUndefined();
	});
});

// RV-3 I5 / ruling 67: a block that carries what the app vouches for (the web
// search a block claims to be, the photos, the file, the App, a poster) is set by
// the app — the Insert menu, Refresh, the poster capture — and never by a turn's
// `update_node`, or a prompt-injected turn could plant its own links dressed as the
// app's search result, and every source's favicon would beacon on each open. What
// the model may change on those kinds is the descriptive part only.
describe("validateBoardDiff — update_node on what the app vouches for (ruling 67)", () => {
	function update(id: string, data: Record<string, unknown>): BoardOp {
		return { op: "update_node", id, data } as BoardOp;
	}

	const source = {
		id: "x",
		title: "Official result (verified)",
		url: "https://evil.example/phish",
		provider: "parallel",
		authorityClass: "official",
		authorityScore: 1,
		publishedAt: null,
		updatedAt: null,
	};

	const REWRITES: [string, BoardOp][] = [
		[
			"a web block's sources and its fresh 'updated' line",
			update("web-1", { sources: [source], fetchedAt: Date.now() }),
		],
		["a web block's query", update("web-1", { query: "something else" })],
		["a web block's fetchedAt", update("web-1", { fetchedAt: 1 })],
		[
			"a photo block's items",
			update("photo-1", {
				items: [
					{
						id: "a",
						imageUrl: "/api/connections/immich/thumbnail/some-other-asset",
					},
				],
			}),
		],
		[
			"a file block's fileId and name",
			update("file-1", { fileId: "some-other-file", name: "invoice.pdf" }),
		],
		["a file block's name alone", update("file-1", { name: "invoice.pdf" })],
		["an App block's artifactId", update("app-1", { artifactId: "another" })],
		[
			"a map's poster",
			update("map-1", {
				poster: { fileId: "../../x", width: 1, height: 1, capturedAt: 0 },
			}),
		],
		[
			"an App's poster",
			update("app-1", {
				poster: { fileId: "f", width: 1, height: 1, capturedAt: 0 },
			}),
		],
		[
			"a map's route data",
			update("map-1", {
				map: {
					bounds: { minLat: 0, minLng: 0, maxLat: 1, maxLng: 1 },
					attribution: "x",
				},
			}),
		],
		[
			"a descriptive field together with one the app owns (the whole op is refused)",
			update("map-1", {
				label: "Fine",
				poster: { fileId: "f", width: 1, height: 1, capturedAt: 0 },
			}),
		],
	];

	it.each(REWRITES)("refuses %s as invalid_data", (_name, op) => {
		const { accepted, refused } = validateBoardDiff(diff(op), sampleBoard());
		expect(accepted).toEqual([]);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({
			reason: "invalid_data",
			op: "update_node",
		});
	});

	it("names what may change on that kind and where the rest comes from", () => {
		const detailOf = (op: BoardOp) =>
			validateBoardDiff(diff(op), sampleBoard()).refused[0].detail;
		const map = detailOf(update("map-1", { map: { attribution: "x" } }));
		expect(map).toContain('"map"');
		expect(map).toMatch(/label, route, meta/);
		expect(map).toMatch(/Insert/);
		const app = detailOf(update("app-1", { artifactId: "another" }));
		expect(app).toMatch(/\btitle\b/);
		const web = detailOf(update("web-1", { query: "x" }));
		expect(web).toMatch(/Refresh/);
		expect(web).toMatch(/nothing/i);
		const file = detailOf(update("file-1", { name: "x.pdf" }));
		expect(file).toMatch(/nothing/i);
		expect(file).toMatch(/move it or remove it/);
	});

	it("still lets the model rename what it may: a map's label, route and meta, and an App's title", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				update("map-1", { label: "Saturday's route" }),
				update("map-1", { route: "Vienna to Graz", meta: "2 h 30" }),
				update("app-1", { title: "Trip budget" }),
				update("map-1", { kind: "map", label: "Same kind is not a change" }),
			),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(4);
	});

	it("never lets a poster through on any block, and still moves and removes what it cannot edit", () => {
		const sticky = validateBoardDiff(
			diff(
				update("note-1", {
					poster: { fileId: "f", width: 1, height: 1, capturedAt: 0 },
				}),
			),
			sampleBoard(),
		);
		expect(sticky.accepted).toEqual([]);
		expect(sticky.refused[0].reason).toBe("invalid_data");
		const others = validateBoardDiff(
			diff(
				{ op: "move", id: "web-1", to: { x: 1, y: 1 } },
				{ op: "highlight", ids: ["photo-1"] },
				{ op: "remove_node", id: "file-1" },
			),
			sampleBoard(),
		);
		expect(others.refused).toEqual([]);
		expect(others.accepted).toHaveLength(3);
	});

	it("leaves the five kinds the model makes as free to change as before", () => {
		const { accepted, refused } = validateBoardDiff(
			diff(
				update("note-1", { text: "Lunch at the market hall", tone: "blue" }),
				update("text-1", { text: "Weekend plan" }),
				update("todo-1", {
					items: [{ id: "i1", text: "Passport", done: true }],
				}),
				update("chart-1", { label: "Budget 2026" }),
				update("frame-a", { label: "Sunday", width: 420 }),
			),
			sampleBoard(),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(5);
	});
});

// RV-3 I6 / ruling 67: Alfy reads a board, the reader rewrites a note, and Alfy's
// update_node lands on top of the reader's words. The Document refuses the same
// situation (its patches carry the hash the model read); a board's ops carry ids,
// so the refusal is made from the board the model last read: an op that would
// overwrite a block the reader changed since is refused `stale`, and the rest of
// the batch applies.
describe("validateBoardDiff — the reader's newer words are never overwritten (ruling 67)", () => {
	/** The board as Alfy read it, and the same board after the reader's edits. */
	function readerChanged(change: (board: CanvasBody) => void): {
		read: CanvasBody;
		now: CanvasBody;
	} {
		const read = sampleBoard();
		const now = sampleBoard();
		change(now);
		return { read, now };
	}

	function judge(
		read: CanvasBody,
		now: CanvasBody,
		...ops: BoardOp[]
	): ReturnType<typeof validateBoardDiff> {
		return validateBoardDiff(diff(...ops), now, { readBoard: read });
	}

	const rewrite = (id: string, text: string): BoardOp =>
		({ op: "update_node", id, data: { text } }) as BoardOp;

	it("refuses an update_node on a note the reader rewrote after the read, naming the note and what to do", () => {
		const { read, now } = readerChanged((board) => {
			node(board, "note-museum").data = {
				kind: "sticky",
				text: "Museum, 16:30 (moved)",
				tone: "mint",
			};
		});
		const { accepted, refused } = judge(
			read,
			now,
			rewrite("note-museum", "Museum, 14:00 — tickets booked"),
		);
		expect(accepted).toEqual([]);
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({
			index: 0,
			op: "update_node",
			id: "note-museum",
			reason: "stale",
		});
		expect(refused[0].detail).toContain('"note-museum"');
		expect(refused[0].detail).toMatch(/reader/i);
		expect(refused[0].detail).toMatch(/read_artifact/);
	});

	it("refuses a move and a remove_node of a block the reader changed or moved, and applies the ops on blocks they left alone", () => {
		const { read, now } = readerChanged((board) => {
			node(board, "note-museum").position = { x: 640, y: 90 };
			node(board, "text-1").data = { kind: "text", text: "Weekend plan v2" };
		});
		const { accepted, refused } = judge(
			read,
			now,
			{ op: "move", id: "note-museum", to: { x: 500, y: 60 } },
			{ op: "remove_node", id: "text-1" },
			{ op: "move", id: "note-1", to: { x: 30, y: 70 } },
			rewrite("todo-1", "not a text"),
		);
		expect(refused.map((r) => [r.index, r.reason])).toEqual([
			[0, "stale"],
			[1, "stale"],
			[3, "invalid_data"],
		]);
		expect(accepted).toHaveLength(1);
		expect(accepted[0]).toMatchObject({ op: "move", id: "note-1" });
	});

	it("refuses a block the reader took into another frame, or resized", () => {
		const { read, now } = readerChanged((board) => {
			delete node(board, "note-1").parentId;
			node(board, "frame-a").width = 500;
			node(board, "frame-a").data = {
				kind: "frame",
				label: "Saturday",
				width: 500,
				height: 300,
			};
		});
		const { refused } = judge(
			read,
			now,
			{ op: "move", id: "note-1", to: { x: 1, y: 1 } },
			{ op: "update_node", id: "frame-a", data: { label: "Sunday" } },
		);
		expect(refused.map((r) => r.reason)).toEqual(["stale", "stale"]);
	});

	it("never judges what changes nothing of the reader's: a highlight, an arrow to a changed block, an arrow removed", () => {
		const { read, now } = readerChanged((board) => {
			node(board, "text-1").data = { kind: "text", text: "Weekend plan v2" };
		});
		const { accepted, refused } = judge(
			read,
			now,
			{ op: "highlight", ids: ["text-1"] },
			{
				op: "add_edge",
				edge: { id: "e-new", source: "text-1", target: "note-museum" },
			},
			{ op: "remove_edge", id: "edge-1" },
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(3);
	});

	it("leaves a block the reader added after the read, and one this same change made, alone", () => {
		const { read, now } = readerChanged((board) => {
			board.nodes.push({
				id: "reader-note",
				type: "sticky",
				position: { x: 0, y: 900 },
				data: { kind: "sticky", text: "mine", tone: "plain" },
			});
		});
		const { accepted, refused } = judge(
			read,
			now,
			rewrite("reader-note", "Alfy tidied it"),
			addSticky("alfy-note"),
			rewrite("alfy-note", "edited in the same change"),
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(3);
	});

	it("is the plain refusal a block the reader removed already gets: it is not there", () => {
		const { read, now } = readerChanged((board) => {
			board.nodes = board.nodes.filter((n) => n.id !== "text-1");
		});
		const { refused } = judge(read, now, rewrite("text-1", "x"));
		expect(refused[0].reason).toBe("unknown_id");
	});

	it("applies everything to the current board when there was no read to judge against", () => {
		const { now } = readerChanged((board) => {
			node(board, "text-1").data = { kind: "text", text: "Weekend plan v2" };
		});
		const { accepted, refused } = validateBoardDiff(
			diff(rewrite("text-1", "Alfy's words")),
			now,
		);
		expect(refused).toEqual([]);
		expect(accepted).toHaveLength(1);
	});

	it("goes through the shared mechanism: the board the model read reaches the judge, and the rest of the batch lands", () => {
		const { read, now } = readerChanged((board) => {
			node(board, "text-1").data = { kind: "text", text: "Weekend plan v2" };
		});
		const run = runOps(
			boardOpsVocabulary,
			now,
			diff(rewrite("text-1", "Alfy's words"), addSticky("s-new")),
			{ readDoc: read },
		);
		if (!run.ok) throw new Error(run.detail);
		expect(run.applied).toBe(1);
		expect(run.refused.map((r) => r.reason)).toEqual(["stale"]);
		expect(node(run.doc, "text-1").data).toEqual({
			kind: "text",
			text: "Weekend plan v2",
		});
		expect(node(run.doc, "s-new").id).toBe("s-new");
	});
});
