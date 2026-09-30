import { describe, expect, it } from "vitest";
import { diffBoards, isEmptyDelta } from "./board-diff";
import { applyOp, type BoardOp } from "./board-ops";
import type { CanvasBody } from "./canvas";
import { sampleBoard } from "./canvas-fixtures.test-helpers";

// What a change did to a board, as the difference between the board before and
// the board after: the one function the client's landing (which blocks glide,
// which get a ring) and the server's review state (which blocks are still
// waiting for the reader) both ask, so the two cannot disagree about what a
// change touched.

function landed(board: CanvasBody, ...ops: BoardOp[]): CanvasBody {
	return ops.reduce((current, op) => applyOp(current, op), board);
}

describe("what a change touched", () => {
	it("finds nothing when nothing changed", () => {
		const board = sampleBoard();
		const delta = diffBoards(board, board);
		expect(isEmptyDelta(delta)).toBe(true);
		expect(delta.touched).toEqual([]);
	});

	it("does not see a different order of keys as a change", () => {
		const board = sampleBoard();
		const shuffled: CanvasBody = JSON.parse(JSON.stringify(board));
		shuffled.nodes = shuffled.nodes.map((node) => ({
			...node,
			data: Object.fromEntries(Object.entries(node.data).reverse()),
		})) as CanvasBody["nodes"];
		expect(isEmptyDelta(diffBoards(board, shuffled))).toBe(true);
	});

	it("does not count the camera or the reader's marks: an op cannot change them", () => {
		const board = sampleBoard();
		const other: CanvasBody = {
			...board,
			viewport: { x: 10, y: 20, zoom: 0.5 },
			annotations: [],
		};
		expect(isEmptyDelta(diffBoards(board, other))).toBe(true);
	});

	it("names a block that was added", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "add_node",
			node: {
				id: "note-new",
				type: "sticky",
				position: { x: 300, y: 60 },
				data: { kind: "sticky", text: "Coffee", tone: "yellow" },
			},
		});
		const delta = diffBoards(board, after);
		expect(delta.addedNodes).toEqual(["note-new"]);
		expect(delta.touched).toEqual(["note-new"]);
	});

	it("names a block that moved, with where it was and where it went", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "move",
			id: "note-museum",
			to: { x: 700, y: 90 },
		});
		const delta = diffBoards(board, after);
		expect(delta.movedNodes).toEqual([
			{ id: "note-museum", from: { x: 500, y: 60 }, to: { x: 700, y: 90 } },
		]);
		expect(delta.touched).toEqual(["note-museum"]);
	});

	it("does not call a block moved when it only goes along with its frame", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "move",
			id: "frame-a",
			to: { x: 400, y: 40 },
		});
		const delta = diffBoards(board, after);
		// `note-1` is frame-relative: its own position did not change.
		expect(delta.movedNodes.map((move) => move.id)).toEqual(["frame-a"]);
		expect(delta.touched).toEqual(["frame-a"]);
	});

	it("names a block whose words changed, and leaves the ones that did not", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "update_node",
			id: "text-1",
			data: { text: "Weekend plan (updated)" },
		});
		const delta = diffBoards(board, after);
		expect(delta.changedNodes).toEqual(["text-1"]);
		expect(delta.touched).toEqual(["text-1"]);
	});

	it("names a block that changed frame as re-homed, not as moved", () => {
		const board = sampleBoard();
		// Removing the frame re-homes its note one level up, keeping its place on screen.
		const after = landed(board, { op: "remove_node", id: "frame-a" });
		const delta = diffBoards(board, after);
		expect(delta.removedNodes).toEqual(["frame-a"]);
		expect(delta.reparentedNodes).toEqual(["note-1"]);
		expect(delta.movedNodes).toEqual([]);
		expect(delta.touched).toEqual(["note-1"]);
	});

	it("keeps a block that was removed out of what is touched: there is nothing left to point at", () => {
		const board = sampleBoard();
		const after = landed(board, { op: "remove_node", id: "text-1" });
		const delta = diffBoards(board, after);
		expect(delta.removedNodes).toEqual(["text-1"]);
		expect(delta.touched).toEqual([]);
		expect(isEmptyDelta(delta)).toBe(false);
	});

	it("touches both ends of an arrow that was added", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "add_edge",
			edge: { id: "edge-new", source: "note-museum", target: "todo-1" },
		});
		const delta = diffBoards(board, after);
		expect(delta.addedEdges).toEqual(["edge-new"]);
		expect(delta.touched).toEqual(["note-museum", "todo-1"]);
	});

	it("touches the ends that are left of an arrow that was removed", () => {
		const board = sampleBoard();
		const edge = board.edges[0];
		expect(edge, "the fixture has an arrow").toBeTruthy();
		const after = landed(board, { op: "remove_edge", id: edge.id });
		const delta = diffBoards(board, after);
		expect(delta.removedEdges).toEqual([edge.id]);
		expect(delta.touched.sort()).toEqual([edge.source, edge.target].sort());
	});

	it("does not touch a block twice, and lists them in the board's own order", () => {
		const board = sampleBoard();
		const after = landed(
			board,
			{ op: "move", id: "text-1", to: { x: 520, y: 210 } },
			{ op: "update_node", id: "text-1", data: { text: "Plan" } },
			{ op: "update_node", id: "frame-a", data: { label: "Sat" } },
		);
		const delta = diffBoards(board, after);
		expect(delta.touched).toEqual(["frame-a", "text-1"]);
	});

	it("sees a frame that was made bigger", () => {
		const board = sampleBoard();
		const after = landed(board, {
			op: "update_node",
			id: "frame-a",
			data: { width: 420, height: 340 },
		});
		expect(diffBoards(board, after).changedNodes).toEqual(["frame-a"]);
	});
});
