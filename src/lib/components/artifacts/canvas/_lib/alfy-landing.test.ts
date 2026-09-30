import { describe, expect, it, vi } from "vitest";
import { applyOp, type BoardOp } from "$lib/shared/artifacts/board-ops";
import type { CanvasBody, Pt } from "$lib/shared/artifacts/canvas";
import { sampleBoard } from "$lib/shared/artifacts/canvas-fixtures.test-helpers";
import {
	easeInOut,
	HIGHLIGHT_MS,
	type LandingPort,
	MOVE_MS,
	planLanding,
	runLanding,
} from "./alfy-landing";

// How a change of Alfy's reaches the reader's eyes (spec T6, the diff path): the
// structure first (what was added or removed, in the board's own order), then
// what moved glides to its place over 620 ms, then what was touched is ringed
// for 3.2 s. The plan is pure; running it is told the clock and the port.

function landed(board: CanvasBody, ...ops: BoardOp[]): CanvasBody {
	return ops.reduce((current, op) => applyOp(current, op), board);
}

const NEW_NOTE: BoardOp = {
	op: "add_node",
	node: {
		id: "note-new",
		type: "sticky",
		position: { x: 300, y: 500 },
		data: { kind: "sticky", text: "Coffee", tone: "yellow" },
	},
};

describe("the plan for a landing", () => {
	it("keeps a block that will move where it was, so the reader sees it glide from there", () => {
		const before = sampleBoard();
		const after = landed(
			before,
			{ op: "move", id: "note-museum", to: { x: 700, y: 90 } },
			NEW_NOTE,
		);
		const plan = planLanding(before, after);

		const museum = (board: CanvasBody) =>
			board.nodes.find((node) => node.id === "note-museum")?.position;
		expect(museum(plan.structural)).toEqual({ x: 500, y: 60 });
		expect(museum(plan.final)).toEqual({ x: 700, y: 90 });
		// What is new is there from the start, in its place.
		expect(
			plan.structural.nodes.find((node) => node.id === "note-new")?.position,
		).toEqual({ x: 300, y: 500 });
		expect(plan.moves).toEqual([
			{ id: "note-museum", from: { x: 500, y: 60 }, to: { x: 700, y: 90 } },
		]);
		expect(plan.final).toBe(after);
	});

	it("puts a block Alfy took away out of the structure at once", () => {
		const before = sampleBoard();
		const after = landed(before, { op: "remove_node", id: "text-1" });
		const plan = planLanding(before, after);
		expect(plan.structural.nodes.some((node) => node.id === "text-1")).toBe(
			false,
		);
		expect(plan.moves).toEqual([]);
	});

	it("rings what changed, and what a highlight pointed at that is on the board", () => {
		const before = sampleBoard();
		const after = landed(before, NEW_NOTE);
		const plan = planLanding(before, after, ["text-1", "nowhere"]);
		expect(plan.touched).toEqual(["text-1", "note-new"]);
	});

	it("rings a highlight even when nothing else changed", () => {
		const board = sampleBoard();
		const plan = planLanding(board, board, ["todo-1"]);
		expect(plan.touched).toEqual(["todo-1"]);
		expect(plan.moves).toEqual([]);
		expect(plan.delta.touched).toEqual([]);
	});

	it("keeps the reader's marks and the camera of the board it lands", () => {
		const before = sampleBoard();
		const after = landed(before, NEW_NOTE);
		const plan = planLanding(before, after);
		expect(plan.structural.annotations).toEqual(after.annotations);
		expect(plan.structural.viewport).toEqual(after.viewport);
	});
});

describe("the ease", () => {
	it("starts at 0, ends at 1, is even around the middle and only ever goes forward", () => {
		expect(easeInOut(0)).toBe(0);
		expect(easeInOut(1)).toBe(1);
		expect(easeInOut(0.5)).toBeCloseTo(0.5, 10);
		let previous = -1;
		for (let step = 0; step <= 20; step += 1) {
			const value = easeInOut(step / 20);
			expect(value).toBeGreaterThanOrEqual(previous);
			previous = value;
		}
	});

	it("names the two durations the spec fixes", () => {
		expect(MOVE_MS).toBe(620);
		expect(HIGHLIGHT_MS).toBe(3200);
	});
});

// A clock and a frame loop the test drives by hand.
function clock() {
	let now = 1000;
	const queue: Array<(time: number) => void> = [];
	return {
		now: () => now,
		frame: (callback: (time: number) => void) => queue.push(callback),
		/** Runs every frame that is waiting, `stepMs` apart, until the loop stops asking for more. */
		async run(stepMs: number, limit = 200) {
			for (let count = 0; count < limit && queue.length > 0; count += 1) {
				now += stepMs;
				queue.shift()?.(now);
				await Promise.resolve();
			}
		},
		get waiting() {
			return queue.length;
		},
	};
}

function recordingPort() {
	const calls: string[] = [];
	const positions: Array<Map<string, Pt>> = [];
	const sets: CanvasBody[] = [];
	const port: LandingPort = {
		hold: (on) => calls.push(`hold:${on}`),
		land: (body) => {
			calls.push("land");
			sets.push(body);
		},
		place: (map) => {
			calls.push("place");
			positions.push(new Map(map));
		},
	};
	return { port, calls, positions, sets };
}

describe("running a landing", () => {
	function plan() {
		const before = sampleBoard();
		const after = landed(
			before,
			{ op: "move", id: "note-museum", to: { x: 700, y: 90 } },
			NEW_NOTE,
		);
		return planLanding(before, after);
	}

	it("draws the structure, then glides what moves, then lands exactly on the board", async () => {
		const time = clock();
		const { port, calls, positions, sets } = recordingPort();
		const done = runLanding(port, plan(), {
			reducedMotion: false,
			now: time.now,
			frame: time.frame,
		});
		// The structure is drawn before any frame is asked for.
		await vi.waitFor(() => expect(time.waiting).toBeGreaterThan(0));
		await time.run(80);
		await done;

		expect(calls[0]).toBe("hold:true");
		expect(calls[1]).toBe("land");
		expect(calls.slice(2, -2).every((call) => call === "place")).toBe(true);
		expect(calls.at(-2)).toBe("land");
		expect(calls.at(-1)).toBe("hold:false");

		// It glides: strictly between where it was and where it goes, then arrives.
		const xs = positions.map((map) => map.get("note-museum")?.x ?? 0);
		expect(xs.length).toBeGreaterThan(3);
		expect(xs.some((x) => x > 500 && x < 700)).toBe(true);
		expect(xs[xs.length - 1]).toBe(700);
		expect([...xs].sort((a, b) => a - b)).toEqual(xs);
		const last = sets.at(-1);
		expect(last?.nodes.find((n) => n.id === "note-museum")?.position).toEqual({
			x: 700,
			y: 90,
		});
	});

	it("takes 620 ms, no more", async () => {
		const time = clock();
		const { port, positions } = recordingPort();
		const done = runLanding(port, plan(), {
			reducedMotion: false,
			now: time.now,
			frame: time.frame,
		});
		await vi.waitFor(() => expect(time.waiting).toBeGreaterThan(0));
		await time.run(100);
		await done;
		// Frames 100 ms apart cover 620 ms in seven steps.
		expect(positions.length).toBe(7);
	});

	it("does not glide under reduced motion: it lands at once", async () => {
		const time = clock();
		const { port, calls } = recordingPort();
		await runLanding(port, plan(), {
			reducedMotion: true,
			now: time.now,
			frame: time.frame,
		});
		expect(calls).toEqual(["hold:true", "land", "hold:false"]);
		expect(time.waiting).toBe(0);
	});

	it("does not ask for a frame when nothing moves", async () => {
		const board = sampleBoard();
		const time = clock();
		const { port, calls } = recordingPort();
		await runLanding(port, planLanding(board, landed(board, NEW_NOTE)), {
			reducedMotion: false,
			now: time.now,
			frame: time.frame,
		});
		expect(calls).toEqual(["hold:true", "land", "hold:false"]);
	});

	it("lets go of the board even when it is abandoned half way", async () => {
		const time = clock();
		const { port, calls } = recordingPort();
		let stop = false;
		const done = runLanding(port, plan(), {
			reducedMotion: false,
			now: time.now,
			frame: time.frame,
			aborted: () => stop,
		});
		await vi.waitFor(() => expect(time.waiting).toBeGreaterThan(0));
		await time.run(100, 2);
		stop = true;
		await time.run(100);
		await done;
		expect(calls.at(-1)).toBe("hold:false");
		// It did not draw the final board over whatever replaced this one.
		expect(calls.filter((call) => call === "land").length).toBe(1);
	});
});
