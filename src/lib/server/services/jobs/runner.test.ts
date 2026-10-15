// One claimed attempt, run: the heartbeat timer, the abort reasons, and what the
// runner makes of a handler that returns, throws or says nothing. The clock is
// fake; the engine boots on the real one and the clock is installed after.

import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import { bootEngine, type EngineHarness } from "./testing/harness";
import { testJobs } from "./testing/test-kind";
import type { JobRunContext } from "./types";

type Ctx = JobRunContext<typeof testJobs>;

const START = new Date("2026-03-01T12:00:00.000Z");
const realSetTimeout = globalThis.setTimeout;

/** A real macrotask, for the things only a real event-loop turn can show. */
const realTurn = () =>
	new Promise<void>((resolve) => realSetTimeout(resolve, 5));

let h: EngineHarness;
let unhandled: Mock<(reason: unknown) => void>;

beforeEach(async () => {
	h = await bootEngine("runner");
	h.control.config.heartbeatMs = 1_000;
	h.control.config.staleAfterMs = 4_000;
	unhandled = vi.fn<(reason: unknown) => void>();
	process.on("unhandledRejection", unhandled);
	vi.useFakeTimers();
	vi.setSystemTime(START);
});

afterEach(() => {
	process.off("unhandledRejection", unhandled);
	vi.useRealTimers();
	vi.restoreAllMocks();
	h.cleanup();
});

function blockUntilAborted(signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) resolve();
		else signal.addEventListener("abort", () => resolve(), { once: true });
	});
}

/** Enqueues a job and starts draining it; returns once its handler is running. */
async function startRun(run: (ctx: Ctx) => Promise<void>) {
	h.control.run = run;
	const { row } = await h.engine.enqueue(h.control.kind, {
		values: { userId: h.userId },
	});
	const drained = h.engine.drain(h.control.kind);
	// `drain` rejects when the database does, as it should for a caller that
	// asked for one. A test that does not await it must not be the one leaking.
	drained.catch(() => {});
	await vi.advanceTimersByTimeAsync(0);
	return { jobId: row.id, drained };
}

function job(jobId: string) {
	const row = h.fixture.readJob(jobId);
	if (!row) throw new Error(`no job ${jobId}`);
	return row;
}

function heartbeatSeconds(jobId: string): number {
	return Math.floor(
		(h.fixture.readAttempts(jobId)[0].heartbeatAt?.getTime() ?? 0) / 1000,
	);
}

/**
 * What a take-back leaves behind the run's back: the attempt failed and the job
 * settled with it (so the drain that ran it does not claim it again).
 */
function takeBackBehindTheRunsBack(jobId: string) {
	h.fixture.sqlite
		.prepare("update test_job_attempts set status = 'failed' where job_id = ?")
		.run(jobId);
	h.fixture.sqlite
		.prepare(
			"update test_jobs set status = 'failed', retryable = 1 where id = ?",
		)
		.run(jobId);
}

describe("the context", () => {
	it("hands the handler the claimed row and the attempt", async () => {
		let seen: Ctx | null = null;
		const { jobId, drained } = await startRun(async (ctx) => {
			seen = ctx;
			await ctx.succeed();
		});
		await drained;

		expect(seen).not.toBeNull();
		const ctx = seen as unknown as Ctx;
		expect(ctx.row).toMatchObject({
			id: jobId,
			status: "running",
			attemptCount: 1,
		});
		expect(ctx.attempt).toEqual({
			id: h.fixture.readAttempts(jobId)[0].id,
			number: 1,
		});
		expect(ctx.signal.aborted).toBe(false);
	});

	it("moves the phase and the checkpoint, and writes the kind's own columns", async () => {
		const { jobId, drained } = await startRun(async (ctx) => {
			expect(await ctx.progress({ checkpoint: { cursor: 7 } })).toBe(true);
			expect(
				await ctx.write((tx) => {
					tx.update(testJobs)
						.set({ label: "mid-run" })
						.where(eq(testJobs.id, ctx.row.id))
						.run();
				}),
			).toBe(true);
			await ctx.succeed({ diagnostics: { pages: 2 } });
		});
		await drained;

		expect(job(jobId)).toMatchObject({ status: "succeeded", label: "mid-run" });
		expect(h.fixture.readAttempts(jobId)[0].diagnosticsJson).toBe(
			'{"pages":2}',
		);
	});
});

describe("the heartbeat", () => {
	it("beats on its own timer while the handler is busy", async () => {
		const { jobId } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
		});
		const claimed = heartbeatSeconds(jobId);

		// Nothing in the handler reports anything: the lease measures whether the
		// process is alive, not how long a step takes.
		await vi.advanceTimersByTimeAsync(1_000);
		expect(heartbeatSeconds(jobId)).toBe(claimed + 1);
		await vi.advanceTimersByTimeAsync(1_000);
		expect(heartbeatSeconds(jobId)).toBe(claimed + 2);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(heartbeatSeconds(jobId)).toBe(claimed + 5);
	});

	it("never beats faster than every 250 ms", async () => {
		h.control.config.heartbeatMs = 10;
		const { jobId } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
		});
		// A beat is one transaction.
		const transactions = vi.spyOn(h.sqlite, "transaction");

		await vi.advanceTimersByTimeAsync(1_000);

		expect(transactions).toHaveBeenCalledTimes(4);
		expect(job(jobId).status).toBe("running");
	});

	it("stops beating when the run ends", async () => {
		const { jobId, drained } = await startRun(async (ctx) => {
			await ctx.succeed();
		});
		await drained;
		const finished = heartbeatSeconds(jobId);

		await vi.advanceTimersByTimeAsync(10_000);

		expect(heartbeatSeconds(jobId)).toBe(finished);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("counts a progress report or a domain write as a beat", async () => {
		const { jobId } = await startRun(async (ctx) => {
			await ctx.progress({ checkpoint: 1 });
			await blockUntilAborted(ctx.signal);
		});
		const first = heartbeatSeconds(jobId);

		await vi.advanceTimersByTimeAsync(2_000);

		expect(heartbeatSeconds(jobId)).toBeGreaterThan(first);
	});
});

describe("cancel", () => {
	it("aborts a blocked handler at once, before any timer runs", async () => {
		let signal: AbortSignal | null = null;
		const { jobId } = await startRun(async (ctx) => {
			signal = ctx.signal;
			// A model call with no timeout: it never comes back on its own.
			await new Promise<void>(() => {});
		});

		h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });

		expect((signal as unknown as AbortSignal).aborted).toBe(true);
		expect((signal as unknown as AbortSignal).reason).toBe("cancelled");
		expect(job(jobId).status).toBe("cancelled");
	});

	it("lets a handler that notices the abort return, and writes nothing more", async () => {
		const { jobId, drained } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
		});

		h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });
		await drained;

		expect(job(jobId).status).toBe("cancelled");
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			status: "cancelled",
			errorCode: "cancelled",
		});
		// No `no_verdict` failure was written over the cancel.
		expect(job(jobId).errorCode).toBeNull();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("is found at the next beat when another process cancels", async () => {
		let signal: AbortSignal | null = null;
		const { jobId } = await startRun(async (ctx) => {
			signal = ctx.signal;
			await blockUntilAborted(ctx.signal);
		});
		h.fixture.sqlite
			.prepare("update test_jobs set status = 'cancelled' where id = ?")
			.run(jobId);
		h.fixture.sqlite
			.prepare(
				"update test_job_attempts set status = 'cancelled' where job_id = ?",
			)
			.run(jobId);

		await vi.advanceTimersByTimeAsync(1_000);

		expect((signal as unknown as AbortSignal).reason).toBe("cancelled");
	});

	it("logs a cancel it honoured", async () => {
		const info = vi.spyOn(console, "info").mockImplementation(() => {});
		const { jobId, drained } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
		});

		h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });
		await drained;

		expect(info).toHaveBeenCalledWith(
			"[TEST] Cancel honoured",
			expect.objectContaining({ jobId, attemptNumber: 1 }),
		);
	});
});

describe("a lost lease", () => {
	it("aborts with lease-lost at the next beat", async () => {
		let signal: AbortSignal | null = null;
		const { jobId } = await startRun(async (ctx) => {
			signal = ctx.signal;
			await blockUntilAborted(ctx.signal);
		});
		takeBackBehindTheRunsBack(jobId);
		expect((signal as unknown as AbortSignal).aborted).toBe(false);

		await vi.advanceTimersByTimeAsync(1_000);

		expect((signal as unknown as AbortSignal).aborted).toBe(true);
		expect((signal as unknown as AbortSignal).reason).toBe("lease-lost");
	});

	it("aborts at once when a write finds the claim gone, without waiting for a beat", async () => {
		let progressed: boolean | null = null;
		let signal: AbortSignal | null = null;
		const { jobId, drained } = await startRun(async (ctx) => {
			signal = ctx.signal;
			takeBackBehindTheRunsBack(ctx.row.id);
			progressed = await ctx.progress({ phase: "x" });
		});
		await drained;

		expect(progressed).toBe(false);
		expect((signal as unknown as AbortSignal).reason).toBe("lease-lost");
		expect(job(jobId).status).toBe("failed");
	});

	it("writes nothing when a handler aborted for lease-lost returns", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const decide = vi.fn();
		h.control.decide = decide;
		const { jobId, drained } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
			// It stopped and returns. Whoever holds the job now owns its status.
		});
		takeBackBehindTheRunsBack(jobId);
		const untouched = job(jobId);

		await vi.advanceTimersByTimeAsync(1_000);
		await drained;

		expect(job(jobId)).toEqual(untouched);
		expect(decide).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			"[TEST] Attempt released without a verdict",
			expect.objectContaining({ jobId }),
		);
	});

	it("refuses every write the handler still makes after the abort", async () => {
		let results: unknown[] = [];
		let applied = false;
		const { jobId, drained } = await startRun(async (ctx) => {
			await blockUntilAborted(ctx.signal);
			results = [
				await ctx.progress({ phase: "late" }),
				await ctx.write(() => {
					applied = true;
				}),
				await ctx.succeed({
					apply: () => {
						applied = true;
					},
				}),
				await ctx.fail({ code: "late", message: "late", retryable: true }),
			];
		});
		takeBackBehindTheRunsBack(jobId);
		const untouched = job(jobId);

		await vi.advanceTimersByTimeAsync(1_000);
		await drained;

		expect(results).toEqual([
			false,
			false,
			false,
			{ applied: false, requeued: false, runAfter: null },
		]);
		expect(applied).toBe(false);
		expect(job(jobId)).toEqual(untouched);
	});
});

describe("a beat that cannot be written", () => {
	function breakTheWriter() {
		const real = h.sqlite.transaction.bind(h.sqlite);
		let broken = true;
		h.sqlite.transaction = ((fn: never) => {
			if (broken) {
				throw Object.assign(new Error("database is locked"), {
					code: "SQLITE_BUSY",
				});
			}
			return real(fn);
		}) as never;
		return () => {
			broken = false;
			h.sqlite.transaction = real as never;
		};
	}

	it("never rejects unhandled, and abandons the attempt only after half the stale window", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		let signal: AbortSignal | null = null;
		const { jobId } = await startRun(async (ctx) => {
			signal = ctx.signal;
			await blockUntilAborted(ctx.signal);
		});
		const mend = breakTheWriter();

		// Stale after 4 s; half of it is 2 s. The beats at 1 s and (just before)
		// 2 s are logged and survived.
		await vi.advanceTimersByTimeAsync(1_999);
		expect((signal as unknown as AbortSignal).aborted).toBe(false);
		expect(warn).toHaveBeenCalledWith(
			"[TEST] Heartbeat write failed",
			expect.objectContaining({ jobId }),
		);

		await vi.advanceTimersByTimeAsync(1);
		expect((signal as unknown as AbortSignal).aborted).toBe(true);
		expect((signal as unknown as AbortSignal).reason).toBe("lease-lost");

		mend();
		await realTurn();
		expect(unhandled).not.toHaveBeenCalled();
	});

	it("keeps the run going when the writer comes back in time", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let signal: AbortSignal | null = null;
		const { jobId } = await startRun(async (ctx) => {
			signal = ctx.signal;
			await blockUntilAborted(ctx.signal);
		});
		const claimed = heartbeatSeconds(jobId);
		const mend = breakTheWriter();

		await vi.advanceTimersByTimeAsync(1_000);
		mend();
		await vi.advanceTimersByTimeAsync(1_000);
		await vi.advanceTimersByTimeAsync(1_000);

		expect((signal as unknown as AbortSignal).aborted).toBe(false);
		expect(heartbeatSeconds(jobId)).toBeGreaterThan(claimed);
		await realTurn();
		expect(unhandled).not.toHaveBeenCalled();
	});
});

describe("what the handler's end means", () => {
	it("makes a throw a job_failed failure that the policy decides", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const decide = vi.fn(() => ({ requeue: false as const, retryable: true }));
		h.control.decide = decide;

		const { jobId, drained } = await startRun(async () => {
			throw new Error("the renderer fell over");
		});
		await drained;

		expect(decide).toHaveBeenCalledWith(
			{
				code: "job_failed",
				message: "the renderer fell over",
				retryable: true,
			},
			expect.objectContaining({ attempts: 1 }),
		);
		expect(job(jobId)).toMatchObject({
			status: "failed",
			errorCode: "job_failed",
			errorMessage: "the renderer fell over",
			retryable: true,
		});
	});

	it("makes a return without a verdict a no_verdict failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const decide = vi.fn(() => ({ requeue: false as const, retryable: true }));
		h.control.decide = decide;

		const { jobId, drained } = await startRun(async () => {
			// Returns, and says nothing.
		});
		await drained;

		expect(decide).toHaveBeenCalledWith(
			{
				code: "no_verdict",
				message: "The job stopped without a result.",
				retryable: true,
			},
			expect.anything(),
		);
		expect(job(jobId).status).toBe("failed");
	});

	it("takes a string thrown for what it says", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { jobId, drained } = await startRun(async () => {
			throw "just a string";
		});
		await drained;

		expect(job(jobId).errorMessage).toBe("just a string");
	});

	it("leaves a verdict the handler wrote alone", async () => {
		const decide = vi.fn();
		h.control.decide = decide;
		const { jobId, drained } = await startRun(async (ctx) => {
			await ctx.succeed();
		});
		await drained;

		expect(decide).not.toHaveBeenCalled();
		expect(job(jobId).status).toBe("succeeded");
	});

	it("does not call a failure it reported itself a second one", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const decide = vi.fn(() => ({ requeue: false as const, retryable: false }));
		h.control.decide = decide;
		const { jobId, drained } = await startRun(async (ctx) => {
			await ctx.fail({ code: "bad_input", message: "No.", retryable: false });
		});
		await drained;

		expect(decide).toHaveBeenCalledTimes(1);
		expect(job(jobId).errorCode).toBe("bad_input");
	});

	it("throws inside an apply to the handler, which may catch it and report", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { jobId, drained } = await startRun(async (ctx) => {
			try {
				await ctx.succeed({
					apply: () => {
						throw new Error("could not link the file");
					},
				});
			} catch (error) {
				await ctx.fail({
					code: "link_failed",
					message: (error as Error).message,
					retryable: true,
				});
			}
		});
		await drained;

		expect(job(jobId)).toMatchObject({
			status: "failed",
			errorCode: "link_failed",
		});
	});

	it("logs a failed attempt with its code and whether it was requeued", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		h.control.decide = () => ({ requeue: true, delayMs: 60_000 });
		const { jobId, drained } = await startRun(async (ctx) => {
			await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
		});
		await drained;

		expect(warn).toHaveBeenCalledWith(
			"[TEST] Attempt failed",
			expect.objectContaining({
				jobId,
				attemptNumber: 1,
				errorCode: "flaky",
				requeued: true,
				nextAttemptAt: expect.any(String),
			}),
		);
	});

	it("says a job will not be retried when the policy gives up for good", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { jobId, drained } = await startRun(async (ctx) => {
			await ctx.fail({ code: "bad_input", message: "No.", retryable: false });
		});
		await drained;

		expect(warn).toHaveBeenCalledWith(
			"[TEST] Job will not be retried",
			expect.objectContaining({ jobId, errorCode: "bad_input" }),
		);
	});

	it("fails the attempt when the handler cannot be loaded, and tries the load again next time", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let loads = 0;
		h.control.definition.handler = async () => {
			loads += 1;
			if (loads === 1) throw new Error("cannot import the renderer");
			return async (ctx) => {
				await ctx.succeed();
			};
		};
		h.control.decide = () => ({ requeue: false, retryable: true });
		const first = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		await h.engine.drain(h.control.kind);
		expect(job(first.row.id)).toMatchObject({
			status: "failed",
			errorCode: "job_failed",
			errorMessage: "cannot import the renderer",
		});

		const second = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		await h.engine.drain(h.control.kind);
		expect(job(second.row.id).status).toBe("succeeded");
		expect(loads).toBe(2);
	});

	it("carries on with the next job after a failure", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		let calls = 0;
		h.control.run = async (ctx) => {
			calls += 1;
			if (calls === 1) throw new Error("first one dies");
			await ctx.succeed();
		};
		const a = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		const b = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		await h.engine.drain(h.control.kind);

		expect(job(a.row.id).status).toBe("failed");
		expect(job(b.row.id).status).toBe("succeeded");
	});
});

describe("requeueing", () => {
	it("resumes the next attempt from the checkpoint the last one left", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		h.control.decide = (_failure, history) =>
			history.attempts < 2
				? { requeue: true, delayMs: 0 }
				: { requeue: false, retryable: true };
		const seen: unknown[] = [];
		h.control.run = async (ctx) => {
			seen.push(ctx.row.checkpoint);
			if (ctx.attempt.number === 1) {
				await ctx.progress({ checkpoint: { cursor: 4 } });
				await ctx.fail({ code: "flaky", message: "Flaky.", retryable: true });
				return;
			}
			await ctx.succeed();
		};
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		// A requeue with no delay is claimable at once: the same drain runs it again.
		await h.engine.drain(h.control.kind);

		expect(seen).toEqual([null, '{"cursor":4}']);
		expect(job(row.id).status).toBe("succeeded");
		expect(
			h.fixture.readAttempts(row.id).map((attempt) => attempt.status),
		).toEqual(["failed", "succeeded"]);
	});
});
