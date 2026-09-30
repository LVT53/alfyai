import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AlfyRawBoardOp,
	DocumentAlfyActivity,
} from "$lib/components/artifacts/document/alfy-activity";
import { applyOp, type BoardOp } from "$lib/shared/artifacts/board-ops";
import type { CanvasBody } from "$lib/shared/artifacts/canvas";
import { boardJson } from "$lib/shared/artifacts/canvas-body";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import type { CanvasReviewState } from "$lib/shared/artifacts/canvas-review";
import { uiLanguage } from "$lib/stores/settings";

const api = vi.hoisted(() => ({
	fetchCanvasReviewState: vi.fn(),
	acknowledgeCanvasReview: vi.fn(),
	fetchArtifactVersionBody: vi.fn(),
	fetchArtifact: vi.fn(),
	saveArtifactBody: vi.fn(),
}));
vi.mock("$lib/client/api/artifacts", () => api);
// No glide in these tests: what is asserted is the order of the calls and the
// state left, not the frames (`alfy-landing.test.ts` covers those).
vi.mock("$lib/utils/motion", () => ({
	prefersReducedMotion: () => true,
}));

import * as landing from "./alfy-landing";
import { ARRANGING_MIN_MS, HIGHLIGHT_MS } from "./alfy-landing";
import {
	CanvasReviewController,
	type LandingBoard,
	type ReviewHost,
} from "./review-controller.svelte";

// The state behind Alfy's change to a board: the arranging frame while the call
// runs, the landing, the pending change (Keep, Undo, Redo, the stepper) and the
// refusal notice. Driven with a fake board and a fake network; what the
// reader sees is in the components' own tests and the e2e specs.

function landed(board: CanvasBody, ...ops: BoardOp[]): CanvasBody {
	return ops.reduce((current, op) => applyOp(current, op), board);
}

const MOVE: BoardOp = { op: "move", id: "note-museum", to: { x: 700, y: 90 } };
const RETITLE: BoardOp = {
	op: "update_node",
	id: "text-1",
	data: { text: "Weekend plan (updated)" },
};

function reviewState(
	overrides: Partial<CanvasReviewState> = {},
): CanvasReviewState {
	return {
		changes: [
			{
				versionNumber: 2,
				summary: "Planned Sunday",
				touchedIds: ["note-museum", "text-1"],
				removedCount: 0,
			},
		],
		touchedIds: ["note-museum", "text-1"],
		removedCount: 0,
		count: 2,
		latestAlfyVersion: 2,
		undo: { available: true, toVersion: 1, toVersionId: "v1" },
		...overrides,
	};
}

function fakeBoard(initial: CanvasBody) {
	const calls: string[] = [];
	let body = initial;
	const board: LandingBoard = {
		current: () => body,
		land: (next) => {
			calls.push("land");
			body = next;
		},
		place: () => calls.push("place"),
		hold: (on) => calls.push(`hold:${on}`),
	};
	return { board, calls, body: () => body };
}

function make(options: { board?: CanvasBody; mounted?: boolean } = {}) {
	const surface = fakeBoard(options.board ?? sampleBoard());
	const host = {
		artifactId: "board-1",
		conversationId: "conv-1" as string | null,
		board: vi.fn(() => (options.mounted === false ? null : surface.board)),
		saveNow: vi.fn().mockResolvedValue(undefined),
		// The editor's own bookkeeping: version 2 before Undo writes, 3 after.
		guard: vi
			.fn()
			.mockReturnValueOnce({ version: 2, bodyHash: "h2" })
			.mockReturnValue({ version: 3, bodyHash: "h3" }),
		saved: vi.fn(),
		adopt: vi.fn<ReviewHost["adopt"]>(() => null),
		openVersions: vi.fn(),
		reportCount: vi.fn(),
	};
	return { controller: new CanvasReviewController(host), host, surface };
}

beforeEach(() => {
	vi.useFakeTimers();
	uiLanguage.set("en");
	for (const fn of Object.values(api)) fn.mockReset();
	api.fetchCanvasReviewState.mockResolvedValue(reviewState());
	api.acknowledgeCanvasReview.mockResolvedValue(
		reviewState({ count: 0, touchedIds: [], changes: [] }),
	);
	api.saveArtifactBody.mockResolvedValue({
		ok: true,
		version: 3,
		bodyHash: "h3",
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("while Alfy arranges", () => {
	it("frames the blocks the ops address and names the summary", () => {
		const { controller } = make();
		controller.beginArranging({
			label: "Planned Sunday",
			ops: [MOVE, RETITLE] as AlfyRawBoardOp[],
		});
		expect(controller.arranging).toEqual({
			label: "Planned Sunday",
			ids: ["note-museum", "text-1"],
		});
		expect(controller.working).toBe(true);
	});

	it("is seen for at least 600 ms, even when the call was faster", async () => {
		const { controller } = make();
		controller.beginArranging({ label: null, ops: [MOVE] as AlfyRawBoardOp[] });
		const ended = controller.endArranging();
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS - 50);
		expect(controller.arranging).not.toBeNull();
		await vi.advanceTimersByTimeAsync(60);
		await ended;
		expect(controller.arranging).toBeNull();
		expect(controller.working).toBe(false);
	});

	it("goes at once when the call took longer than that", async () => {
		const { controller } = make();
		controller.beginArranging({ label: null, ops: [] });
		await vi.advanceTimersByTimeAsync(2000);
		await controller.endArranging();
		expect(controller.arranging).toBeNull();
	});
});

describe("a change lands", () => {
	it("draws the board, rings what changed, and shows what waits for the reader", async () => {
		const { controller, host, surface } = make();
		const after = landed(sampleBoard(), MOVE, RETITLE);
		await controller.landChange(after);

		expect(surface.calls[0]).toBe("hold:true");
		expect(surface.calls.at(-1)).toBe("hold:false");
		expect(surface.body()).toBe(after);
		expect(controller.pulseIds).toEqual(["note-museum", "text-1"]);
		expect(controller.change).toMatchObject({
			touched: ["note-museum", "text-1"],
			summary: "Planned Sunday",
			through: 2,
		});
		expect(controller.status).toBe("pending");
		expect(controller.count).toBe(2);
		expect(controller.rings).toEqual(["note-museum", "text-1"]);
		expect(host.reportCount).toHaveBeenLastCalledWith(2);
		expect(controller.announcement).toMatch(/Alfy changed 2 blocks/);
	});

	it("settles the strong ring to a resting one after 3.2 s, and keeps the change waiting", async () => {
		const { controller } = make();
		await controller.landChange(landed(sampleBoard(), MOVE));
		expect(controller.pulseIds.length).toBeGreaterThan(0);
		await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS + 10);
		expect(controller.pulseIds).toEqual([]);
		expect(controller.rings).toEqual(["note-museum", "text-1"]);
		expect(controller.change).not.toBeNull();
	});

	it("waits for a landing that is running instead of interleaving with it", async () => {
		const { controller, surface } = make();
		const order: string[] = [];
		const first = landed(sampleBoard(), MOVE);
		const second = landed(first, RETITLE);
		const original = surface.board.land;
		surface.board.land = (body) => {
			order.push(body === first ? "first" : body === second ? "second" : "?");
			original(body);
		};
		const one = controller.landChange(first);
		const two = controller.landChange(second);
		expect(controller.working).toBe(true);
		await Promise.all([one, two]);
		expect(order).toEqual(["first", "second"]);
		expect(surface.body()).toBe(second);
		expect(controller.working).toBe(false);
	});

	it("rings a highlight and asks for nothing to review when it changed nothing", async () => {
		const { controller, host } = make();
		api.fetchCanvasReviewState.mockResolvedValue(
			reviewState({ count: 0, touchedIds: [], changes: [] }),
		);
		await controller.landChange(sampleBoard(), { highlight: ["todo-1"] });
		expect(controller.pulseIds).toEqual(["todo-1"]);
		expect(controller.change).toBeNull();
		expect(controller.count).toBe(0);
		expect(host.reportCount).toHaveBeenLastCalledWith(0);
		await vi.advanceTimersByTimeAsync(HIGHLIGHT_MS + 10);
		expect(controller.rings).toEqual([]);
	});

	it("says what is on screen even when the server cannot be asked", async () => {
		const { controller, surface } = make();
		api.fetchCanvasReviewState.mockRejectedValue(new Error("offline"));
		const after = landed(sampleBoard(), MOVE);
		await controller.landChange(after);
		// The board is drawn and the strong ring shows; nothing is claimed about review.
		expect(surface.body()).toBe(after);
		expect(controller.pulseIds).toEqual(["note-museum"]);
		expect(controller.change).toBeNull();
	});

	it("does nothing when the board is not on screen any more", async () => {
		const { controller, host } = make({ mounted: false });
		await controller.landChange(landed(sampleBoard(), MOVE));
		expect(controller.change).toBeNull();
		expect(host.reportCount).not.toHaveBeenCalled();
	});
});

describe("what Alfy skipped", () => {
	it("names each skipped op by its block's own words and the reason, in the reader's language", async () => {
		const { controller } = make();
		const ops = [
			MOVE,
			{ op: "move", id: "ghost", to: { x: 1, y: 1 } },
		] as AlfyRawBoardOp[];
		await controller.settleActivity(
			{
				key: "call-1",
				artifactId: "board-1",
				toolName: "edit_artifact",
				status: "refused",
				label: null,
				patches: [],
				ops,
				refusedBlocks: [{ blockId: "ghost", reason: "unknown_id", opIndex: 1 }],
				appliedCount: 1,
			},
			landed(sampleBoard(), MOVE),
		);
		expect(controller.refusal?.message).toBe("Alfy skipped 1 change.");
		expect(controller.refusal?.items).toEqual([
			{ label: "ghost", reason: "nothing is at that position any more" },
		]);
		expect(controller.canSeeChange).toBe(true);
		controller.dismissRefusal();
		expect(controller.refusal).toBeNull();
	});

	it("tells a highlight-only call from one that changed the board: it rings and does not fetch a board", async () => {
		const { controller, surface } = make();
		await controller.settleActivity(
			{
				key: "call-2",
				artifactId: "board-1",
				toolName: "edit_artifact",
				status: "applied",
				label: null,
				patches: [],
				ops: [{ op: "highlight", ids: ["todo-1"] }] as AlfyRawBoardOp[],
				refusedBlocks: [],
				appliedCount: 0,
			},
			null,
		);
		expect(controller.pulseIds).toEqual(["todo-1"]);
		expect(surface.calls).toEqual([]);
	});
});

describe("after a reload", () => {
	it("shows what waits without a landing, and tells the count", () => {
		const { controller, host, surface } = make();
		controller.restore(reviewState());
		expect(controller.count).toBe(2);
		expect(controller.pulseIds).toEqual([]);
		expect(controller.rings).toEqual(["note-museum", "text-1"]);
		expect(host.reportCount).toHaveBeenCalledWith(2);
		expect(surface.calls).toEqual([]);
	});

	it("does not tell the count of a board with nothing waiting: that is not something this panel decided", () => {
		const { controller, host } = make();
		controller.restore(reviewState({ count: 0, touchedIds: [], changes: [] }));
		expect(controller.change).toBeNull();
		expect(host.reportCount).not.toHaveBeenCalled();
	});
});

describe("Keep", () => {
	it("moves the marker past the change it showed, tells the count at once, and fades", async () => {
		const { controller, host } = make();
		controller.restore(reviewState());
		const kept = controller.keep();
		expect(controller.status).toBe("kept");
		expect(host.reportCount).toHaveBeenLastCalledWith(0);
		await kept;
		expect(api.acknowledgeCanvasReview).toHaveBeenCalledWith(
			"board-1",
			2,
			"conv-1",
		);
		expect(controller.change).not.toBeNull();
		await vi.advanceTimersByTimeAsync(1450);
		expect(controller.change).toBeNull();
		expect(controller.rings).toEqual([]);
		expect(controller.count).toBe(0);
	});

	it("still keeps it on screen when the server could not be told: it comes back after a reload", async () => {
		const { controller } = make();
		api.acknowledgeCanvasReview.mockRejectedValue(new Error("offline"));
		controller.restore(reviewState());
		await controller.keep();
		await vi.advanceTimersByTimeAsync(1450);
		expect(controller.change).toBeNull();
	});
});

describe("Undo", () => {
	function armed() {
		const parent = sampleBoard();
		api.fetchArtifactVersionBody.mockResolvedValue(boardJson(parent));
		const made = make({ board: landed(parent, MOVE, RETITLE) });
		made.controller.restore(reviewState());
		return { ...made, parent };
	}

	it("saves the parent's board back as the reader's own version, then draws it", async () => {
		const { controller, host, surface, parent } = armed();
		await controller.undo();
		expect(host.saveNow).toHaveBeenCalledBefore(api.fetchCanvasReviewState);
		expect(api.fetchArtifactVersionBody).toHaveBeenCalledWith(
			"board-1",
			"v1",
			"conv-1",
		);
		// A version of the reader's own, of its own (never merged into the one before),
		// checked against the version and hash the editor last saw.
		expect(api.saveArtifactBody).toHaveBeenCalledWith(
			"board-1",
			boardJson(parent),
			2,
			"conv-1",
			undefined,
			{ baseHash: "h2", coalesce: false, summaryKind: "undid_alfy_change" },
		);
		// The editor takes the saved board, and the version and hash that came with it.
		expect(host.saved).toHaveBeenCalledWith({
			board: parent,
			json: boardJson(parent),
			version: 3,
			bodyHash: "h3",
		});
		expect(api.acknowledgeCanvasReview).toHaveBeenCalledWith(
			"board-1",
			2,
			"conv-1",
		);
		expect(controller.status).toBe("undone");
		expect(
			surface.body().nodes.find((n) => n.id === "note-museum")?.position,
		).toEqual({ x: 500, y: 60 });
		expect(host.reportCount).toHaveBeenLastCalledWith(0);
		expect(controller.busy).toBe(false);
	});

	it("is refused after the reader changed the board: it writes nothing and points to History", async () => {
		const { controller, host } = armed();
		api.fetchCanvasReviewState.mockResolvedValue(
			reviewState({ undo: { available: false, reason: "user_edited" } }),
		);
		await controller.undo();
		expect(controller.undoRefused).toBe("user_edited");
		expect(api.saveArtifactBody).not.toHaveBeenCalled();
		expect(controller.status).toBe("pending");
		controller.openHistory();
		expect(host.openVersions).toHaveBeenCalled();
		controller.dismissUndoRefused();
		expect(controller.undoRefused).toBeNull();
	});

	it("is refused when the save is refused as stale: somebody saved in between", async () => {
		const { controller, host } = armed();
		api.saveArtifactBody.mockResolvedValue({ ok: false, reason: "stale" });
		await controller.undo();
		expect(controller.undoRefused).toBe("user_edited");
		expect(controller.status).toBe("pending");
		expect(host.saved).not.toHaveBeenCalled();
	});

	it("says it could not when the parent's board cannot be read", async () => {
		const { controller, host } = armed();
		api.fetchArtifactVersionBody.mockRejectedValue(new Error("offline"));
		await controller.undo();
		expect(controller.undoRefused).toBe("failed");
		expect(api.saveArtifactBody).not.toHaveBeenCalled();
		expect(host.saved).not.toHaveBeenCalled();
	});

	it("takes one press at a time", async () => {
		const { controller } = armed();
		await Promise.all([controller.undo(), controller.undo()]);
		expect(api.saveArtifactBody).toHaveBeenCalledTimes(1);
	});

	it("can be redone within its window, which puts Alfy's board back as the reader's own edit", async () => {
		const { controller, host } = armed();
		const alfyBody = boardJson(host.board()?.current() as CanvasBody);
		await controller.undo();
		await controller.redo();
		// Checked against what Undo just wrote (version 3): a step of the reader's in
		// between would refuse it instead of being written over.
		expect(api.saveArtifactBody).toHaveBeenLastCalledWith(
			"board-1",
			alfyBody,
			3,
			"conv-1",
			undefined,
			{ baseHash: "h3", coalesce: false, summaryKind: undefined },
		);
		expect(controller.status).toBe("pending");
		expect(controller.count).toBe(2);
	});

	it("can be redone while the board is still gliding back: Redo waits its turn instead of being ignored", async () => {
		const { controller } = armed();
		let finish: () => void = () => {};
		const slow = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const draw = vi.spyOn(landing, "runLanding");
		draw.mockImplementationOnce(() => slow);
		const undoing = controller.undo();
		await vi.waitFor(() => expect(controller.status).toBe("undone"));
		// The glide back is still drawing; the reader presses Redo now.
		const redoing = controller.redo();
		await vi.waitFor(() =>
			expect(api.saveArtifactBody).toHaveBeenCalledTimes(2),
		);
		finish();
		await Promise.all([undoing, redoing]);
		expect(controller.status).toBe("pending");
		draw.mockRestore();
	});

	it("is refused when the reader changed the board after the Undo: it does not write over their step", async () => {
		const { controller, host } = armed();
		await controller.undo();
		api.saveArtifactBody.mockResolvedValue({ ok: false, reason: "stale" });
		await controller.redo();
		expect(controller.undoRefused).toBe("failed");
		expect(controller.status).toBe("undone");
		expect(host.saved).toHaveBeenCalledTimes(1);
	});

	it("lets the Undo go after five seconds", async () => {
		const { controller } = armed();
		await controller.undo();
		await vi.advanceTimersByTimeAsync(5100);
		expect(controller.change).toBeNull();
		await controller.redo();
		expect(controller.status).toBe("pending");
	});
});

describe("stepping through the blocks", () => {
	it("goes round and asks the board to show the block it landed on", () => {
		const { controller } = make();
		controller.restore(reviewState());
		expect(controller.index).toBe(0);
		controller.step(1);
		expect(controller.index).toBe(1);
		expect(controller.goto?.id).toBe("text-1");
		controller.step(1);
		expect(controller.index).toBe(0);
		controller.step(-1);
		expect(controller.index).toBe(1);
		expect(controller.activeId).toBe("text-1");
	});

	it("has nothing to step to when a change only took blocks away, and still counts as one change", () => {
		const { controller } = make();
		controller.restore(
			reviewState({
				touchedIds: [],
				removedCount: 2,
				count: 1,
				changes: [
					{
						versionNumber: 2,
						summary: "Tidied",
						touchedIds: [],
						removedCount: 2,
					},
				],
			}),
		);
		expect(controller.count).toBe(1);
		controller.step(1);
		expect(controller.goto).toBeNull();
		expect(controller.summaryText).toBe("Alfy removed 2 blocks.");
	});
});

describe("the comment reply that made the change", () => {
	it("wears the change's own state as a chip, and follows it", async () => {
		const { controller } = make();
		controller.linkReply("reply-1");
		controller.restore(reviewState());
		expect(controller.changeStates).toEqual({ "reply-1": "pending" });
		await controller.keep();
		expect(controller.changeStates).toEqual({ "reply-1": "kept" });
	});
});

describe("what the bar says", () => {
	it("counts blocks, in either language", () => {
		const { controller } = make();
		controller.restore(reviewState());
		expect(controller.summaryText).toBe("Alfy changed 2 blocks.");
		uiLanguage.set("hu");
		expect(controller.summaryText).toBe("Alfy 2 blokkot módosított.");
	});
});

describe("a call of Alfy's on this board", () => {
	function call(
		overrides: Partial<DocumentAlfyActivity> = {},
	): DocumentAlfyActivity {
		return {
			key: "call-1",
			artifactId: "board-1",
			toolName: "edit_artifact",
			status: "running",
			label: "Planned Sunday",
			patches: [],
			ops: [MOVE] as AlfyRawBoardOp[],
			refusedBlocks: [],
			appliedCount: 0,
			...overrides,
		};
	}
	const settled = (overrides: Partial<DocumentAlfyActivity> = {}) =>
		call({ status: "applied", appliedCount: 1, ...overrides });

	it("frames what it addresses once, however often the page hands over the same running call", () => {
		const { controller } = make();
		controller.onActivity(call(), { settledAtMount: null, ready: true });
		const first = controller.arranging;
		controller.onActivity(call(), { settledAtMount: null, ready: true });
		expect(controller.arranging).toBe(first);
		expect(first?.ids).toEqual(["note-museum"]);
	});

	it("reads the board again and draws it when the call settles, once", async () => {
		const after = landed(sampleBoard(), MOVE);
		const { controller, host, surface } = make();
		api.fetchArtifact.mockResolvedValue({
			artifact: {},
			versions: [],
			comments: [],
		});
		host.adopt.mockReturnValue(after);
		controller.onActivity(call(), { settledAtMount: null, ready: true });
		controller.onActivity(settled(), { settledAtMount: null, ready: true });
		controller.onActivity(settled(), { settledAtMount: null, ready: true });
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(api.fetchArtifact).toHaveBeenCalledTimes(1);
		expect(surface.body()).toBe(after);
		expect(controller.change?.summary).toBe("Planned Sunday");
		expect(controller.arranging).toBeNull();
	});

	it("shows Alfy arranging for a call that settled before it ever rendered as running", async () => {
		const { controller, host } = make();
		api.fetchArtifact.mockResolvedValue({
			artifact: {},
			versions: [],
			comments: [],
		});
		host.adopt.mockReturnValue(landed(sampleBoard(), MOVE));
		controller.onActivity(settled(), { settledAtMount: null, ready: true });
		expect(controller.arranging?.label).toBe("Planned Sunday");
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(controller.arranging).toBeNull();
	});

	it("leaves a call that had already settled when the panel was built to the server's state", async () => {
		const { controller } = make();
		controller.onActivity(settled(), { settledAtMount: "call-1", ready: true });
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(api.fetchArtifact).not.toHaveBeenCalled();
		expect(controller.arranging).toBeNull();
		expect(controller.change).toBeNull();
	});

	it("waits for the board to be on screen, and is handed the call again when it is", async () => {
		const { controller, host } = make();
		api.fetchArtifact.mockResolvedValue({
			artifact: {},
			versions: [],
			comments: [],
		});
		host.adopt.mockReturnValue(landed(sampleBoard(), MOVE));
		controller.onActivity(settled(), { settledAtMount: null, ready: false });
		await vi.advanceTimersByTimeAsync(10);
		expect(api.fetchArtifact).not.toHaveBeenCalled();
		controller.onActivity(settled(), { settledAtMount: null, ready: true });
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(api.fetchArtifact).toHaveBeenCalledTimes(1);
	});

	it("does not read the board for a call that changed nothing on it, and only rings a highlight", async () => {
		const { controller } = make();
		controller.onActivity(
			settled({
				appliedCount: 0,
				ops: [{ op: "highlight", ids: ["todo-1"] }] as AlfyRawBoardOp[],
			}),
			{ settledAtMount: null, ready: true },
		);
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(api.fetchArtifact).not.toHaveBeenCalled();
		expect(controller.pulseIds).toEqual(["todo-1"]);
	});

	it("lets the frame go for a call that failed", async () => {
		const { controller } = make();
		controller.onActivity(call(), { settledAtMount: null, ready: true });
		controller.onActivity(call({ status: "failed" }), {
			settledAtMount: null,
			ready: true,
		});
		await vi.advanceTimersByTimeAsync(ARRANGING_MIN_MS + 50);
		expect(controller.arranging).toBeNull();
		expect(api.fetchArtifact).not.toHaveBeenCalled();
	});
});

describe("the chord for Alfy's change", () => {
	function press(shiftKey = false) {
		return new KeyboardEvent("keydown", {
			key: shiftKey ? "Z" : "z",
			code: "KeyZ",
			ctrlKey: true,
			altKey: true,
			shiftKey,
			cancelable: true,
		});
	}

	beforeEach(() => {
		// Ctrl is the command key off a Mac.
		vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
	});
	afterEach(() => vi.restoreAllMocks());

	it("undoes a change that waits, and redoes it once undone; never the reader's own undo", async () => {
		api.fetchArtifactVersionBody.mockResolvedValue(boardJson(sampleBoard()));
		const { controller } = make({ board: landed(sampleBoard(), MOVE) });
		controller.restore(reviewState());
		const undo = press();
		controller.handleKey(undo);
		expect(undo.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(controller.status).toBe("undone"));
		const redo = press(true);
		controller.handleKey(redo);
		expect(redo.defaultPrevented).toBe(true);
		await vi.waitFor(() => expect(controller.status).toBe("pending"));
		// The reader's own undo (no Alt) is not this one's.
		const own = new KeyboardEvent("keydown", {
			key: "z",
			ctrlKey: true,
			cancelable: true,
		});
		controller.handleKey(own);
		expect(own.defaultPrevented).toBe(false);
	});

	it("does nothing when there is no change to undo", () => {
		const { controller } = make();
		const event = press();
		controller.handleKey(event);
		expect(event.defaultPrevented).toBe(false);
	});
});
