// Waiting for a verdict: a caller that has to know how a job ended (a chat turn
// that needs a document's text, an upload that wants to answer ready) waits for
// it here, by event when this process settles the job and by a poll when
// something else did.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";
import type { OwnedAttempt } from "./types";

const WORKER = "worker-1";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("wait");
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	h.cleanup();
});

/** A job a handler is working on: enqueued and claimed. */
async function running() {
	const { row } = await h.engine.enqueue(h.control.kind, {
		values: { userId: h.userId },
	});
	const claimed = h.ledger.claimNext(h.control.kind, { workerId: WORKER });
	if (!claimed) throw new Error("expected a claim");
	const owned: OwnedAttempt = {
		jobId: row.id,
		attemptId: claimed.attempt.id,
		workerId: WORKER,
	};
	return { jobId: row.id, owned };
}

function wait(
	jobId: string,
	options: { timeoutMs?: number; signal?: AbortSignal } = {},
) {
	return h.engine.waitForVerdict(h.control.kind, jobId, {
		timeoutMs: options.timeoutMs ?? 60_000,
		signal: options.signal,
	});
}

/** Resolves with what a promise resolves with, or "pending" if it has not yet. */
async function settledOr<T>(promise: Promise<T>): Promise<T | "pending"> {
	const pending = Symbol("pending");
	const result = await Promise.race([promise, Promise.resolve(pending)]);
	return result === pending ? "pending" : (result as T);
}

describe("waitForVerdict", () => {
	it("resolves at once when this process settles the job, without a timer moving", async () => {
		const { jobId, owned } = await running();
		const waiting = wait(jobId);

		h.ledger.succeed(h.control.kind, owned);

		await expect(waiting).resolves.toEqual({
			settled: true,
			status: "succeeded",
		});
	});

	it("waits on for a timeout longer than a timer can hold, as the helpers it replaces did", async () => {
		// Node fires a timer set for more than 2^31-1 ms (24.8 days), Infinity
		// included, after 1 ms. The poll loops this replaces counted down to a
		// deadline, so "wait as long as it takes" waited.
		for (const timeoutMs of [Number.POSITIVE_INFINITY, 30 * 86_400_000]) {
			const { jobId, owned } = await running();
			const waiting = wait(jobId, { timeoutMs });

			await vi.advanceTimersByTimeAsync(5_000);
			expect(await settledOr(waiting)).toBe("pending");

			h.ledger.succeed(h.control.kind, owned);
			await expect(waiting).resolves.toEqual({
				settled: true,
				status: "succeeded",
			});
		}
	});

	it("hears a failure and a cancel the same way", async () => {
		const failed = await running();
		const cancelled = await running();
		const waitingFailed = wait(failed.jobId);
		const waitingCancelled = wait(cancelled.jobId);

		h.ledger.fail(h.control.kind, failed.owned, {
			code: "x",
			message: "m",
			retryable: false,
		});
		h.ledger.cancel(h.control.kind, cancelled.jobId, { userId: h.userId });

		await expect(waitingFailed).resolves.toEqual({
			settled: true,
			status: "failed",
		});
		await expect(waitingCancelled).resolves.toEqual({
			settled: true,
			status: "cancelled",
		});
	});

	it("resolves at once for a job that has settled already", async () => {
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
			born: { status: "failed", code: "x", message: "m", retryable: false },
		});

		await expect(wait(row.id)).resolves.toEqual({
			settled: true,
			status: "failed",
		});
	});

	it("says what it can about a job that does not exist, at once", async () => {
		await expect(wait("no-such-job")).resolves.toEqual({
			settled: false,
			status: null,
		});
	});

	it("falls back to a one-second poll for a row settled by another connection", async () => {
		const { jobId } = await running();
		const waiting = wait(jobId);

		// Another process finishes the job. No event reaches this one.
		h.fixture.sqlite
			.prepare("update test_jobs set status = 'succeeded' where id = ?")
			.run(jobId);
		await vi.advanceTimersByTimeAsync(900);
		expect(await settledOr(waiting)).toBe("pending");

		await vi.advanceTimersByTimeAsync(200);
		await expect(waiting).resolves.toEqual({
			settled: true,
			status: "succeeded",
		});
	});

	it("times out unsettled with the last status it saw", async () => {
		const { jobId } = await running();
		const waiting = wait(jobId, { timeoutMs: 3_000 });

		await vi.advanceTimersByTimeAsync(2_900);
		expect(await settledOr(waiting)).toBe("pending");

		await vi.advanceTimersByTimeAsync(200);
		await expect(waiting).resolves.toEqual({
			settled: false,
			status: "running",
		});
	});

	it("reports the freshest status at the timeout, not the one it started with", async () => {
		const { jobId } = await running();
		const waiting = wait(jobId, { timeoutMs: 2_500 });
		h.fixture.sqlite
			.prepare("update test_jobs set status = 'queued' where id = ?")
			.run(jobId);

		await vi.advanceTimersByTimeAsync(2_600);

		await expect(waiting).resolves.toEqual({
			settled: false,
			status: "queued",
		});
	});

	it("waits for nothing when the timeout is nothing", async () => {
		const { jobId } = await running();

		await expect(wait(jobId, { timeoutMs: 0 })).resolves.toEqual({
			settled: false,
			status: "running",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("stops when its signal aborts", async () => {
		const { jobId } = await running();
		const controller = new AbortController();
		const waiting = wait(jobId, { signal: controller.signal });
		await vi.advanceTimersByTimeAsync(10);
		expect(await settledOr(waiting)).toBe("pending");

		controller.abort();

		await expect(waiting).resolves.toEqual({
			settled: false,
			status: "running",
		});
	});

	it("does not start waiting on a signal that is already aborted", async () => {
		const { jobId } = await running();
		const controller = new AbortController();
		controller.abort();

		await expect(wait(jobId, { signal: controller.signal })).resolves.toEqual({
			settled: false,
			status: "running",
		});
		expect(vi.getTimerCount()).toBe(0);
	});

	it("does not take a requeue for a verdict", async () => {
		const { jobId, owned } = await running();
		h.control.decide = () => ({ requeue: true, delayMs: 60_000 });
		const waiting = wait(jobId);

		h.ledger.fail(h.control.kind, owned, {
			code: "flaky",
			message: "Flaky.",
			retryable: true,
		});
		await vi.advanceTimersByTimeAsync(2_000);
		expect(await settledOr(waiting)).toBe("pending");
		expect(h.fixture.readJob(jobId)?.status).toBe("queued");

		h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });
		await expect(waiting).resolves.toEqual({
			settled: true,
			status: "cancelled",
		});
	});

	it("hears a take-back that settles a job", async () => {
		const { jobId } = h.fixture.seedRunningJob({
			userId: h.userId,
			workerId: "gone",
			heartbeatAgeMs: 60_000,
		});
		h.control.decide = () => ({ requeue: false, retryable: true });
		const waiting = wait(jobId);

		h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: new Date(Date.now() - 4_000),
		});

		await expect(waiting).resolves.toEqual({ settled: true, status: "failed" });
	});

	it("leaves nothing behind: no timer, no listener", async () => {
		const first = await running();
		const second = await running();
		const settled = wait(first.jobId);
		const timedOut = wait(second.jobId, { timeoutMs: 1_000 });
		const controller = new AbortController();
		const aborted = wait(second.jobId, { signal: controller.signal });

		h.ledger.succeed(h.control.kind, first.owned);
		await vi.advanceTimersByTimeAsync(1_500);
		controller.abort();
		await Promise.all([settled, timedOut, aborted]);

		expect(vi.getTimerCount()).toBe(0);
		const { jobsState } = await import("./state");
		expect(jobsState().settleListeners.size).toBe(0);
	});

	it("survives a poll that cannot read the row, and answers at the next one", async () => {
		const { jobId } = await running();
		const waiting = wait(jobId);
		const real = h.sqlite.prepare.bind(h.sqlite);
		let broken = true;
		vi.spyOn(h.sqlite, "prepare").mockImplementation(((sql: string) => {
			if (broken) {
				throw Object.assign(new Error("database is locked"), {
					code: "SQLITE_BUSY",
				});
			}
			return real(sql);
		}) as never);
		h.fixture.sqlite
			.prepare("update test_jobs set status = 'succeeded' where id = ?")
			.run(jobId);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(await settledOr(waiting)).toBe("pending");

		broken = false;
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(waiting).resolves.toEqual({
			settled: true,
			status: "succeeded",
		});
	});
});
