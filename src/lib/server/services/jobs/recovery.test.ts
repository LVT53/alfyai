// The engine taking an attempt back: stale, dead-worker, state-lost, and the
// scoped recovery a reader runs before it shows work. Every take-back goes
// through the kind's `onFailure`, and none of them can run twice.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onSettled } from "./events";
import { bootEngine, type EngineHarness } from "./testing/harness";
import { createWorkerId, parseWorkerId } from "./worker-identity";

const SELF = createWorkerId("test");
const HOST = parseWorkerId(SELF)?.hostname ?? "unknown";
/** An id this host wrote, from a process that no longer exists. */
const DEAD_WORKER = `test:${HOST}:999999:old-boot`;

const staleBefore = () => new Date(Date.now() - 4_000);

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("recovery");
});

afterEach(() => {
	vi.restoreAllMocks();
	h.cleanup();
});

function job(jobId: string) {
	const row = h.fixture.readJob(jobId);
	if (!row) throw new Error(`no job ${jobId}`);
	return row;
}

function running(options: {
	workerId?: string;
	heartbeatAgeMs?: number;
	updatedAgeMs?: number;
	attemptNumber?: number;
}) {
	return h.fixture.seedRunningJob({
		userId: h.userId,
		workerId: options.workerId ?? "someone",
		heartbeatAgeMs: options.heartbeatAgeMs,
		updatedAgeMs: options.updatedAgeMs,
		attemptNumber: options.attemptNumber,
	});
}

/** A job that says it is running with an attempt row that is not (or is gone). */
function runningWithoutALiveAttempt(
	how: "no-row" | "closed",
	updatedAgeMs = 0,
) {
	const attemptId = crypto.randomUUID();
	const jobId = h.fixture.seedJob({
		userId: h.userId,
		status: "running",
		attemptCount: 1,
		currentAttemptId: attemptId,
		updatedAt: new Date(Date.now() - updatedAgeMs),
	});
	if (how === "closed") {
		h.fixture.seedAttempt({
			id: attemptId,
			jobId,
			attemptNumber: 1,
			status: "failed",
		});
	}
	return { jobId, attemptId };
}

describe("a stale attempt", () => {
	it("is taken back through the kind's policy, with the kind's own words for it", () => {
		const { jobId, attemptId } = running({ heartbeatAgeMs: 10_000 });
		const decide = vi.fn(() => ({ requeue: true as const, delayMs: 0 }));
		h.control.decide = decide;

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(result).toMatchObject({ recovered: 1, requeued: 1 });
		expect(decide).toHaveBeenCalledWith(
			{
				code: "lost_stale",
				message: "The test attempt was lost (stale).",
				retryable: true,
			},
			{ attempts: 1, state: null, nowMs: expect.any(Number) },
		);
		expect(job(jobId)).toMatchObject({
			status: "queued",
			errorCode: "lost_stale",
			retryable: true,
		});
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			id: attemptId,
			status: "failed",
			errorCode: "lost_stale",
			retryable: true,
		});
	});

	it("follows the policy when it gives up", () => {
		const { jobId } = running({ heartbeatAgeMs: 10_000 });
		h.control.decide = () => ({ requeue: false, retryable: true });

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(result).toMatchObject({ recovered: 1, requeued: 0 });
		expect(job(jobId)).toMatchObject({ status: "failed", retryable: true });
		expect(job(jobId).completedAt).toBeInstanceOf(Date);
	});

	it("leaves an attempt that beat in time alone", () => {
		const { jobId } = running({ heartbeatAgeMs: 1_000 });

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(result).toMatchObject({ recovered: 0, requeued: 0 });
		expect(job(jobId).status).toBe("running");
	});

	it("never takes the same attempt back twice", () => {
		const { jobId } = running({ heartbeatAgeMs: 10_000 });
		const decide = vi.fn(() => ({ requeue: true as const, delayMs: 0 }));
		h.control.decide = decide;
		const options = { reason: "stale" as const, staleBefore: staleBefore() };

		const first = h.recovery.takeBack(h.control.kind, options);
		const second = h.recovery.takeBack(h.control.kind, options);

		expect(first.recovered).toBe(1);
		expect(second.recovered).toBe(0);
		expect(decide).toHaveBeenCalledTimes(1);
		expect(job(jobId).status).toBe("queued");
	});

	it("takes an attempt with no beat on record back once the job has gone quiet", () => {
		const { jobId, attemptId } = running({ updatedAgeMs: 10_000 });
		h.fixture.sqlite
			.prepare("update test_job_attempts set heartbeat_at = null where id = ?")
			.run(attemptId);

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(result.recovered).toBe(1);
		expect(job(jobId).status).not.toBe("running");
	});

	it("hands the policy the job's history: attempts so far and its own memory", () => {
		const { jobId } = running({ heartbeatAgeMs: 10_000, attemptNumber: 3 });
		h.fixture.sqlite
			.prepare("update test_jobs set retry_state_json = ? where id = ?")
			.run('{"waits":2}', jobId);
		const seen: unknown[] = [];
		h.control.decide = (_failure, history) => {
			seen.push(history);
			return { requeue: false, retryable: true };
		};

		h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(seen).toEqual([
			{ attempts: 3, state: { waits: 2 }, nowMs: expect.any(Number) },
		]);
	});

	it("stops the run at once when this process is running it", async () => {
		let signal: AbortSignal | null = null;
		h.control.run = async (ctx) => {
			signal = ctx.signal;
			await new Promise<void>((resolve) =>
				ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
			);
		};
		h.control.decide = () => ({ requeue: false, retryable: true });
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		const drained = h.engine.drain(h.control.kind);
		await vi.waitFor(() => expect(signal).not.toBeNull());
		h.fixture.sqlite
			.prepare(
				"update test_job_attempts set heartbeat_at = 1000 where job_id = ?",
			)
			.run(row.id);

		h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect((signal as unknown as AbortSignal).reason).toBe("lease-lost");
		await drained;
		expect(job(row.id).status).toBe("failed");
	});

	it("announces a verdict but not a requeue", () => {
		// The policy answers per job, by the attempts it has had.
		const settled = running({ heartbeatAgeMs: 10_000, attemptNumber: 2 });
		const requeued = running({ heartbeatAgeMs: 10_000, attemptNumber: 1 });
		h.control.decide = (_failure, history) =>
			history.attempts === 2
				? { requeue: false, retryable: true }
				: { requeue: true, delayMs: 0 };
		const heard: string[] = [];
		onSettled("test", settled.jobId, (event) =>
			heard.push(`settled:${event.status}`),
		);
		onSettled("test", requeued.jobId, (event) =>
			heard.push(`requeued:${event.status}`),
		);

		h.recovery.takeBack(h.control.kind, {
			reason: "stale",
			staleBefore: staleBefore(),
		});

		expect(heard).toEqual(["settled:failed"]);
		expect(job(requeued.jobId).status).toBe("queued");
	});
});

describe("a dead worker's attempt", () => {
	const options = () => ({
		reason: "dead-worker" as const,
		selfWorkerId: SELF,
	});

	it("is taken back at once, whatever its beat says", () => {
		const { jobId } = running({ workerId: DEAD_WORKER, heartbeatAgeMs: 0 });
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		const result = h.recovery.takeBack(h.control.kind, {
			...options(),
			isProcessAlive: () => false,
		});

		expect(result).toMatchObject({ recovered: 1, requeued: 1 });
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			status: "failed",
			errorCode: "lost_dead_worker",
		});
		expect(job(jobId).status).toBe("queued");
	});

	it("leaves an attempt whose process is still there", () => {
		const { jobId } = running({ workerId: DEAD_WORKER });

		const result = h.recovery.takeBack(h.control.kind, {
			...options(),
			isProcessAlive: () => true,
		});

		expect(result.recovered).toBe(0);
		expect(job(jobId).status).toBe("running");
	});

	it("never takes this process's own attempts, the inline runner's included", () => {
		const own = running({ workerId: SELF });
		const inline = running({ workerId: createWorkerId("test-inline") });

		const result = h.recovery.takeBack(h.control.kind, {
			...options(),
			isProcessAlive: () => false,
		});

		expect(result.recovered).toBe(0);
		expect(job(own.jobId).status).toBe("running");
		expect(job(inline.jobId).status).toBe("running");
	});

	it("leaves another host's ids and an older format to the stale window", () => {
		const elsewhere = running({ workerId: "test:another-box:999999:old-boot" });
		const oldFormat = running({ workerId: "test:999999:some-uuid" });
		const bare = running({ workerId: "worker-a" });

		const result = h.recovery.takeBack(h.control.kind, {
			...options(),
			isProcessAlive: () => false,
		});

		expect(result.recovered).toBe(0);
		for (const { jobId } of [elsewhere, oldFormat, bare]) {
			expect(job(jobId).status).toBe("running");
		}
	});

	it("reads EPERM from the process table as alive, and ESRCH as gone", () => {
		const { jobId } = running({ workerId: DEAD_WORKER });
		const kill = vi.spyOn(process, "kill");

		kill.mockImplementation(() => {
			throw Object.assign(new Error("not permitted"), { code: "EPERM" });
		});
		expect(h.recovery.takeBack(h.control.kind, options()).recovered).toBe(0);
		expect(job(jobId).status).toBe("running");

		kill.mockImplementation(() => {
			throw Object.assign(new Error("no such process"), { code: "ESRCH" });
		});
		expect(h.recovery.takeBack(h.control.kind, options()).recovered).toBe(1);
		expect(job(jobId).status).not.toBe("running");
	});

	it("takes nothing back when it does not know who it is", () => {
		running({ workerId: DEAD_WORKER });

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "dead-worker",
			selfWorkerId: "not-an-id",
			isProcessAlive: () => false,
		});

		expect(result.recovered).toBe(0);
	});
});

describe("a running job with no live attempt (state-lost)", () => {
	it("is taken back at boot, with no age guard, whether its attempt row is missing or closed", () => {
		const missing = runningWithoutALiveAttempt("no-row");
		const closed = runningWithoutALiveAttempt("closed");
		const decide = vi.fn(() => ({ requeue: true as const, delayMs: 0 }));
		h.control.decide = decide;

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "state-lost",
		});

		// Fresh rows, both: at boot nothing of this process is running yet, so
		// nobody can be in the middle of claiming them.
		expect(result).toMatchObject({ recovered: 2, requeued: 2 });
		for (const { jobId } of [missing, closed]) {
			expect(job(jobId)).toMatchObject({
				status: "queued",
				errorCode: "lost_state_lost",
				retryable: true,
			});
		}
		expect(decide).toHaveBeenCalledWith(
			expect.objectContaining({ code: "lost_state_lost" }),
			expect.anything(),
		);
	});

	it("leaves a fresh row alone and takes back an old one when it has an age guard", () => {
		const fresh = runningWithoutALiveAttempt("no-row", 0);
		const old = runningWithoutALiveAttempt("no-row", 60_000);
		const oldClosed = runningWithoutALiveAttempt("closed", 60_000);
		h.control.decide = () => ({ requeue: false, retryable: true });

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "state-lost",
			updatedBefore: staleBefore(),
		});

		expect(result.recovered).toBe(2);
		expect(job(fresh.jobId).status).toBe("running");
		expect(job(old.jobId).status).toBe("failed");
		expect(job(oldClosed.jobId).status).toBe("failed");
	});

	it("does not touch a job whose attempt is alive", () => {
		const { jobId } = running({ heartbeatAgeMs: 0, updatedAgeMs: 60_000 });

		const result = h.recovery.takeBack(h.control.kind, {
			reason: "state-lost",
		});

		expect(result.recovered).toBe(0);
		expect(job(jobId).status).toBe("running");
	});

	it("does not touch a queued or settled job", () => {
		h.fixture.seedJob({ userId: h.userId, status: "queued" });
		h.fixture.seedJob({ userId: h.userId, status: "failed" });

		expect(
			h.recovery.takeBack(h.control.kind, { reason: "state-lost" }).recovered,
		).toBe(0);
	});

	it("is a no-op the second time", () => {
		runningWithoutALiveAttempt("no-row");
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		expect(
			h.recovery.takeBack(h.control.kind, { reason: "state-lost" }).recovered,
		).toBe(1);
		expect(
			h.recovery.takeBack(h.control.kind, { reason: "state-lost" }).recovered,
		).toBe(0);
	});
});

describe("recover (scoped)", () => {
	it("fails old queued jobs only inside its scope, with the caller's words", () => {
		const old = new Date(Date.now() - 60_000);
		const mine = h.fixture.seedJob({
			userId: h.userId,
			label: "chat-a",
			updatedAt: old,
		});
		const theirs = h.fixture.seedJob({
			userId: h.userId,
			label: "chat-b",
			updatedAt: old,
		});
		const fresh = h.fixture.seedJob({ userId: h.userId, label: "chat-a" });
		const settled = h.fixture.seedJob({
			userId: h.userId,
			label: "chat-a",
			status: "succeeded",
			updatedAt: old,
		});

		const result = h.recovery.recover(h.control.kind, {
			where: (jobs) => eq(jobs.label, "chat-a"),
			queuedOlderThan: new Date(Date.now() - 30_000),
			queuedFailure: {
				code: "worker_queue_timeout",
				message: "Production did not start before the queue timeout.",
			},
		});

		expect(result.recovered).toBe(1);
		expect(job(mine)).toMatchObject({
			status: "failed",
			errorCode: "worker_queue_timeout",
			errorMessage: "Production did not start before the queue timeout.",
			retryable: true,
		});
		expect(job(mine).completedAt).toBeInstanceOf(Date);
		expect(job(theirs).status).toBe("queued");
		expect(job(fresh).status).toBe("queued");
		expect(job(settled).status).toBe("succeeded");
		expect(h.control.transitions.at(-1)).toEqual({ jobId: mine, to: "failed" });
	});

	it("defaults the code to worker_queue_timeout", () => {
		const id = h.fixture.seedJob({
			userId: h.userId,
			updatedAt: new Date(Date.now() - 60_000),
		});

		h.recovery.recover(h.control.kind, {
			queuedOlderThan: new Date(Date.now() - 30_000),
		});

		expect(job(id)).toMatchObject({
			status: "failed",
			errorCode: "worker_queue_timeout",
			retryable: true,
		});
	});

	it("fails no queued job when it is not asked to", () => {
		const id = h.fixture.seedJob({
			userId: h.userId,
			updatedAt: new Date(Date.now() - 600_000),
		});

		expect(h.recovery.recover(h.control.kind, {}).recovered).toBe(0);
		expect(job(id).status).toBe("queued");
	});

	it("takes back stale and lost attempts inside its scope, and only old lost ones", () => {
		const stale = running({ heartbeatAgeMs: 60_000 });
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'chat-a' where id = ?")
			.run(stale.jobId);
		const staleElsewhere = running({ heartbeatAgeMs: 60_000 });
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'chat-b' where id = ?")
			.run(staleElsewhere.jobId);
		const lostOld = runningWithoutALiveAttempt("no-row", 60_000);
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'chat-a' where id = ?")
			.run(lostOld.jobId);
		const lostFresh = runningWithoutALiveAttempt("no-row", 0);
		h.fixture.sqlite
			.prepare("update test_jobs set label = 'chat-a' where id = ?")
			.run(lostFresh.jobId);
		h.control.decide = () => ({ requeue: false, retryable: true });

		const result = h.recovery.recover(h.control.kind, {
			where: (jobs) => eq(jobs.label, "chat-a"),
		});

		// The lease is 4 s here, so "old" means a job nobody touched for 4 s.
		expect(result.recovered).toBe(2);
		expect(job(stale.jobId).status).toBe("failed");
		expect(job(lostOld.jobId).status).toBe("failed");
		expect(job(staleElsewhere.jobId).status).toBe("running");
		expect(job(lostFresh.jobId).status).toBe("running");
	});

	it("measures old against the staleBefore it is given", () => {
		const { jobId } = running({ heartbeatAgeMs: 20_000 });

		expect(
			h.recovery.recover(h.control.kind, {
				staleBefore: new Date(Date.now() - 60_000),
			}).recovered,
		).toBe(0);
		expect(job(jobId).status).toBe("running");

		expect(
			h.recovery.recover(h.control.kind, {
				staleBefore: new Date(Date.now() - 10_000),
			}).recovered,
		).toBe(1);
	});
});
