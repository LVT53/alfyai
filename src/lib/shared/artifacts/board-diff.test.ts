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

// F12 (the friction audit, ruling 77): a change is counted as the reader sees it.
// "Add a note next to this one" made four changes on the card ("4 módosítás vár
// rád"): the note, the frame that grew to hold it, the other frame that moved to
// make room, and the far end of the arrow Alfy drew to it. A rewrite of a note
// arrived as one removed block and one added. What the reader sees is one note.
describe("what a change touched, as the reader sees it", () => {
	/** The fixture with a second frame to its right: the one a grown frame pushes aside. */
	function twoFrames(): CanvasBody {
		return landed(sampleBoard(), {
			op: "add_frame",
			id: "frame-b",
			label: "Sunday",
			position: { x: 700, y: 40 },
			size: { width: 300, height: 300 },
		});
	}

	const ADD_NOTE: BoardOp = {
		op: "add_node",
		node: {
			id: "note-new",
			type: "sticky",
			parentId: "frame-a",
			position: { x: 230, y: 60 },
			data: { kind: "sticky", text: "Schönbrunn, 9:00", tone: "mint" },
		},
	};

	it("counts one note added as one block, though a frame grew, another moved and an arrow was drawn", () => {
		const before = twoFrames();
		const after = landed(
			before,
			ADD_NOTE,
			{ op: "update_node", id: "frame-a", data: { width: 460, height: 300 } },
			{ op: "move", id: "frame-b", to: { x: 760, y: 40 } },
			{
				op: "add_edge",
				edge: { id: "edge-new", source: "note-new", target: "note-museum" },
			},
		);
		const delta = diffBoards(before, after);
		expect(delta.touched).toEqual(["note-new"]);
		// What happened is still all there for a reader who asks (History), and for the glide.
		expect(delta.addedNodes).toEqual(["note-new"]);
		expect(delta.changedNodes).toEqual(["frame-a"]);
		expect(delta.movedNodes.map((move) => move.id)).toEqual(["frame-b"]);
		expect(delta.addedEdges).toEqual(["edge-new"]);
	});

	it("keeps a frame that grew on its own as a change of its own: nothing was added to make room for", () => {
		const before = twoFrames();
		const after = landed(
			before,
			{ op: "update_node", id: "frame-a", data: { width: 460, height: 300 } },
			{ op: "move", id: "frame-b", to: { x: 760, y: 40 } },
		);
		expect(diffBoards(before, after).touched).toEqual(["frame-a", "frame-b"]);
	});

	it("keeps a frame the change renamed, even when a block was added in the same change", () => {
		const before = twoFrames();
		const after = landed(before, ADD_NOTE, {
			op: "update_node",
			id: "frame-b",
			data: { label: "Sunday and Monday" },
		});
		// In the board's own order (frame-b was there first); the frame that grew to hold the note is not here.
		expect(diffBoards(before, after).touched).toEqual(["frame-b", "note-new"]);
	});

	it("keeps a block that was moved when a block was added: only a frame goes aside for room", () => {
		const before = twoFrames();
		const after = landed(before, ADD_NOTE, {
			op: "move",
			id: "note-museum",
			to: { x: 540, y: 60 },
		});
		expect(diffBoards(before, after).touched).toEqual([
			"note-museum",
			"note-new",
		]);
	});

	it("touches both ends of an arrow between two blocks that were already there", () => {
		const before = twoFrames();
		const after = landed(before, {
			op: "add_edge",
			edge: { id: "edge-new", source: "note-museum", target: "todo-1" },
		});
		expect(diffBoards(before, after).touched).toEqual([
			"note-museum",
			"todo-1",
		]);
	});

	describe("a block rewritten", () => {
		const REWRITE: BoardOp[] = [
			{ op: "remove_node", id: "note-museum" },
			{
				op: "add_node",
				node: {
					id: "note-museum-new",
					type: "sticky",
					position: { x: 500, y: 60 },
					data: {
						kind: "sticky",
						text: "Museum, 14:00, with the audio guide",
						tone: "mint",
					},
				},
			},
		];

		it("is one block changed: the new note is touched, and the old one is named as what it replaced", () => {
			const before = sampleBoard();
			const delta = diffBoards(before, landed(before, ...REWRITE));
			expect(delta.replacedNodes).toEqual([
				{ from: "note-museum", to: "note-museum-new" },
			]);
			expect(delta.touched).toEqual(["note-museum-new"]);
			// A reader of History still sees what was written to the board.
			expect(delta.removedNodes).toEqual(["note-museum"]);
			expect(delta.addedNodes).toEqual(["note-museum-new"]);
		});

		it("is found where the new block sits near the old one, not only exactly on it", () => {
			const before = sampleBoard();
			const nudged = landed(
				before,
				{ op: "remove_node", id: "note-museum" },
				{
					op: "add_node",
					node: {
						id: "note-museum-new",
						type: "sticky",
						position: { x: 524, y: 72 },
						data: { kind: "sticky", text: "Museum", tone: "mint" },
					},
				},
			);
			expect(diffBoards(before, nudged).replacedNodes).toHaveLength(1);
		});

		it("is not found for a block of another kind, in another frame, or far from where the old one was", () => {
			const before = sampleBoard();
			const replacement = (patch: Record<string, unknown>) =>
				landed(before, { op: "remove_node", id: "note-museum" }, {
					op: "add_node",
					node: {
						id: "note-other",
						type: "sticky",
						position: { x: 500, y: 60 },
						data: { kind: "sticky", text: "Museum", tone: "mint" },
						...patch,
					},
				} as BoardOp);
			expect(
				diffBoards(
					before,
					replacement({ type: "text", data: { kind: "text", text: "Museum" } }),
				).replacedNodes,
			).toEqual([]);
			expect(
				diffBoards(before, replacement({ parentId: "frame-a" })).replacedNodes,
			).toEqual([]);
			expect(
				diffBoards(before, replacement({ position: { x: 900, y: 600 } }))
					.replacedNodes,
			).toEqual([]);
		});

		it("takes each old block for one new block only, the nearest", () => {
			const before = sampleBoard();
			const after = landed(
				before,
				{ op: "remove_node", id: "note-museum" },
				{
					op: "add_node",
					node: {
						id: "far",
						type: "sticky",
						position: { x: 530, y: 80 },
						data: { kind: "sticky", text: "Far", tone: "mint" },
					},
				},
				{
					op: "add_node",
					node: {
						id: "near",
						type: "sticky",
						position: { x: 502, y: 61 },
						data: { kind: "sticky", text: "Near", tone: "mint" },
					},
				},
			);
			const delta = diffBoards(before, after);
			expect(delta.replacedNodes).toEqual([
				{ from: "note-museum", to: "near" },
			]);
			expect(delta.touched).toEqual(["far", "near"]);
		});
	});
});
