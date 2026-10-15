// The engine on the real clock. Every other scheduler test moves a fake one; this
// one starts the engine and waits, so a thing the fake clock hides (a timer that
// is never armed, an ordering that only works in one turn of the event loop)
// fails here. It takes a few seconds because the backoff timer cannot be hurried.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("live");
	h.control.config.heartbeatMs = 250;
	h.control.config.staleAfterMs = 10_000;
	vi.spyOn(console, "info").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
	await h.engine.startJobs([h.control.kind], {
		startInNonServingContextForTests: true,
		isProcessAlive: () => false,
	});
});

afterEach(() => {
	h.engine.stopJobs();
	vi.restoreAllMocks();
	h.cleanup();
});

function enqueue(extra: { priority?: number } = {}) {
	return h.engine.enqueue(h.control.kind, {
		values: { userId: h.userId },
		...extra,
	});
}

const verdict = (jobId: string, timeoutMs = 8_000) =>
	h.engine.waitForVerdict(h.control.kind, jobId, { timeoutMs });

describe("the engine, started, on the real clock", () => {
	it("runs what is enqueued, with nobody calling a drain, and says so", async () => {
		const jobs = await Promise.all([enqueue(), enqueue(), enqueue()]);

		const verdicts = await Promise.all(jobs.map(({ row }) => verdict(row.id)));

		expect(verdicts).toEqual([
			{ settled: true, status: "succeeded" },
			{ settled: true, status: "succeeded" },
			{ settled: true, status: "succeeded" },
		]);
		expect(h.control.ran).toHaveLength(3);
		for (const { row } of jobs) {
			expect(h.fixture.readAttempts(row.id).map((a) => a.status)).toEqual([
				"succeeded",
			]);
		}
	});

	it("stops a run that is blocked on something that never answers, the moment it is cancelled", async () => {
		let started = false;
		h.control.run = async (ctx) => {
			started = true;
			await new Promise<void>(() => {
				// A model call with no timeout.
			});
			await ctx.succeed();
		};
		const { row } = await enqueue();
		await vi.waitFor(() => expect(started).toBe(true), { timeout: 4_000 });
		const waiting = verdict(row.id);

		await h.engine.cancel(h.control.kind, row.id, { userId: h.userId });

		await expect(waiting).resolves.toEqual({
			settled: true,
			status: "cancelled",
		});
		expect(h.fixture.readAttempts(row.id)[0].status).toBe("cancelled");
	});

	it("runs a requeued job when its time comes, a step that reports nothing still owning its job", async () => {
		let attempts = 0;
		h.control.decide = (_failure, history) =>
			history.attempts < 2
				? { requeue: true, delayMs: 1_000 }
				: { requeue: false, retryable: true };
		h.control.run = async (ctx) => {
			attempts += 1;
			if (ctx.attempt.number === 1) {
				// Longer than three beats, with nothing reported: the job is still its own.
				await new Promise((resolve) => setTimeout(resolve, 900));
				await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
				return;
			}
			await ctx.succeed();
		};
		const { row } = await enqueue();

		const result = await verdict(row.id, 10_000);

		expect(result).toEqual({ settled: true, status: "succeeded" });
		expect(attempts).toBe(2);
		const [first, second] = h.fixture.readAttempts(row.id);
		expect(first).toMatchObject({ status: "failed", errorCode: "flaky" });
		expect(second.status).toBe("succeeded");
	}, 15_000);
});
