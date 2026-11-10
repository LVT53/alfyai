// @vitest-environment node
import { once } from "node:events";
import type { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDecodePool } from "./decode-pool";
import {
	ImageDecodeTimeoutError,
	ImageDecodeUnavailableError,
	ImagePreparationError,
} from "./image-errors";

// Every worker the pool starts, in order, with a promise for its `exit`. The
// pool's own listeners are added after the recorder's, so by the time the
// promise has settled the pool has already handled the exit.
type Recorded = Worker & { readonly exited: Promise<number> };
const spawned = vi.hoisted(() => ({
	workers: [] as unknown[],
	/** While set, `new Worker` throws it, as a system that cannot make a thread does. */
	refuse: null as Error | null,
}));
const startedWorkers = () => spawned.workers as Recorded[];

vi.mock("node:worker_threads", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:worker_threads")>();
	class RecordingWorker extends actual.Worker {
		readonly exited: Promise<number>;
		constructor(...args: ConstructorParameters<typeof actual.Worker>) {
			if (spawned.refuse) throw spawned.refuse;
			super(...args);
			this.exited = new Promise((resolve) => this.once("exit", resolve));
			spawned.workers.push(this);
		}
	}
	return { ...actual, Worker: RecordingWorker };
});

// One source with a mode per behaviour, as a pool's source is one string.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
switch (workerData.mode) {
	case "answer":
		parentPort.postMessage({ answer: workerData.value });
		break;
	case "gate":
		// Holds until the main thread opens the gate it shared.
		Atomics.wait(new Int32Array(workerData.gate), 0, 0);
		parentPort.postMessage({ answer: workerData.value });
		break;
	case "spin":
		for (;;) {}
	case "throw-in-timer":
		setTimeout(() => { throw new Error("boom in a timer"); }, 0);
		break;
	case "exit":
		process.exit(7);
	case "silent":
		break;
	case "two-answers":
		parentPort.postMessage({ n: 1 });
		parentPort.postMessage({ n: 2 });
		break;
}
`;

type Answer = { answer: string };

function gate() {
	const shared = new SharedArrayBuffer(4);
	const flag = new Int32Array(shared);
	return {
		shared,
		open() {
			Atomics.store(flag, 0, 1);
			Atomics.notify(flag, 0);
		},
	};
}

const answering = (value: string) => ({
	workerData: { mode: "answer", value },
});

function pool(options: { concurrency?: number; timeoutMs?: number } = {}) {
	return createDecodePool({
		concurrency: options.concurrency ?? 2,
		timeoutMs: options.timeoutMs ?? 10_000,
		source: SOURCE,
	});
}

beforeEach(() => {
	spawned.workers.length = 0;
	spawned.refuse = null;
});

afterEach(() => {
	vi.useRealTimers();
});

describe("a decode pool", () => {
	it("answers with the first message its worker posts", async () => {
		const decode = pool();

		expect(await decode.run<Answer>(answering("hello"))).toEqual({
			answer: "hello",
		});
		// And the worker is let go: it exits once it has answered.
		await startedWorkers()[0].exited;
		expect([decode.running, decode.waiting]).toEqual([0, 0]);
	});

	it("takes the first message as the answer and ignores any later one", async () => {
		const decode = pool();

		expect(await decode.run({ workerData: { mode: "two-answers" } })).toEqual({
			n: 1,
		});
	});

	it("holds a third job while two run, and starts it when one ends", async () => {
		const decode = pool({ concurrency: 2 });
		const gates = [gate(), gate(), gate()];

		const jobs = gates.map((held, index) =>
			decode.run<Answer>({
				workerData: { mode: "gate", gate: held.shared, value: `job ${index}` },
			}),
		);
		expect([decode.running, decode.waiting]).toEqual([2, 1]);
		expect(startedWorkers()).toHaveLength(2);

		gates[0].open();
		expect(await jobs[0]).toEqual({ answer: "job 0" });
		await startedWorkers()[0].exited;
		// Its place is free again, and the third job has taken it while the
		// second one is still held.
		expect([decode.running, decode.waiting]).toEqual([2, 0]);
		expect(startedWorkers()).toHaveLength(3);

		gates[2].open();
		expect(await jobs[2]).toEqual({ answer: "job 2" });
		gates[1].open();
		expect(await jobs[1]).toEqual({ answer: "job 1" });
		await Promise.all(startedWorkers().map((worker) => worker.exited));
		expect([decode.running, decode.waiting]).toEqual([0, 0]);
	});

	it("starts waiting jobs in the order they were asked for", async () => {
		const decode = pool({ concurrency: 1 });
		const finished: string[] = [];

		await Promise.all(
			["a", "b", "c", "d"].map((value) =>
				decode
					.run<Answer>(answering(value))
					.then((answer) => finished.push(answer.answer)),
			),
		);

		expect(finished).toEqual(["a", "b", "c", "d"]);
	});

	describe("a worker that never answers", () => {
		it("is terminated at the timeout, and the next job runs", async () => {
			const decode = pool({ concurrency: 1, timeoutMs: 50 });

			const stuck = decode.run({ workerData: { mode: "spin" } });
			const next = decode.run<Answer>(answering("after"));
			const rejection = expect(stuck).rejects.toMatchObject({
				name: "ImageDecodeTimeoutError",
				timeoutMs: 50,
			});

			await rejection;
			await expect(stuck).rejects.toBeInstanceOf(ImageDecodeTimeoutError);
			// Its place stays taken until the thread has really gone, so the next
			// job has no worker yet.
			expect(startedWorkers()).toHaveLength(1);
			expect(decode.running).toBe(1);
			// The thread does go, though it was spinning: a loop that never ends
			// does not exit by itself.
			await startedWorkers()[0].exited;
			expect(await next).toEqual({ answer: "after" });
		});

		it("counts the time from the worker's start, not from the request", async () => {
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const decode = pool({ concurrency: 1, timeoutMs: 1_000 });
			const held = gate();

			const first = decode.run<Answer>({
				workerData: { mode: "gate", gate: held.shared, value: "first" },
			});
			const second = decode.run<Answer>(answering("second"));
			// Most of a timeout has passed since both were asked for, and the
			// second one has spent it waiting.
			vi.advanceTimersByTime(900);
			held.open();
			expect(await first).toEqual({ answer: "first" });
			await startedWorkers()[0].exited;
			// The second worker has just started. More than one timeout has now
			// passed since the request, and less than one since the start.
			vi.advanceTimersByTime(900);

			expect(await second).toEqual({ answer: "second" });
		});
	});

	describe("a worker that fails", () => {
		it("fails that job only when it throws inside a timer, and the next job runs", async () => {
			// An uncaught error in a worker is an event on the Worker object, not
			// an exception of this thread: unhandled, it would fail the whole
			// vitest run.
			const decode = pool({ concurrency: 1 });

			const broken = decode.run({ workerData: { mode: "throw-in-timer" } });
			const next = decode.run<Answer>(answering("after"));

			const error = await broken.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(ImagePreparationError);
			expect(error).not.toBeInstanceOf(ImageDecodeTimeoutError);
			// A crash is most likely the photo's doing, unlike a thread that was never made.
			expect(error).not.toBeInstanceOf(ImageDecodeUnavailableError);
			expect((error as Error).message).toContain("boom in a timer");
			expect((error as Error).cause).toBeInstanceOf(Error);
			expect(await next).toEqual({ answer: "after" });
		});

		it("fails that job when the worker exits, and says with which code", async () => {
			const decode = pool({ concurrency: 1 });

			const exiting = decode.run({ workerData: { mode: "exit" } });
			const next = decode.run<Answer>(answering("after"));

			await expect(exiting).rejects.toBeInstanceOf(ImagePreparationError);
			await expect(exiting).rejects.not.toBeInstanceOf(
				ImageDecodeUnavailableError,
			);
			await expect(exiting).rejects.toThrow(/code 7/);
			expect(await next).toEqual({ answer: "after" });
		});

		it("fails that job when the worker ends without an answer", async () => {
			const decode = pool({ concurrency: 1 });

			await expect(
				decode.run({ workerData: { mode: "silent" } }),
			).rejects.toThrow(/code 0/);
		});

		it("fails that job when its answer cannot be read, and frees the place", async () => {
			const decode = pool({ concurrency: 1 });
			const held = gate();

			const job = decode.run({
				workerData: { mode: "gate", gate: held.shared, value: "x" },
			});
			const next = decode.run<Answer>(answering("after"));
			startedWorkers()[0].emit("messageerror", new Error("cannot be read"));

			await expect(job).rejects.toBeInstanceOf(ImagePreparationError);
			expect(await next).toEqual({ answer: "after" });
		});

		it("fails that job as unavailable, not as unreadable, when the system will not make a thread", async () => {
			// EAGAIN and ERR_WORKER_INIT_FAILED when the box is out of threads or
			// memory: nothing is wrong with the photo, and the next one may be fine.
			const refusal = Object.assign(
				new Error("Resource temporarily unavailable"),
				{ code: "EAGAIN" },
			);
			spawned.refuse = refusal;
			const decode = pool({ concurrency: 1 });

			const error = await decode
				.run(answering("x"))
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ImageDecodeUnavailableError);
			expect(error).toBeInstanceOf(ImagePreparationError);
			expect(error).not.toBeInstanceOf(ImageDecodeTimeoutError);
			expect((error as Error).message).toContain(
				"Resource temporarily unavailable",
			);
			expect((error as Error).cause).toBe(refusal);
			// No thread, so no place is held and nothing is left to wait for.
			expect(startedWorkers()).toHaveLength(0);
			expect([decode.running, decode.waiting]).toEqual([0, 0]);
			spawned.refuse = null;
			expect(await decode.run<Answer>(answering("after"))).toEqual({
				answer: "after",
			});
		});

		it("fails that job when no worker can be started for it, and keeps the place", async () => {
			const decode = pool({ concurrency: 1 });

			// A function cannot be cloned into a worker.
			const refused = decode.run({ workerData: { notClonable() {} } });

			await expect(refused).rejects.toBeInstanceOf(ImagePreparationError);
			expect([decode.running, decode.waiting]).toEqual([0, 0]);
			expect(await decode.run<Answer>(answering("after"))).toEqual({
				answer: "after",
			});
		});
	});

	describe("an abort", () => {
		it("ends a job that is still waiting, without ever starting a worker for it", async () => {
			const decode = pool({ concurrency: 1 });
			const held = gate();
			const first = decode.run<Answer>({
				workerData: { mode: "gate", gate: held.shared, value: "first" },
			});
			const controller = new AbortController();
			const waiting = decode.run<Answer>({
				...answering("never"),
				signal: controller.signal,
			});
			expect(decode.waiting).toBe(1);

			const reason = new Error("cancelled");
			controller.abort(reason);

			await expect(waiting).rejects.toBe(reason);
			expect(decode.waiting).toBe(0);
			expect(startedWorkers()).toHaveLength(1);
			held.open();
			expect(await first).toEqual({ answer: "first" });
			await startedWorkers()[0].exited;
			// The queue goes on without it: no worker was ever made for the job.
			expect(await decode.run<Answer>(answering("later"))).toEqual({
				answer: "later",
			});
			expect(startedWorkers()).toHaveLength(2);
		});

		it("terminates the worker of a job that is running, and frees its place", async () => {
			const decode = pool({ concurrency: 1 });
			const controller = new AbortController();

			const running = decode.run({
				workerData: { mode: "spin" },
				signal: controller.signal,
			});
			const next = decode.run<Answer>(answering("after"));
			const worker = startedWorkers()[0];
			// Abort a worker that is in its loop, not one still starting.
			await once(worker, "online");

			const reason = new Error("cancelled");
			controller.abort(reason);

			await expect(running).rejects.toBe(reason);
			// A loop that never ends does not exit by itself.
			await worker.exited;
			expect(await next).toEqual({ answer: "after" });
		});

		it("is refused at once when the signal is already aborted, with no worker", async () => {
			const decode = pool();

			await expect(
				decode.run({
					...answering("never"),
					signal: AbortSignal.abort("already"),
				}),
			).rejects.toBe("already");
			expect(startedWorkers()).toHaveLength(0);
			expect([decode.running, decode.waiting]).toEqual([0, 0]);
		});

		it("leaves nothing listening on a signal whose job has finished", async () => {
			const decode = pool();
			const controller = new AbortController();
			const added = vi.spyOn(controller.signal, "addEventListener");
			const removed = vi.spyOn(controller.signal, "removeEventListener");

			await decode.run({ ...answering("x"), signal: controller.signal });

			expect(added).toHaveBeenCalled();
			expect(removed).toHaveBeenCalledTimes(added.mock.calls.length);
		});
	});
});
