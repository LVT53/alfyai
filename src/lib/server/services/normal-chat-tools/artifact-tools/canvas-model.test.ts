import { describe, expect, it } from "vitest";
import { MAX_NEW_NODES_PER_DIFF } from "$lib/shared/artifacts/board-ops";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import {
	BLOCK_SHAPES_HINT,
	BOARD_DEFAULT_NODE_HEIGHT,
	BOARD_NODE_WIDTH,
	canvasEditFailureMessage,
	canvasReadBlocks,
	parseCanvasCreateBody,
} from "./canvas-model";

function sticky(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		type: "sticky",
		position: { x: 10, y: 10 },
		data: { kind: "sticky", text: `note ${id}`, tone: "yellow" },
		...extra,
	};
}

function frame(id: string, extra: Record<string, unknown> = {}) {
	return {
		id,
		type: "frame",
		position: { x: 0, y: 0 },
		data: { kind: "frame", label: id, width: 300, height: 200 },
		...extra,
	};
}

function body(nodes: unknown[], edges: unknown[] = []): string {
	return JSON.stringify({ nodes, edges });
}

function refusal(raw: string): string {
	const result = parseCanvasCreateBody(raw);
	if (result.ok) throw new Error("expected the create to be refused");
	return result.error;
}

describe("canvasReadBlocks — what read_artifact shows the model of a board", () => {
	const blocks = canvasReadBlocks(sampleBoard());
	const byId = (id: string) => {
		const found = blocks.find((block) => block.id === id);
		if (!found) throw new Error(`no block ${id}`);
		return found;
	};

	it("has one entry per node, in board order, then one per edge", () => {
		const board = sampleBoard();
		expect(blocks.map((block) => block.id)).toEqual([
			...board.nodes.map((node) => node.id),
			...board.edges.map((edge) => edge.id),
		]);
		expect(blocks.filter((block) => block.kind === "edge")).toHaveLength(1);
	});

	it("gives a node its id, kind, label and position — in its own space, so a move can reuse it", () => {
		expect(byId("note-1")).toMatchObject({
			id: "note-1",
			kind: "sticky",
			label: "Lunch at the market",
			x: 20,
			y: 60,
			parentId: "frame-a",
		});
		expect(byId("note-museum")).not.toHaveProperty("parentId");
	});

	it("gives a node its size: the stored one, or the footprint the board's own geometry assumes", () => {
		expect(byId("note-1")).toMatchObject({ width: 190, height: 84 });
		expect(byId("text-1")).toMatchObject({
			width: BOARD_NODE_WIDTH,
			height: BOARD_DEFAULT_NODE_HEIGHT,
		});
		expect(byId("frame-a")).toMatchObject({ width: 360, height: 300 });
		expect(BOARD_NODE_WIDTH).toBe(190);
		expect(BOARD_DEFAULT_NODE_HEIGHT).toBe(84);
	});

	it("carries what an edit needs to name: a sticky's tone, a checklist's items with their ids", () => {
		expect(byId("note-museum")).toMatchObject({ tone: "mint" });
		expect(byId("todo-1")).toMatchObject({
			label: "Pack",
			items: [
				{ id: "i1", text: "Passport", done: true },
				{ id: "i2", text: "Charger", done: false },
			],
		});
	});

	it("says what a block the user placed is, in words", () => {
		expect(byId("chart-1").label).toBe("Budget");
		expect(byId("map-1").label).toBe("Vienna to Salzburg");
		expect(byId("file-1").label).toBe("Trip.pdf");
		expect(byId("app-1").label).toBe("Budget");
		expect(byId("photo-1").label).toBe("1 photo");
		expect(byId("web-1").label).toBe("weather in Salzburg");
	});

	it("lists an edge by its ends, so a remove_edge can name it", () => {
		expect(byId("edge-1")).toEqual({
			id: "edge-1",
			kind: "edge",
			source: "note-1",
			target: "text-1",
			label: "then",
		});
	});

	it("clips a long note's label but never its other fields", () => {
		const board = sampleBoard();
		board.nodes = [
			{
				id: "long",
				type: "sticky",
				position: { x: 0, y: 0 },
				data: { kind: "sticky", text: "word ".repeat(200), tone: "blue" },
			},
		];
		board.edges = [];
		const [block] = canvasReadBlocks(board);
		expect(String(block.label).length).toBeLessThan(310);
		expect(String(block.label).endsWith("…")).toBe(true);
		expect(block).toMatchObject({ id: "long", tone: "blue" });
	});

	it("is empty for an empty board", () => {
		expect(
			canvasReadBlocks({ ...sampleBoard(), nodes: [], edges: [] }),
		).toEqual([]);
	});
});

describe("parseCanvasCreateBody — the board a create_artifact call carries", () => {
	it("makes an empty board of nothing, of {}, and of an empty node list", () => {
		for (const raw of ["", "  \n", "{}", body([]), '{"nodes":[],"edges":[]}']) {
			const result = parseCanvasCreateBody(raw);
			expect(result.ok, raw).toBe(true);
			if (result.ok) {
				expect(result.body.nodes).toEqual([]);
				expect(result.body.edges).toEqual([]);
			}
		}
	});

	it("reads nodes and edges into a board, a frame's size on the node and in its data", () => {
		const result = parseCanvasCreateBody(
			body(
				[
					frame("f1", { position: { x: 40, y: 40 } }),
					sticky("n1", { parentId: "f1" }),
				],
				[{ id: "e1", source: "n1", target: "f1", label: "in" }],
			),
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.body.nodes.map((node) => node.id)).toEqual(["f1", "n1"]);
		expect(result.body.nodes[0]).toMatchObject({
			width: 300,
			height: 200,
			position: { x: 40, y: 40 },
		});
		expect(result.body.nodes[1]).toMatchObject({ parentId: "f1" });
		expect(result.body.edges).toEqual([
			{ id: "e1", source: "n1", target: "f1", label: "in" },
		]);
	});

	it("puts a frame before what is inside it, whatever order the model wrote them in", () => {
		const result = parseCanvasCreateBody(
			body([
				sticky("n1", { parentId: "f1" }),
				sticky("n2", { parentId: "f2" }),
				frame("f2", { parentId: "f1" }),
				frame("f1"),
			]),
		);
		if (!result.ok) throw new Error(result.error);
		const order = result.body.nodes.map((node) => node.id);
		expect(order.indexOf("f1")).toBeLessThan(order.indexOf("f2"));
		expect(order.indexOf("f2")).toBeLessThan(order.indexOf("n2"));
		expect(order.indexOf("f1")).toBeLessThan(order.indexOf("n1"));
	});

	it("takes a board bigger than one change may add — the per-change cap is the edit tool's", () => {
		const count = MAX_NEW_NODES_PER_DIFF * 3 + 5;
		const nodes = Array.from({ length: count }, (_, i) => sticky(`n${i}`));
		const edges = Array.from({ length: count - 1 }, (_, i) => ({
			id: `e${i}`,
			source: `n${i}`,
			target: `n${i + 1}`,
		}));
		const result = parseCanvasCreateBody(body(nodes, edges));
		if (!result.ok) throw new Error(result.error);
		expect(result.body.nodes).toHaveLength(count);
		expect(result.body.edges).toHaveLength(count - 1);
	});

	it("ignores layout hints on a node the app decides the size of, and keeps every word", () => {
		const result = parseCanvasCreateBody(
			body([
				sticky("n1", { width: 500, height: 500, selected: true, style: "x" }),
			]),
		);
		if (!result.ok) throw new Error(result.error);
		expect(result.body.nodes[0]).not.toHaveProperty("selected");
		expect(result.body.nodes[0].data).toEqual({
			kind: "sticky",
			text: "note n1",
			tone: "yellow",
		});
	});

	describe("refuses, and names the fix, for", () => {
		it("a body that is not JSON", () => {
			const error = refusal('{"nodes": [');
			expect(error).toMatch(/not valid JSON/);
			expect(error).toContain("{}");
			expect(error).toContain("edit_artifact");
		});

		it("a body with a brace short, quoting where it went wrong", () => {
			const board = `{"nodes":[{"id":"a","type":"checklist","position":{"x":0,"y":0},"data":{"kind":"checklist","items":[{"id":"1","text":"x","done":false}]}, {"id":"b"}],"edges":[]}`;
			const error = refusal(board);
			expect(error).toMatch(/not valid JSON \(.* at character \d+\)\./);
			expect(error).toContain("Near: ...");
			expect(error).toContain('{"id":"b"}');
			expect(error).toMatch(/every \{ and \[ is closed/);
		});

		it("an entry that is an arrow in name only, saying where arrows go", () => {
			// `type: "edge"` with no ends is not an arrow the parse can file: there is
			// nothing to file it by.
			const error = refusal(
				body([sticky("a"), sticky("b"), { id: "e1", type: "edge" }]),
			);
			expect(error).toContain('nodes[2] "e1": is an edge');
			expect(error).toContain('edges go in the "edges" array');
		});

		it("an entry that is both an arrow and a block, saying which is which", () => {
			// Both an arrow's fields and a block's: which one it is cannot be guessed,
			// so it is not filed anywhere. The message says what each looks like.
			for (const entry of [
				{ id: "e1", type: "edge", source: "a", target: "b", data: { x: 1 } },
				{ id: "e2", source: "a", target: "b", position: { x: 0, y: 0 } },
				{
					...sticky("e3"),
					source: "a",
					target: "b",
				},
			]) {
				const error = refusal(body([sticky("a"), sticky("b"), entry]));
				expect(error, entry.id).toContain(`nodes[2] "${entry.id}"`);
				expect(error, entry.id).toMatch(/both/);
				expect(error, entry.id).toContain('"edges"');
				expect(error, entry.id).toContain('"nodes"');
			}
		});

		it("a block listed among the arrows, saying where blocks go", () => {
			const error = refusal(
				body(
					[sticky("a")],
					[{ id: "n2", type: "sticky", position: { x: 0, y: 0 }, data: {} }],
				),
			);
			expect(error).toContain('edges[0] "n2": is a block');
			expect(error).toContain('blocks go in the "nodes" array');
		});

		it("JSON that is not a board object", () => {
			expect(refusal("[1,2]")).toMatch(/object/);
			expect(refusal('"hello"')).toMatch(/object/);
		});

		it("a field a board does not have, naming the two it does", () => {
			const error = refusal(
				JSON.stringify({ nodes: [], edges: [], title: "x" }),
			);
			expect(error).toContain('"title"');
			expect(error).toContain('"nodes"');
			expect(error).toContain('"edges"');
		});

		it("a node that is not an object, and one missing its position", () => {
			expect(refusal(body(["sticky"]))).toMatch(/nodes\[0\]/);
			const error = refusal(
				body([
					{
						id: "n1",
						type: "sticky",
						data: { kind: "sticky", text: "t", tone: "plain" },
					},
				]),
			);
			expect(error).toContain('nodes[0] "n1"');
			expect(error).toMatch(/position/);
		});

		it("a block the model may not make, naming the five it may", () => {
			const error = refusal(
				body([
					sticky("ok"),
					{
						id: "m1",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
				]),
			);
			expect(error).toContain('nodes[1] "m1"');
			for (const kind of ["frame", "sticky", "text", "checklist", "chart"]) {
				expect(error).toContain(kind);
			}
		});

		it("data that is not the kind's, naming the kind's fields", () => {
			const error = refusal(
				body([
					{
						id: "n1",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { label: "x" },
					},
				]),
			);
			expect(error).toContain('nodes[0] "n1"');
			expect(error).toMatch(/Fields of sticky: kind, text, tone/);
		});

		it("a type that is not its data's kind", () => {
			const error = refusal(
				body([
					{
						id: "n1",
						type: "sticky",
						position: { x: 0, y: 0 },
						data: { kind: "text", text: "t" },
					},
				]),
			);
			expect(error).toMatch(/same kind/);
		});

		it("a parent that is not a frame, naming the frames", () => {
			const error = refusal(
				body([frame("f1"), sticky("n1", { parentId: "n2" }), sticky("n2")]),
			);
			expect(error).toContain('nodes[1] "n1"');
			expect(error).toMatch(/Frames: f1/);
		});

		it("two nodes with one id, and a frame inside itself", () => {
			expect(refusal(body([sticky("a"), sticky("a")]))).toMatch(
				/choose a new id/,
			);
			expect(refusal(body([frame("f", { parentId: "f" })]))).toMatch(
				/parentId/,
			);
		});

		it("an edge to a node that is not on the board, naming the ones that are", () => {
			const error = refusal(
				body([sticky("a")], [{ id: "e1", source: "a", target: "ghost" }]),
			);
			expect(error).toContain('edges[0] "e1"');
			expect(error).toMatch(/Node ids: a/);
		});

		it("an edge that lacks an end", () => {
			const error = refusal(body([sticky("a")], [{ id: "e1", source: "a" }]));
			expect(error).toContain("edges[0]");
			expect(error).toMatch(/target/);
		});

		it("a board past the node cap", () => {
			const nodes = Array.from({ length: 401 }, (_, i) => sticky(`n${i}`));
			expect(refusal(body(nodes))).toMatch(/400/);
		});

		it("all of it at once, worst first, and says nothing was made", () => {
			const error = refusal(
				body([
					{
						id: "m1",
						type: "map",
						position: { x: 0, y: 0 },
						data: { kind: "map" },
					},
					sticky("n1", { parentId: "nowhere" }),
				]),
			);
			expect(error).toMatch(/Nothing was created/);
			expect(error.indexOf('nodes[0] "m1"')).toBeLessThan(
				error.indexOf('nodes[1] "n1"'),
			);
		});

		it("shows a handful of problems, and counts the rest", () => {
			const nodes = Array.from({ length: 12 }, (_, i) => ({
				id: `m${i}`,
				type: "map",
				position: { x: 0, y: 0 },
				data: { kind: "map" },
			}));
			const error = refusal(body(nodes));
			expect(error).toMatch(/\+\d+ more/);
			expect(error.length).toBeLessThan(2500);
		});
	});
});

describe("parseCanvasCreateBody — an arrow listed with the blocks is still an arrow", () => {
	// About a third of English creates list their arrows under "nodes" (a habit
	// from other editors), whatever the wording says. An entry there with a
	// source and a target and no data is unambiguous, so it is filed where an
	// arrow goes instead of costing the whole board a resend. Nothing else about
	// the contract relaxes.
	function edgesOf(raw: string) {
		const result = parseCanvasCreateBody(raw);
		if (!result.ok) throw new Error(result.error);
		return result.body;
	}

	it("files an entry with a source and a target and no data under edges, whatever type it names", () => {
		const board = edgesOf(
			body([
				sticky("a"),
				sticky("b"),
				{ id: "e1", type: "edge", source: "a", target: "b" },
				{ id: "e2", source: "b", target: "a", label: "back" },
				{ id: "e3", type: "smoothstep", source: "a", target: "b" },
			]),
		);

		expect(board.nodes.map((node) => node.id)).toEqual(["a", "b"]);
		expect(board.edges).toEqual([
			{ id: "e1", source: "a", target: "b" },
			{ id: "e2", source: "b", target: "a", label: "back" },
			{ id: "e3", source: "a", target: "b" },
		]);
	});

	it("makes the very board the model would have made by listing the arrows where they go", () => {
		const blocks = [sticky("a"), frame("f"), sticky("b", { parentId: "f" })];
		const arrows = [
			{ id: "e1", source: "a", target: "b", label: "then" },
			{ id: "e2", type: "edge", source: "b", target: "f" },
		];

		expect(edgesOf(body([...blocks, ...arrows]))).toEqual(
			edgesOf(body(blocks, arrows)),
		);
		// Wherever among the blocks it stands.
		expect(edgesOf(body([arrows[0], ...blocks, arrows[1]]))).toEqual(
			edgesOf(body(blocks, arrows)),
		);
	});

	it("keeps the arrows it was given where they are and files the moved ones after them, in the order they were listed", () => {
		const board = edgesOf(
			body(
				[
					sticky("a"),
					{ id: "moved-1", source: "a", target: "b" },
					sticky("b"),
					{ id: "moved-2", source: "b", target: "a" },
				],
				[{ id: "given", source: "a", target: "b" }],
			),
		);

		expect(board.edges.map((edge) => edge.id)).toEqual([
			"given",
			"moved-1",
			"moved-2",
		]);
	});

	it("judges a moved arrow as it judges an arrow, and names where it stood in the body", () => {
		const toNothing = refusal(
			body([sticky("a"), { id: "e1", source: "a", target: "ghost" }]),
		);
		expect(toNothing).toContain('nodes[1] "e1"');
		expect(toNothing).toMatch(/Node ids: a/);

		const twice = refusal(
			body(
				[sticky("a"), sticky("b"), { id: "e1", source: "a", target: "b" }],
				[{ id: "e1", source: "b", target: "a" }],
			),
		);
		expect(twice).toContain('nodes[2] "e1"');

		// Ends that are not ids are an arrow with a bad end, said in the arrow's words.
		const badEnd = refusal(
			body([sticky("a"), { id: "e1", source: "a", target: 7 }]),
		);
		expect(badEnd).toContain('nodes[1] "e1"');
		expect(badEnd).toMatch(/target/);
	});

	it("still refuses everything else the way it did: an arrow with a block's fields, and a block among the arrows", () => {
		// Data or a position makes it possibly a block: refused, not filed.
		expect(
			refusal(
				body([
					sticky("a"),
					{ id: "e1", source: "a", target: "a", data: { kind: "sticky" } },
				]),
			),
		).toContain('nodes[1] "e1"');
		// A block among the arrows is not moved the other way.
		const error = refusal(
			body(
				[sticky("a")],
				[{ id: "n2", type: "sticky", position: { x: 0, y: 0 }, data: {} }],
			),
		);
		expect(error).toContain('blocks go in the "nodes" array');
	});

	it("does not count a moved arrow against the node cap, and does not let a board past it in", () => {
		const blocks = Array.from({ length: 400 }, (_, index) =>
			sticky(`n${index}`),
		);
		const arrows = [
			{ id: "e1", source: "n0", target: "n1" },
			{ id: "e2", source: "n1", target: "n2" },
		];

		const board = edgesOf(body([...blocks, ...arrows]));
		expect(board.nodes).toHaveLength(400);
		expect(board.edges).toHaveLength(2);

		expect(
			refusal(body([...blocks, sticky("one-too-many"), ...arrows])),
		).toMatch(/400/);
	});
});

describe("canvasEditFailureMessage — an edit the board could not take at all", () => {
	it("names the ops, and the blocks it may add, when the diff cannot be read", () => {
		const message = canvasEditFailureMessage({
			ok: false,
			status: 400,
			reason: "invalid_diff",
			detail: "ops[0].op: not a known op. Valid ops: add_frame, add_node.",
		});
		expect(message).toContain("ops[0].op: not a known op");
		expect(message).toContain("Valid ops: add_frame, add_node.");
		expect(message).toContain(BLOCK_SHAPES_HINT);
		expect(message).toMatch(/Nothing was applied/);
	});

	it("tells a conflict to read the board again and resend", () => {
		const message = canvasEditFailureMessage({
			ok: false,
			status: 409,
			reason: "version_conflict",
			version: 4,
		});
		expect(message).toMatch(/read_artifact/);
		expect(message).toMatch(/again/);
	});

	it("says a deleted board is gone, and a too-large change is too large", () => {
		expect(
			canvasEditFailureMessage({ ok: false, status: 404, reason: "not_found" }),
		).toMatch(/could not be found/);
		expect(
			canvasEditFailureMessage({ ok: false, status: 413, reason: "too_large" }),
		).toMatch(/larger/);
	});
});

describe("the block shapes a refusal teaches", () => {
	it("names every kind the model may add with its fields, and the values a sticky's tone takes", () => {
		for (const [kind, fields] of [
			["frame", "kind, label, width, height"],
			["sticky", "kind, text, tone"],
			["text", "kind, text"],
			["checklist", "kind, label, items"],
			["chart", "kind, label, subtitle, code"],
		]) {
			expect(BLOCK_SHAPES_HINT).toContain(`${kind}: ${fields}`);
		}
		expect(BLOCK_SHAPES_HINT).toMatch(/yellow, mint, blue or plain/);
		expect(BLOCK_SHAPES_HINT).toMatch(/\{id, text, done\}/);
	});
});
