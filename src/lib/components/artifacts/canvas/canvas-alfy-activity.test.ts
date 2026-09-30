import { describe, expect, it } from "vitest";
import type { RawAlfyToolCallSegment } from "../document/alfy-activity";
import { buildDocumentAlfyActivity } from "../document/alfy-activity";
import {
	acceptedCanvasOps,
	buildCanvasAlfyActivity,
	canvasOpTargets,
	highlightedByOps,
} from "./canvas-alfy-activity";

// An Alfy edit of a board, as the chat page hands it to the open panel: the
// tool call's own input (the model's raw ops) and the flat metadata the server
// leaves on the call. The same activity type the Document's is, so the chat's
// card, the panel's row and the count button's dot read it unchanged.

const MOVE = { op: "move", id: "note-museum", to: { x: 700, y: 90 } };
const ADD_NOTE = {
	op: "add_node",
	node: {
		id: "note-new",
		type: "sticky",
		parentId: "frame-a",
		position: { x: 20, y: 60 },
		data: { kind: "sticky", text: "Coffee", tone: "yellow" },
	},
};
const ARROW = {
	op: "add_edge",
	edge: { id: "edge-new", source: "note-museum", target: "todo-1" },
};
const HIGHLIGHT = { op: "highlight", ids: ["text-1", "todo-1"] };

function call(
	overrides: Partial<RawAlfyToolCallSegment> = {},
): RawAlfyToolCallSegment {
	return {
		name: "edit_artifact",
		callId: "call-1",
		status: "done",
		input: {
			artifactId: "board-1",
			summary: "Planned Sunday",
			ops: [MOVE, ADD_NOTE, ARROW],
		},
		metadata: {
			ok: true,
			artifactId: "board-1",
			artifactKind: "canvas",
			artifactTitle: "Weekend board",
			appliedCount: 3,
		},
		...overrides,
	};
}

describe("a running edit of a board", () => {
	it("reports the call, its summary and the ops it will make, before the server has said what kind of item it is", () => {
		const activity = buildCanvasAlfyActivity(
			call({ status: "running", metadata: undefined }),
		);
		expect(activity).toMatchObject({
			key: "call-1",
			artifactId: "board-1",
			toolName: "edit_artifact",
			status: "running",
			label: "Planned Sunday",
			appliedCount: 0,
			refusedBlocks: [],
		});
		expect(activity?.ops).toEqual([MOVE, ADD_NOTE, ARROW]);
	});

	it("leaves a running edit of a Document to the Document's own reading", () => {
		const running = call({
			status: "running",
			metadata: undefined,
			input: { artifactId: "doc-1", patches: [{ op: "replaceBlock" }] },
		});
		expect(buildCanvasAlfyActivity(running)).toBeNull();
		expect(buildDocumentAlfyActivity(running)).not.toBeNull();
	});
});

describe("a settled edit of a board", () => {
	it("applied: keeps the ops and counts what changed the board", () => {
		const activity = buildCanvasAlfyActivity(call());
		expect(activity).toMatchObject({
			status: "applied",
			appliedCount: 3,
			refusedBlocks: [],
			patches: [],
		});
		expect(activity?.ops).toHaveLength(3);
	});

	it("does not count a highlight as a change: it writes no version, so there is nothing to review", () => {
		const activity = buildCanvasAlfyActivity(
			call({
				input: { artifactId: "board-1", ops: [HIGHLIGHT] },
				metadata: {
					ok: true,
					artifactId: "board-1",
					artifactKind: "canvas",
					appliedCount: 1,
				},
			}),
		);
		expect(activity?.status).toBe("applied");
		expect(activity?.appliedCount).toBe(0);
	});

	it("refused: names the skipped ops by their place in the call, and leaves them out of what was accepted", () => {
		const activity = buildCanvasAlfyActivity(
			call({
				metadata: {
					ok: true,
					artifactId: "board-1",
					artifactKind: "canvas",
					appliedCount: 2,
					refusedBlocksJson: JSON.stringify([
						{ blockId: "note-museum", reason: "unknown_id", opIndex: 0 },
					]),
				},
			}),
		);
		expect(activity?.status).toBe("refused");
		expect(activity?.refusedBlocks).toEqual([
			{ blockId: "note-museum", reason: "unknown_id", opIndex: 0 },
		]);
		expect(activity?.appliedCount).toBe(2);
		expect(acceptedCanvasOps(activity as NonNullable<typeof activity>)).toEqual(
			[ADD_NOTE, ARROW],
		);
	});

	it("failed: a call that changed nothing has no ops to land", () => {
		const activity = buildCanvasAlfyActivity(
			call({
				status: "failed",
				metadata: { ok: false, artifactId: "board-1", artifactKind: "canvas" },
			}),
		);
		expect(activity).toMatchObject({ status: "failed", appliedCount: 0 });
		expect(activity?.ops ?? []).toEqual([]);
	});

	it("is not a Document's edit, nor a creation", () => {
		expect(
			buildCanvasAlfyActivity(
				call({
					metadata: {
						ok: true,
						artifactId: "doc-1",
						artifactKind: "document",
						appliedCount: 1,
					},
				}),
			),
		).toBeNull();
		expect(
			buildCanvasAlfyActivity(
				call({
					name: "create_artifact",
					input: { artifactType: "canvas", title: "Board" },
				}),
			),
		).toBeNull();
	});

	it("drops an entry of the model's that does not look like an op, and never throws", () => {
		const activity = buildCanvasAlfyActivity(
			call({
				input: {
					artifactId: "board-1",
					ops: [MOVE, null, "move", { id: "no-op-name" }, 7, ARROW],
				},
			}),
		);
		expect(activity?.ops).toEqual([MOVE, ARROW]);
	});

	it("falls back to the call's own name for the key when it has no id", () => {
		expect(buildCanvasAlfyActivity(call({ callId: undefined }))?.key).toBe(
			"edit_artifact-board-1",
		);
	});
});

describe("what the ops name", () => {
	it("lists the blocks an op addresses, once each, in the order the ops name them", () => {
		expect(canvasOpTargets([MOVE, ADD_NOTE, ARROW, HIGHLIGHT])).toEqual([
			"note-museum",
			"frame-a",
			"todo-1",
			"text-1",
		]);
	});

	it("does not count a block the ops create", () => {
		expect(
			canvasOpTargets([
				{
					op: "add_frame",
					id: "sun",
					label: "Sunday",
					position: { x: 0, y: 0 },
					size: { width: 100, height: 100 },
				},
			]),
		).toEqual([]);
	});

	it("says which blocks a highlight pointed at", () => {
		expect(highlightedByOps([MOVE, HIGHLIGHT])).toEqual(["text-1", "todo-1"]);
		expect(highlightedByOps([MOVE])).toEqual([]);
	});
});
