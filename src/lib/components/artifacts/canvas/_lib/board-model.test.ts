import { describe, expect, it } from "vitest";
import type { CanvasBody, CanvasNode } from "$lib/shared/artifacts/canvas";
import {
	boardJson,
	normalizeCanvasBody,
} from "$lib/shared/artifacts/canvas-body";
import {
	cloneBoard,
	sampleBoard,
} from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import {
	bodyOfState,
	DEFAULT_CAMERA,
	hasStoredCamera,
	structuralJson,
	toFlowEdges,
	toFlowNodes,
	withBlockData,
} from "./board-model";

function stateOf(body: CanvasBody) {
	return {
		nodes: toFlowNodes(body.nodes),
		edges: body.edges,
		viewport: body.viewport,
		annotations: body.annotations,
	};
}

describe("stored nodes to library nodes", () => {
	it("gives a frame the fields that put it behind what it groups and make it draggable by its chip only", () => {
		const frame = toFlowNodes(sampleBoard().nodes).find(
			(n) => n.type === "frame",
		);
		expect(frame).toMatchObject({
			zIndex: -1,
			dragHandle: ".canvas-node__chip",
			style: "pointer-events: none;",
		});
	});

	it("gives a note none of those", () => {
		const note = toFlowNodes(sampleBoard().nodes).find(
			(n) => n.type === "sticky",
		);
		expect(note?.zIndex).toBeUndefined();
		expect(note?.dragHandle).toBeUndefined();
		expect(note?.style).toBeUndefined();
	});

	it("lets a frame with no size of its own on the node take the one in its data", () => {
		const bare: CanvasNode = {
			id: "f",
			type: "frame",
			position: { x: 0, y: 0 },
			data: { kind: "frame", label: "", width: 300, height: 200 },
		};
		expect(toFlowNodes([bare])[0]).toMatchObject({ width: 300, height: 200 });
	});

	it("does not touch the nodes it was given", () => {
		const board = sampleBoard();
		const before = JSON.stringify(board.nodes);
		toFlowNodes(board.nodes);
		expect(JSON.stringify(board.nodes)).toBe(before);
	});
});

describe("the live board back to a body", () => {
	it("round-trips a canonical board to the same canonical JSON", () => {
		const board = sampleBoard();
		expect(boardJson(bodyOfState(stateOf(board)))).toBe(boardJson(board));
	});

	it("puts a resized frame's size into its data, so the two never disagree", () => {
		const board = cloneBoard(sampleBoard());
		const state = stateOf(board);
		const frame = state.nodes.find((n) => n.type === "frame");
		if (!frame) throw new Error("fixture has a frame");
		frame.width = 480;
		frame.height = 320;
		const stored = bodyOfState(state).nodes.find((n) => n.type === "frame");
		expect(stored).toMatchObject({
			width: 480,
			height: 320,
			data: { kind: "frame", width: 480, height: 320 },
		});
		// The canonical form a save writes carries the same two numbers twice.
		const written = normalizeCanvasBody(
			JSON.parse(boardJson(bodyOfState(state))),
		).body;
		expect(written.nodes.find((n) => n.type === "frame")).toMatchObject({
			width: 480,
			data: { width: 480 },
		});
	});

	it("keeps an edge's four fields and drops what the library added", () => {
		const state = stateOf(sampleBoard());
		const body = bodyOfState({
			...state,
			edges: [
				{
					id: "e",
					source: "note-1",
					target: "text-1",
					label: "then",
					sourceHandle: "bottom",
					selected: true,
				} as never,
				{ id: "e2", source: "note-1", target: "text-1" },
			],
		});
		expect(body.edges).toEqual([
			{ id: "e", source: "note-1", target: "text-1", label: "then" },
			{ id: "e2", source: "note-1", target: "text-1" },
		]);
	});

	it("keeps the annotations it holds, untouched, for a board that has strokes it does not draw", () => {
		const board = sampleBoard();
		expect(bodyOfState(stateOf(board)).annotations).toEqual(board.annotations);
	});
});

describe("edges", () => {
	it("gives each stored edge the sides that face its two ends, so a reopened board draws what was drawn", () => {
		const body = sampleBoard();
		const [first] = body.edges;
		const source = body.nodes.find((n) => n.id === first.source);
		const target = body.nodes.find((n) => n.id === first.target);
		expect(source && target).toBeTruthy();
		const [flow] = toFlowEdges(body.edges, body.nodes);
		expect(flow).toMatchObject({
			id: first.id,
			source: first.source,
			target: first.target,
		});
		expect(typeof flow.sourceHandle).toBe("string");
		expect(typeof flow.targetHandle).toBe("string");
	});

	it("leaves an edge alone when one of its ends is not on the board", () => {
		const edges = [{ id: "e", source: "a", target: "gone" }];
		const nodes = sampleBoard().nodes.map((n) => ({
			...n,
			id: n.id === "note-1" ? "a" : n.id,
		}));
		expect(toFlowEdges(edges, nodes)).toEqual(edges);
	});

	it("never saves an edge that points at a block that is not there", () => {
		const body = sampleBoard();
		const state = stateOf(body);
		const withoutNote = {
			...state,
			nodes: state.nodes.filter((n) => n.id !== "note-1"),
		};
		const saved = bodyOfState(withoutNote);
		const ids = new Set(saved.nodes.map((n) => n.id));
		expect(
			saved.edges.every((e) => ids.has(e.source) && ids.has(e.target)),
		).toBe(true);
		expect(saved.edges.length).toBeLessThan(body.edges.length);
	});
});

describe("what counts as a change", () => {
	it("is not a change when only the camera moved", () => {
		const board = sampleBoard();
		const panned = { ...board, viewport: { x: 900, y: -40, zoom: 0.4 } };
		expect(structuralJson(panned)).toBe(structuralJson(board));
		expect(boardJson(panned)).not.toBe(boardJson(board));
	});

	it("is a change when a block's words, a position or a tick changed", () => {
		const board = sampleBoard();
		const edited = cloneBoard(board);
		const note = edited.nodes.find((n) => n.id === "note-museum");
		if (note?.data.kind !== "sticky") throw new Error("fixture");
		note.data.text = "Museum, 15:00";
		expect(structuralJson(edited)).not.toBe(structuralJson(board));

		const moved = cloneBoard(board);
		moved.nodes[2].position.x += 10;
		expect(structuralJson(moved)).not.toBe(structuralJson(board));

		const ticked = cloneBoard(board);
		const list = ticked.nodes.find((n) => n.id === "todo-1");
		if (list?.data.kind !== "checklist") throw new Error("fixture");
		list.data.items[1].done = true;
		expect(structuralJson(ticked)).not.toBe(structuralJson(board));
	});

	it("is not a change when only what the library writes back changed (selection, measurement, dragging)", () => {
		const board = sampleBoard();
		const live = cloneBoard(board);
		live.nodes[0] = {
			...live.nodes[0],
			selected: true,
			dragging: true,
			measured: { width: 361, height: 299 },
		};
		expect(structuralJson(live)).toBe(structuralJson(board));
	});

	it("tells a board that was never panned from one that was", () => {
		expect(
			hasStoredCamera({ ...sampleBoard(), viewport: DEFAULT_CAMERA }),
		).toBe(false);
		expect(hasStoredCamera(sampleBoard())).toBe(true);
		expect(
			hasStoredCamera({
				...sampleBoard(),
				viewport: { x: 0, y: 0, zoom: 1.5 },
			}),
		).toBe(true);
	});
});

describe("a block's new data", () => {
	const FRESH = {
		kind: "liveweb",
		query: "weather in Salzburg",
		sources: [],
		fetchedAt: 2_000_000_000_000,
	} as const;

	it("replaces the data of the block it names and leaves every other block, and the board's order, alone", () => {
		const nodes = toFlowNodes(cloneBoard(sampleBoard()).nodes);

		const next = withBlockData(nodes, "web-1", FRESH);

		expect(next).not.toBeNull();
		expect(next).toHaveLength(nodes.length);
		expect(next?.map((node) => node.id)).toEqual(nodes.map((node) => node.id));
		expect(next?.find((node) => node.id === "web-1")?.data).toEqual(FRESH);
		for (const node of nodes) {
			if (node.id === "web-1") continue;
			expect(next?.find((n) => n.id === node.id)).toBe(node);
		}
	});

	it("keeps the block where it is, at its size, in its frame and selected: only its data changes", () => {
		const nodes = toFlowNodes(cloneBoard(sampleBoard()).nodes);
		const before = nodes.find((node) => node.id === "web-1");

		const after = withBlockData(nodes, "web-1", FRESH)?.find(
			(node) => node.id === "web-1",
		);

		expect({ ...after, data: null }).toEqual({ ...before, data: null });
		expect(after?.data).not.toEqual(before?.data);
	});

	it("does not touch the nodes it was given", () => {
		const nodes = toFlowNodes(cloneBoard(sampleBoard()).nodes);
		const before = JSON.stringify(nodes);
		withBlockData(nodes, "web-1", FRESH);
		expect(JSON.stringify(nodes)).toBe(before);
	});

	it("answers null for a block that is gone (the reader deleted it while the search ran)", () => {
		const nodes = toFlowNodes(cloneBoard(sampleBoard()).nodes);
		expect(withBlockData(nodes, "no-such-block", FRESH)).toBeNull();
	});

	it("answers null for a block of another kind: a snapshot never turns a note into a web block", () => {
		const nodes = toFlowNodes(cloneBoard(sampleBoard()).nodes);
		expect(withBlockData(nodes, "note-1", FRESH)).toBeNull();
		expect(withBlockData(nodes, "map-1", FRESH)).toBeNull();
	});
});
