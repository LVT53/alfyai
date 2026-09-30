import { describe, expect, it } from "vitest";
import { applyOp, type BoardOp } from "./board-ops";
import type { CanvasBody } from "./canvas";
import { boardJson } from "./canvas-body";
import { sampleBoard } from "./canvas-fixtures.test-helpers";
import {
	type CanvasReviewVersion,
	computeCanvasReview,
	EMPTY_CANVAS_REVIEW,
} from "./canvas-review";

// What is still waiting for the reader on a board (ruling 63): each Alfy
// version newer than the reviewed marker, its touched blocks against its parent
// version, minus what the reader has since taken over.

function history(
	steps: {
		author: "user" | "alfy";
		ops: BoardOp[];
		summary?: string;
		body?: string;
	}[],
): CanvasReviewVersion[] {
	let board: CanvasBody = sampleBoard();
	const versions: CanvasReviewVersion[] = [
		{
			versionNumber: 1,
			author: "alfy",
			summary: "Alfy made the board",
			body: boardJson(board),
		},
	];
	for (const step of steps) {
		board = step.ops.reduce((current, op) => applyOp(current, op), board);
		versions.push({
			versionNumber: versions.length + 1,
			author: step.author,
			summary:
				step.summary ?? (step.author === "alfy" ? "Alfy's edit" : "Edited"),
			body: step.body ?? boardJson(board),
		});
	}
	return versions;
}

const MOVE_MUSEUM: BoardOp = {
	op: "move",
	id: "note-museum",
	to: { x: 700, y: 90 },
};
const RETITLE: BoardOp = {
	op: "update_node",
	id: "text-1",
	data: { text: "Weekend plan (updated)" },
};
const ADD_COFFEE: BoardOp = {
	op: "add_node",
	node: {
		id: "note-coffee",
		type: "sticky",
		position: { x: 300, y: 500 },
		data: { kind: "sticky", text: "Coffee", tone: "yellow" },
	},
};

describe("what waits for the reader", () => {
	it("is nothing for a board Alfy never edited: there is no marker", () => {
		const state = computeCanvasReview({
			throughVersion: 0,
			versions: history([{ author: "alfy", ops: [MOVE_MUSEUM] }]),
		});
		expect(state).toEqual(EMPTY_CANVAS_REVIEW);
	});

	it("is the blocks Alfy's change touched, in the board's own order", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [ADD_COFFEE, MOVE_MUSEUM, RETITLE] },
			]),
		});
		expect(state.touchedIds).toEqual(["note-museum", "text-1", "note-coffee"]);
		expect(state.count).toBe(3);
		expect(state.changes).toEqual([
			{
				versionNumber: 2,
				summary: "Alfy's edit",
				touchedIds: ["note-museum", "text-1", "note-coffee"],
				removedCount: 0,
			},
		]);
		expect(state.latestAlfyVersion).toBe(2);
	});

	it("is nothing once the marker has reached Alfy's version (Keep)", () => {
		const state = computeCanvasReview({
			throughVersion: 2,
			versions: history([{ author: "alfy", ops: [MOVE_MUSEUM] }]),
		});
		expect(state.count).toBe(0);
		expect(state.changes).toEqual([]);
		expect(state.touchedIds).toEqual([]);
	});

	it("keeps a change waiting while the reader works on something else, but Undo is no longer offered", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM] },
				{
					author: "user",
					ops: [{ op: "move", id: "todo-1", to: { x: 10, y: 10 } }],
				},
			]),
		});
		expect(state.touchedIds).toEqual(["note-museum"]);
		expect(state.undo).toEqual({ available: false, reason: "user_edited" });
	});

	it("lets the reader take a block over: their own later edit of it clears it", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM, RETITLE] },
				{
					author: "user",
					ops: [
						{ op: "update_node", id: "text-1", data: { text: "My own title" } },
					],
				},
			]),
		});
		expect(state.touchedIds).toEqual(["note-museum"]);
		expect(state.count).toBe(1);
	});

	it("is nothing when the reader has taken over every block", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM] },
				{
					author: "user",
					ops: [{ op: "move", id: "note-museum", to: { x: 20, y: 20 } }],
				},
			]),
		});
		expect(state.count).toBe(0);
		expect(state.changes).toEqual([]);
	});

	it("holds two changes of Alfy's at once, and Undo goes back to before the first", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM], summary: "First" },
				{ author: "alfy", ops: [RETITLE], summary: "Second" },
			]),
		});
		expect(state.changes.map((change) => change.versionNumber)).toEqual([2, 3]);
		expect(state.touchedIds).toEqual(["note-museum", "text-1"]);
		expect(state.latestAlfyVersion).toBe(3);
		expect(state.undo).toEqual({ available: true, toVersion: 1 });
	});

	it("gives a block to the last change that touched it", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM], summary: "First" },
				{
					author: "alfy",
					ops: [{ op: "move", id: "note-museum", to: { x: 800, y: 100 } }],
					summary: "Second",
				},
			]),
		});
		expect(state.changes).toEqual([
			{
				versionNumber: 3,
				summary: "Second",
				touchedIds: ["note-museum"],
				removedCount: 0,
			},
		]);
		// Undo takes back what Alfy did since the reader last touched the board: both.
		expect(state.undo).toEqual({ available: true, toVersion: 1 });
	});

	it("takes Undo back only to the reader's last version, when Alfy came again after it", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [MOVE_MUSEUM] },
				{
					author: "user",
					ops: [{ op: "move", id: "todo-1", to: { x: 10, y: 10 } }],
				},
				{ author: "alfy", ops: [RETITLE] },
			]),
		});
		expect(state.touchedIds).toEqual(["note-museum", "text-1"]);
		expect(state.undo).toEqual({ available: true, toVersion: 3 });
	});

	it("still asks for a review of a change that only took blocks away, and counts it once", () => {
		const state = computeCanvasReview({
			throughVersion: 1,
			versions: history([
				{ author: "alfy", ops: [{ op: "remove_node", id: "text-1" }] },
			]),
		});
		expect(state.touchedIds).toEqual([]);
		expect(state.removedCount).toBe(1);
		expect(state.count).toBe(1);
		expect(state.changes).toHaveLength(1);
		expect(state.undo).toEqual({ available: true, toVersion: 1 });
	});

	it("does not call a block removed when the reader put it back", () => {
		const board = sampleBoard();
		const back = board.nodes.find((node) => node.id === "text-1");
		expect(back).toBeTruthy();
		const versions = history([
			{ author: "alfy", ops: [{ op: "remove_node", id: "text-1" }] },
			{
				author: "user",
				ops: [],
				body: boardJson(board),
			},
		]);
		const state = computeCanvasReview({ throughVersion: 1, versions });
		expect(state.removedCount).toBe(0);
		expect(state.count).toBe(0);
	});

	it("does not offer Undo when the version before the change is gone", () => {
		const versions = history([{ author: "alfy", ops: [MOVE_MUSEUM] }]).slice(1);
		const state = computeCanvasReview({ throughVersion: 1, versions });
		expect(state.undo).toEqual({ available: false, reason: "parent_missing" });
	});

	it("reads a version whose body is not a board as an empty one, and does not throw", () => {
		const versions = history([{ author: "alfy", ops: [MOVE_MUSEUM] }]);
		versions[0] = { ...versions[0], body: "not json at all" };
		const state = computeCanvasReview({ throughVersion: 1, versions });
		// Everything on the new board is new against a board that did not read.
		expect(state.count).toBeGreaterThan(0);
	});

	it("does not offer Undo for a change that is not there any more", () => {
		const state = computeCanvasReview({
			throughVersion: 2,
			versions: history([{ author: "alfy", ops: [MOVE_MUSEUM] }]),
		});
		expect(state.undo).toEqual({ available: false, reason: "nothing_to_undo" });
	});
});
