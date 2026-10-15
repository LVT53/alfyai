// The transitions of a job and its attempt: progress, the fenced writes, the
// verdicts, Cancel, Retry and Reopen. Every one of them is one transaction, and
// every one an attempt makes is refused once the attempt no longer owns the job.

import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { onSettled } from "./events";
import { bootEngine, type EngineHarness } from "./testing/harness";
import {
	createTestKind,
	type TestKindControl,
	testJobAttempts,
	testJobs,
} from "./testing/test-kind";
import type { OwnedAttempt } from "./types";

const WORKER = "worker-1";

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("transitions");
});

afterEach(() => {
	h.cleanup();
});

/** Enqueues a job and claims it: the state a handler starts in. */
async function running(
	control: TestKindControl = h.control,
	values: { label?: string } = {},
) {
	const { row } = await h.engine.enqueue(control.kind, {
		values: { userId: h.userId, ...values },
	});
	const claimed = h.ledger.claimNext(control.kind, { workerId: WORKER });
	if (!claimed) throw new Error("expected a claim");
	const owned: OwnedAttempt = {
		jobId: row.id,
		attemptId: claimed.attempt.id,
		workerId: WORKER,
	};
	return { jobId: row.id, owned, claimed };
}

function job(jobId: string) {
	const row = h.fixture.readJob(jobId);
	if (!row) throw new Error(`no job ${jobId}`);
	return row;
}

/** What a take-back leaves: the attempt failed, the job queued behind it. */
function takeBackBehindTheRunsBack(jobId: string, attemptId: string) {
	h.fixture.sqlite
		.prepare("update test_job_attempts set status = 'failed' where id = ?")
		.run(attemptId);
	h.fixture.sqlite
		.prepare("update test_jobs set status = 'queued' where id = ?")
		.run(jobId);
}

function phased(): TestKindControl {
	return createTestKind(h.engine.defineJobKind, {
		name: "phased",
		phases: ["a", "b", "c"],
	});
}

describe("beat", () => {
	it("moves the attempt's last beat and nothing on the job", async () => {
		const { jobId, owned } = await running();
		h.fixture.sqlite
			.prepare("update test_job_attempts set heartbeat_at = 1000 where id = ?")
			.run(owned.attemptId);
		const before = job(jobId).updatedAt;

		expect(h.ledger.beat(h.control.kind, owned)).toBe(true);

		expect(
			h.fixture.readAttempts(jobId)[0].heartbeatAt?.getTime(),
		).toBeGreaterThan(1_000_000);
		expect(job(jobId).updatedAt).toEqual(before);
	});

	it("says no once the claim is gone", async () => {
		const { jobId, owned } = await running();
		takeBackBehindTheRunsBack(jobId, owned.attemptId);

		expect(h.ledger.beat(h.control.kind, owned)).toBe(false);
	});

	it("says no to a worker that is not the attempt's", async () => {
		const { owned } = await running();

		expect(
			h.ledger.beat(h.control.kind, { ...owned, workerId: "someone-else" }),
		).toBe(false);
	});
});

describe("progress", () => {
	it("moves forward only", async () => {
		const control = phased();
		const { jobId, owned } = await running(control);
		expect(job(jobId).phase).toBe("a");

		expect(h.ledger.progress(control.kind, owned, { phase: "b" })).toBe(
			"applied",
		);
		expect(job(jobId).phase).toBe("b");
		expect(h.fixture.readAttempts(jobId)[0].phase).toBe("b");

		// Back is refused, and the phase stays.
		expect(h.ledger.progress(control.kind, owned, { phase: "a" })).toBe(
			"refused",
		);
		expect(job(jobId).phase).toBe("b");

		// The same phase again is legal and is a beat.
		h.fixture.sqlite
			.prepare("update test_job_attempts set heartbeat_at = 1000 where id = ?")
			.run(owned.attemptId);
		expect(h.ledger.progress(control.kind, owned, { phase: "b" })).toBe(
			"applied",
		);
		expect(
			h.fixture.readAttempts(jobId)[0].heartbeatAt?.getTime(),
		).toBeGreaterThan(1_000_000);

		expect(h.ledger.progress(control.kind, owned, { phase: "c" })).toBe(
			"applied",
		);
		expect(job(jobId).phase).toBe("c");
	});

	it("refuses a phase the kind does not list", async () => {
		const control = phased();
		const { jobId, owned } = await running(control);

		expect(h.ledger.progress(control.kind, owned, { phase: "z" })).toBe(
			"refused",
		);
		expect(job(jobId).phase).toBe("a");
	});

	it("takes any phase from a kind that lists none, in any order", async () => {
		const { jobId, owned } = await running();

		expect(h.ledger.progress(h.control.kind, owned, { phase: "z" })).toBe(
			"applied",
		);
		expect(h.ledger.progress(h.control.kind, owned, { phase: "a" })).toBe(
			"applied",
		);
		expect(job(jobId).phase).toBe("a");
	});

	it("replaces the checkpoint, and clears it on null", async () => {
		const { jobId, owned } = await running();

		h.ledger.progress(h.control.kind, owned, { checkpoint: { cursor: 4 } });
		expect(job(jobId).checkpoint).toBe('{"cursor":4}');

		h.ledger.progress(h.control.kind, owned, { checkpoint: null });
		expect(job(jobId).checkpoint).toBeNull();
	});

	it("leaves the checkpoint alone when it is not mentioned", async () => {
		const control = phased();
		const { jobId, owned } = await running(control);
		h.ledger.progress(control.kind, owned, { checkpoint: { cursor: 4 } });

		h.ledger.progress(control.kind, owned, { phase: "b" });

		expect(job(jobId).checkpoint).toBe('{"cursor":4}');
	});

	it("says lost once the claim is gone", async () => {
		const { jobId, owned } = await running();
		takeBackBehindTheRunsBack(jobId, owned.attemptId);

		expect(h.ledger.progress(h.control.kind, owned, { phase: "x" })).toBe(
			"lost",
		);
		expect(job(jobId).phase).toBeNull();
	});
});

describe("write", () => {
	it("runs the callback inside the fenced transaction", async () => {
		const { jobId, owned } = await running();

		const applied = h.ledger.write(h.control.kind, owned, (tx) => {
			tx.update(testJobs)
				.set({ label: "written" })
				.where(eq(testJobs.id, jobId))
				.run();
		});

		expect(applied).toBe(true);
		expect(job(jobId).label).toBe("written");
	});

	it("lets a kind write its own extra attempt columns for the attempt", async () => {
		const { jobId, owned } = await running();

		h.ledger.write(h.control.kind, owned, (tx) => {
			tx.update(testJobAttempts)
				.set({ note: "extractor: direct-text" })
				.where(eq(testJobAttempts.id, owned.attemptId))
				.run();
		});

		expect(h.fixture.readAttempts(jobId)[0].note).toBe(
			"extractor: direct-text",
		);
	});

	it("rolls the callback back when it throws, and says so", async () => {
		const { jobId, owned } = await running();

		expect(() =>
			h.ledger.write(h.control.kind, owned, (tx) => {
				tx.update(testJobs)
					.set({ label: "half" })
					.where(eq(testJobs.id, jobId))
					.run();
				throw new Error("domain write failed");
			}),
		).toThrow("domain write failed");
		expect(job(jobId).label).toBeNull();
	});

	it("does not run the callback once the claim is gone", async () => {
		const { jobId, owned } = await running();
		takeBackBehindTheRunsBack(jobId, owned.attemptId);
		let ran = false;

		const applied = h.ledger.write(h.control.kind, owned, () => {
			ran = true;
		});

		expect(applied).toBe(false);
		expect(ran).toBe(false);
	});

	it("refuses a callback that returns a promise", async () => {
		const { jobId, owned } = await running();

		expect(() =>
			h.ledger.write(
				h.control.kind,
				owned,
				(async () => undefined) as unknown as () => void,
			),
		).toThrow(/promise/);
		expect(job(jobId).status).toBe("running");
	});

	it("counts as a beat", async () => {
		const { jobId, owned } = await running();
		h.fixture.sqlite
			.prepare("update test_job_attempts set heartbeat_at = 1000 where id = ?")
			.run(owned.attemptId);

		h.ledger.write(h.control.kind, owned, () => {});

		expect(
			h.fixture.readAttempts(jobId)[0].heartbeatAt?.getTime(),
		).toBeGreaterThan(1_000_000);
	});
});

describe("succeed", () => {
	it("settles the job and its attempt, and clears what a success makes moot", async () => {
		const { jobId, owned } = await running();
		h.ledger.progress(h.control.kind, owned, { checkpoint: { cursor: 4 } });

		expect(h.ledger.succeed(h.control.kind, owned)).toBe(true);

		expect(job(jobId)).toMatchObject({
			status: "succeeded",
			errorCode: null,
			retryable: false,
			checkpoint: null,
			// The latest attempt is still named: read models look it up.
			currentAttemptId: owned.attemptId,
		});
		expect(job(jobId).completedAt).toBeInstanceOf(Date);
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			status: "succeeded",
		});
		expect(h.fixture.readAttempts(jobId)[0].finishedAt).toBeInstanceOf(Date);
	});

	it("keeps the retry policy's memory", async () => {
		const { jobId, owned } = await running();
		h.fixture.sqlite
			.prepare("update test_jobs set retry_state_json = ? where id = ?")
			.run('{"waits":2}', jobId);

		h.ledger.succeed(h.control.kind, owned);

		expect(job(jobId).retryState).toBe('{"waits":2}');
	});

	it("runs apply in the same transaction: a throw leaves everything as it was", async () => {
		const { jobId, owned } = await running();

		expect(() =>
			h.ledger.succeed(h.control.kind, owned, {
				apply: (tx) => {
					tx.update(testJobs)
						.set({ label: "linked" })
						.where(eq(testJobs.id, jobId))
						.run();
					throw new Error("link failed");
				},
			}),
		).toThrow("link failed");

		expect(job(jobId)).toMatchObject({ status: "running", label: null });
		expect(h.fixture.readAttempts(jobId)[0].status).toBe("running");
	});

	it("applies a domain write with the verdict", async () => {
		const { jobId, owned } = await running();

		h.ledger.succeed(h.control.kind, owned, {
			apply: (tx) => {
				tx.update(testJobs)
					.set({ label: "linked" })
					.where(eq(testJobs.id, jobId))
					.run();
				tx.update(testJobAttempts)
					.set({ note: "2 pages" })
					.where(eq(testJobAttempts.id, owned.attemptId))
					.run();
			},
		});

		expect(job(jobId)).toMatchObject({ status: "succeeded", label: "linked" });
		expect(h.fixture.readAttempts(jobId)[0].note).toBe("2 pages");
	});

	it("writes diagnostics on the attempt", async () => {
		const { jobId, owned } = await running();

		h.ledger.succeed(h.control.kind, owned, {
			diagnostics: { warnings: ["a font was substituted"] },
		});

		expect(h.fixture.readAttempts(jobId)[0].diagnosticsJson).toBe(
			'{"warnings":["a font was substituted"]}',
		);
	});

	it("tells the kind, after its own writes and before apply's", async () => {
		const { jobId, owned } = await running();
		const order: string[] = [];
		h.control.transitionHook = (_tx, _row, to) =>
			order.push(`transition:${to}`);

		h.ledger.succeed(h.control.kind, owned, {
			apply: () => order.push("apply"),
		});

		expect(order).toEqual(["transition:succeeded", "apply"]);
		expect(job(jobId).status).toBe("succeeded");
	});

	it("is refused a second time, and after a cancel", async () => {
		const { jobId, owned } = await running();

		expect(h.ledger.succeed(h.control.kind, owned)).toBe(true);
		expect(h.ledger.succeed(h.control.kind, owned)).toBe(false);

		const second = await running();
		h.ledger.cancel(h.control.kind, second.jobId, { userId: h.userId });
		expect(h.ledger.succeed(h.control.kind, second.owned)).toBe(false);
		expect(job(second.jobId).status).toBe("cancelled");
		expect(job(jobId).status).toBe("succeeded");
	});

	it("announces the verdict after the commit", async () => {
		const { jobId, owned } = await running();
		const heard: string[] = [];
		onSettled("test", jobId, (event) => {
			// The verdict is on the row by the time anyone hears of it.
			heard.push(`${event.status}:${job(jobId).status}`);
		});

		h.ledger.succeed(h.control.kind, owned);

		expect(heard).toEqual(["succeeded:succeeded"]);
	});
});

describe("fail", () => {
	it("keeps the error and sets the run time when the policy requeues", async () => {
		const { jobId, owned } = await running();
		h.control.decide = () => ({
			requeue: true,
			delayMs: 5_000,
			state: { waits: 1 },
		});
		const before = Date.now();

		const outcome = h.ledger.fail(h.control.kind, owned, {
			code: "backend_down",
			message: "The backend did not answer.",
			retryable: true,
		});

		expect(outcome).toMatchObject({ applied: true, requeued: true });
		expect(outcome.runAfter?.getTime()).toBeGreaterThanOrEqual(before + 4_000);
		expect(outcome.runAfter?.getTime()).toBeLessThanOrEqual(before + 7_000);
		expect(job(jobId)).toMatchObject({
			status: "queued",
			errorCode: "backend_down",
			errorMessage: "The backend did not answer.",
			retryable: true,
			completedAt: null,
			retryState: '{"waits":1}',
			// The count is the attempts so far; a requeue does not rewind it.
			attemptCount: 1,
		});
		expect(job(jobId).runAfter).toBeInstanceOf(Date);
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			status: "failed",
			errorCode: "backend_down",
			retryable: true,
		});
	});

	it("records the failure the policy rewrote on the job, and the original on the attempt", async () => {
		const { jobId, owned } = await running();
		h.control.decide = () => ({
			requeue: false,
			retryable: true,
			code: "max_attempts",
		});

		h.ledger.fail(h.control.kind, owned, {
			code: "job_failed",
			message: "Boom.",
			retryable: true,
		});

		expect(job(jobId)).toMatchObject({
			status: "failed",
			errorCode: "max_attempts",
			errorMessage: "Boom.",
			retryable: true,
		});
		expect(h.fixture.readAttempts(jobId)[0].errorCode).toBe("job_failed");
	});

	it("hands the policy the attempts so far, its own memory and the time", async () => {
		const { jobId, owned } = await running();
		h.fixture.sqlite
			.prepare("update test_jobs set retry_state_json = ? where id = ?")
			.run('{"since":123}', jobId);
		const seen: unknown[] = [];
		h.control.decide = (failure, history) => {
			seen.push({ code: failure.code, ...history });
			return { requeue: false, retryable: false };
		};

		h.ledger.fail(h.control.kind, owned, {
			code: "x",
			message: "m",
			retryable: true,
		});

		expect(seen).toEqual([
			{
				code: "x",
				attempts: 1,
				state: { since: 123 },
				nowMs: expect.any(Number),
			},
		]);
	});

	it("settles, clears the checkpoint and stamps the end when the policy gives up", async () => {
		const { jobId, owned } = await running();
		h.ledger.progress(h.control.kind, owned, { checkpoint: { cursor: 4 } });

		const outcome = h.ledger.fail(h.control.kind, owned, {
			code: "bad_input",
			message: "No.",
			retryable: false,
		});

		expect(outcome).toEqual({ applied: true, requeued: false, runAfter: null });
		expect(job(jobId)).toMatchObject({
			status: "failed",
			retryable: false,
			checkpoint: null,
			runAfter: null,
		});
		expect(job(jobId).completedAt).toBeInstanceOf(Date);
	});

	it("keeps the checkpoint across a requeue", async () => {
		const { jobId, owned } = await running();
		h.ledger.progress(h.control.kind, owned, { checkpoint: { cursor: 4 } });
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		h.ledger.fail(h.control.kind, owned, {
			code: "x",
			message: "m",
			retryable: true,
		});

		expect(job(jobId)).toMatchObject({
			status: "queued",
			checkpoint: '{"cursor":4}',
		});
		// And the next attempt resumes from it.
		expect(
			h.ledger.claimNext(h.control.kind, { workerId: WORKER })?.row.checkpoint,
		).toBe('{"cursor":4}');
	});

	it("drops the checkpoint even on a requeue when the failure says it is stale", async () => {
		const { jobId, owned } = await running();
		h.ledger.progress(h.control.kind, owned, {
			checkpoint: { remote: "gone" },
		});
		h.control.decide = () => ({ requeue: true, delayMs: 0 });

		h.ledger.fail(h.control.kind, owned, {
			code: "handle_unknown",
			message: "The remote job is gone.",
			retryable: true,
			discardCheckpoint: true,
		});

		expect(job(jobId)).toMatchObject({ status: "queued", checkpoint: null });
	});

	it("writes the failure's diagnostics on the attempt", async () => {
		const { jobId, owned } = await running();

		h.ledger.fail(h.control.kind, owned, {
			code: "x",
			message: "m",
			retryable: true,
			diagnostics: { stderr: "oops" },
		});

		expect(h.fixture.readAttempts(jobId)[0].diagnosticsJson).toBe(
			'{"stderr":"oops"}',
		);
	});

	it("runs apply in the same transaction, and may write the attempt's own columns", async () => {
		const { jobId, owned } = await running();

		h.ledger.fail(
			h.control.kind,
			owned,
			{ code: "x", message: "m", retryable: false },
			{
				apply: (tx) => {
					tx.update(testJobAttempts)
						.set({ note: "failed in render" })
						.where(eq(testJobAttempts.id, owned.attemptId))
						.run();
				},
			},
		);
		expect(h.fixture.readAttempts(jobId)[0].note).toBe("failed in render");

		const second = await running();
		expect(() =>
			h.ledger.fail(
				h.control.kind,
				second.owned,
				{ code: "x", message: "m", retryable: false },
				{
					apply: () => {
						throw new Error("apply failed");
					},
				},
			),
		).toThrow("apply failed");
		expect(job(second.jobId).status).toBe("running");
	});

	it("announces a verdict, but not a requeue", async () => {
		const settled = await running();
		const requeued = await running();
		const heard: string[] = [];
		onSettled("test", settled.jobId, (event) => heard.push(event.status));
		onSettled("test", requeued.jobId, (event) => heard.push(event.status));

		h.control.decide = () => ({ requeue: true, delayMs: 0 });
		h.ledger.fail(h.control.kind, requeued.owned, {
			code: "x",
			message: "m",
			retryable: true,
		});
		expect(heard).toEqual([]);

		h.control.decide = null;
		h.ledger.fail(h.control.kind, settled.owned, {
			code: "x",
			message: "m",
			retryable: false,
		});
		expect(heard).toEqual(["failed"]);
	});

	it("runs a requeue at once, with a valid time, when the policy's delay is not a usable number", async () => {
		for (const delayMs of [Number.NaN, Number.POSITIVE_INFINITY, -5_000]) {
			const { jobId, owned } = await running();
			h.control.decide = () => ({ requeue: true, delayMs });
			const before = Date.now();

			const outcome = h.ledger.fail(h.control.kind, owned, {
				code: "x",
				message: "m",
				retryable: true,
			});

			expect(outcome.requeued).toBe(true);
			expect(outcome.runAfter?.getTime()).toBeGreaterThanOrEqual(before);
			expect(outcome.runAfter?.getTime()).toBeLessThan(before + 2_000);
			expect(job(jobId).runAfter).toBeInstanceOf(Date);
			expect(Number.isNaN(job(jobId).runAfter?.getTime())).toBe(false);
			// Out of the way, so the next round claims its own job.
			h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });
		}
	});

	it("settles the job failed, and says so, when the policy itself throws", async () => {
		const { jobId, owned } = await running();
		h.control.decide = () => {
			throw new Error("policy bug");
		};

		const outcome = h.ledger.fail(h.control.kind, owned, {
			code: "x",
			message: "m",
			retryable: true,
		});

		// A bug in a policy must not leave the job `running` and holding a slot.
		expect(outcome).toMatchObject({ applied: true, requeued: false });
		expect(job(jobId)).toMatchObject({ status: "failed", retryable: true });
	});
});

describe("a late write after a take-back", () => {
	it("is refused by every fenced transition", async () => {
		const { jobId, owned } = await running();
		takeBackBehindTheRunsBack(jobId, owned.attemptId);
		const untouched = job(jobId);
		let applied = false;

		expect(
			h.ledger.succeed(h.control.kind, owned, {
				apply: () => (applied = true),
			}),
		).toBe(false);
		expect(
			h.ledger.fail(h.control.kind, owned, {
				code: "x",
				message: "m",
				retryable: true,
			}),
		).toEqual({ applied: false, requeued: false, runAfter: null });
		expect(h.ledger.progress(h.control.kind, owned, { phase: "p" })).toBe(
			"lost",
		);
		expect(h.ledger.write(h.control.kind, owned, () => (applied = true))).toBe(
			false,
		);
		expect(h.ledger.beat(h.control.kind, owned)).toBe(false);

		expect(applied).toBe(false);
		expect(job(jobId)).toEqual(untouched);
	});

	it("does not touch the attempt that took the job over", async () => {
		const { jobId, owned } = await running();
		takeBackBehindTheRunsBack(jobId, owned.attemptId);
		const next = h.ledger.claimNext(h.control.kind, { workerId: "worker-2" });
		expect(next?.attempt.number).toBe(2);

		// The old run's verdict arrives late.
		expect(h.ledger.succeed(h.control.kind, owned)).toBe(false);

		expect(job(jobId)).toMatchObject({
			status: "running",
			currentAttemptId: next?.attempt.id,
		});
	});
});

describe("cancel", () => {
	it("settles a queued job without an attempt", async () => {
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
			runAfter: new Date(Date.now() + 60_000),
		});

		const cancelled = h.ledger.cancel(h.control.kind, row.id, {
			userId: h.userId,
		});

		expect(cancelled).toMatchObject({
			id: row.id,
			status: "cancelled",
			retryable: false,
			runAfter: null,
			errorCode: null,
		});
		expect(cancelled?.completedAt).toBeInstanceOf(Date);
		expect(cancelled?.cancelRequestedAt).toBeInstanceOf(Date);
		expect(h.fixture.readAttempts(row.id)).toEqual([]);
		expect(h.control.transitions.at(-1)).toEqual({
			jobId: row.id,
			to: "cancelled",
		});
	});

	it("settles a running job and closes its attempt as cancelled", async () => {
		const { jobId, owned } = await running();
		h.ledger.progress(h.control.kind, owned, { checkpoint: { cursor: 4 } });

		const cancelled = h.ledger.cancel(h.control.kind, jobId, {
			userId: h.userId,
		});

		expect(cancelled).toMatchObject({
			status: "cancelled",
			checkpoint: null,
			errorCode: null,
			errorMessage: null,
			// The latest attempt is still named.
			currentAttemptId: owned.attemptId,
		});
		expect(h.fixture.readAttempts(jobId)[0]).toMatchObject({
			status: "cancelled",
			errorCode: "cancelled",
			retryable: false,
		});
		expect(h.fixture.readAttempts(jobId)[0].finishedAt).toBeInstanceOf(Date);
	});

	it("keeps the time a cancel was first requested", async () => {
		const requestedAt = new Date(Date.now() - 3_600_000);
		const jobId = h.fixture.seedJob({
			userId: h.userId,
			cancelRequestedAt: requestedAt,
		});

		const cancelled = h.ledger.cancel(h.control.kind, jobId, {
			userId: h.userId,
		});

		expect(cancelled?.cancelRequestedAt?.getTime()).toBe(
			Math.floor(requestedAt.getTime() / 1000) * 1000,
		);
	});

	it("refuses another user's job, and a job that has settled", async () => {
		const other = h.fixture.seedUser("user-2");
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		const done = h.fixture.seedJob({ userId: h.userId, status: "succeeded" });

		expect(
			h.ledger.cancel(h.control.kind, row.id, { userId: other }),
		).toBeNull();
		expect(
			h.ledger.cancel(h.control.kind, done, { userId: h.userId }),
		).toBeNull();
		expect(
			h.ledger.cancel(h.control.kind, "nope", { userId: h.userId }),
		).toBeNull();
		expect(job(row.id).status).toBe("queued");
		expect(job(done).status).toBe("succeeded");
	});

	it("announces the verdict", async () => {
		const { jobId } = await running();
		const heard: string[] = [];
		onSettled("test", jobId, (event) => heard.push(event.status));

		h.ledger.cancel(h.control.kind, jobId, { userId: h.userId });

		expect(heard).toEqual(["cancelled"]);
	});
});

describe("cancelAll", () => {
	it("cancels a user's queued and running jobs and nobody else's", async () => {
		const other = h.fixture.seedUser("user-2");
		const live = await running();
		const queued = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});
		const done = h.fixture.seedJob({ userId: h.userId, status: "failed" });
		const theirs = h.fixture.seedJob({ userId: other });

		const count = h.ledger.cancelAll(h.control.kind, { userId: h.userId });

		expect(count).toBe(2);
		expect(job(live.jobId).status).toBe("cancelled");
		expect(job(queued.row.id).status).toBe("cancelled");
		expect(job(done).status).toBe("failed");
		expect(job(theirs).status).toBe("queued");
		expect(h.fixture.readAttempts(live.jobId)[0].status).toBe("cancelled");
	});

	it("stays inside the domain scope it is given", async () => {
		const a = h.fixture.seedJob({ userId: h.userId, label: "chat-a" });
		const b = h.fixture.seedJob({ userId: h.userId, label: "chat-b" });

		const count = h.ledger.cancelAll(h.control.kind, {
			userId: h.userId,
			where: (jobs) => eq(jobs.label, "chat-a"),
		});

		expect(count).toBe(1);
		expect(job(a).status).toBe("cancelled");
		expect(job(b).status).toBe("queued");
	});

	it("says zero when there is nothing to cancel", () => {
		expect(h.ledger.cancelAll(h.control.kind, { userId: h.userId })).toBe(0);
	});
});

describe("retry", () => {
	const failedJob = (overrides: Record<string, unknown> = {}) => {
		const jobId = h.fixture.seedJob({
			userId: h.userId,
			status: "failed",
			attemptCount: 2,
			retryable: true,
			errorCode: "job_failed",
			errorMessage: "It broke.",
			completedAt: new Date(),
			cancelRequestedAt: new Date(),
			runAfter: new Date(Date.now() + 60_000),
			...overrides,
		});
		h.fixture.seedAttempt({ jobId, attemptNumber: 1, status: "failed" });
		h.fixture.seedAttempt({ jobId, attemptNumber: 2, status: "failed" });
		return jobId;
	};

	beforeEach(() => {
		h.control.definition.userRetry = { from: ["failed", "cancelled"] };
	});

	it("reopens a failed job: queued, the error and the gates cleared, the count kept", async () => {
		const jobId = failedJob();

		const reopened = h.ledger.retry(h.control.kind, jobId, {
			userId: h.userId,
		});

		expect(reopened).toMatchObject({
			status: "queued",
			errorCode: null,
			errorMessage: null,
			retryable: false,
			runAfter: null,
			cancelRequestedAt: null,
			completedAt: null,
			attemptCount: 2,
		});
		expect(h.control.transitions.at(-1)).toEqual({ jobId, to: "queued" });
		// Attempt numbers keep counting.
		expect(
			h.ledger.claimNext(h.control.kind, { workerId: WORKER })?.attempt.number,
		).toBe(3);
	});

	it("reopens a cancelled job when the kind allows it", () => {
		const jobId = h.fixture.seedJob({ userId: h.userId, status: "cancelled" });

		expect(
			h.ledger.retry(h.control.kind, jobId, { userId: h.userId })?.status,
		).toBe("queued");
	});

	it("refuses a status the kind does not name, and another user's job", async () => {
		h.control.definition.userRetry = { from: ["failed"] };
		const cancelled = h.fixture.seedJob({
			userId: h.userId,
			status: "cancelled",
		});
		const failed = failedJob();
		const other = h.fixture.seedUser("user-2");

		expect(
			h.ledger.retry(h.control.kind, cancelled, { userId: h.userId }),
		).toBeNull();
		expect(
			h.ledger.retry(h.control.kind, failed, { userId: other }),
		).toBeNull();
		expect(job(cancelled).status).toBe("cancelled");
		expect(job(failed).status).toBe("failed");
	});

	it("refuses a job that is not retryable when the kind requires it", () => {
		h.control.definition.userRetry = {
			from: ["failed"],
			requireRetryable: true,
		};
		const stuck = failedJob({ retryable: false });
		const fine = failedJob({ retryable: true });

		expect(
			h.ledger.retry(h.control.kind, stuck, { userId: h.userId }),
		).toBeNull();
		expect(
			h.ledger.retry(h.control.kind, fine, { userId: h.userId })?.status,
		).toBe("queued");
	});

	it("respects the kind's own rule", () => {
		h.control.definition.userRetry = {
			from: ["failed"],
			allow: (row) => row.attemptCount < 3,
		};
		const spent = failedJob({ attemptCount: 3 });
		const fresh = failedJob({ attemptCount: 2 });

		expect(
			h.ledger.retry(h.control.kind, spent, { userId: h.userId }),
		).toBeNull();
		expect(
			h.ledger.retry(h.control.kind, fresh, { userId: h.userId })?.status,
		).toBe("queued");
	});

	it("agrees with describeJob about every job it is asked about", () => {
		const cases = [
			{
				userRetry: { from: ["failed"] as const },
				status: "failed",
				retryable: true,
			},
			{
				userRetry: { from: ["failed"] as const },
				status: "cancelled",
				retryable: true,
			},
			{
				userRetry: {
					from: ["failed", "cancelled"] as const,
					requireRetryable: true,
				},
				status: "failed",
				retryable: false,
			},
			{
				userRetry: {
					from: ["failed"] as const,
					allow: (row: { attemptCount: number }) => row.attemptCount < 2,
				},
				status: "failed",
				retryable: true,
			},
		];
		for (const entry of cases) {
			h.control.definition.userRetry = entry.userRetry as never;
			const jobId = h.fixture.seedJob({
				userId: h.userId,
				status: entry.status,
				retryable: entry.retryable,
				attemptCount: 2,
			});
			const described = h.engine.describeJob(
				h.control.kind,
				job(jobId),
			).canRetry;

			const retried = h.ledger.retry(h.control.kind, jobId, {
				userId: h.userId,
			});

			expect(retried !== null).toBe(described);
		}
	});

	it("requeues once when pressed twice", async () => {
		const jobId = failedJob();

		const first = h.ledger.retry(h.control.kind, jobId, { userId: h.userId });
		const second = h.ledger.retry(h.control.kind, jobId, { userId: h.userId });

		expect(first?.status).toBe("queued");
		expect(second).toBeNull();
		expect(job(jobId)).toMatchObject({ status: "queued" });
	});

	it("leaves one consistent state when Cancel and Retry arrive together", async () => {
		const { jobId, owned } = await running();

		const [cancelled, retried] = await Promise.all([
			Promise.resolve().then(() =>
				h.ledger.cancel(h.control.kind, jobId, { userId: h.userId }),
			),
			Promise.resolve().then(() =>
				h.ledger.retry(h.control.kind, jobId, { userId: h.userId }),
			),
		]);

		// Cancel first: the job is cancelled, and Retry then reopens it. Retry
		// first: it refuses a running job, and Cancel then settles it.
		expect(cancelled).not.toBeNull();
		expect(["cancelled", "queued"]).toContain(job(jobId).status);
		if (retried === null) expect(job(jobId).status).toBe("cancelled");
		// Never two attempts running, and the old run is shut out either way.
		const live = h.fixture
			.readAttempts(jobId)
			.filter((attempt) => attempt.status === "running");
		expect(live).toEqual([]);
		expect(h.ledger.succeed(h.control.kind, owned)).toBe(false);
	});
});

describe("reopen", () => {
	const settled = (overrides: Record<string, unknown> = {}) =>
		h.fixture.seedJob({
			userId: h.userId,
			status: "succeeded",
			attemptCount: 1,
			checkpoint: '{"cursor":9}',
			retryState: '{"waits":3,"since":55}',
			completedAt: new Date(),
			...overrides,
		});

	it("reopens a settled job from the statuses it is given", () => {
		const done = settled();
		const failed = settled({ status: "failed" });

		expect(
			h.ledger.reopen(h.control.kind, done, {
				userId: h.userId,
				from: ["failed"],
			}),
		).toBeNull();
		const reopened = h.ledger.reopen(h.control.kind, done, {
			userId: h.userId,
			from: ["succeeded"],
		});

		expect(reopened).toMatchObject({
			status: "queued",
			errorCode: null,
			runAfter: null,
			completedAt: null,
			// Cleared unless the caller keeps it.
			checkpoint: null,
			// The retry policy's memory is untouched unless the caller rewrites it.
			retryState: '{"waits":3,"since":55}',
			attemptCount: 1,
		});
		expect(job(failed).status).toBe("failed");
	});

	it("never reopens a job that is queued or running, whatever it is told", async () => {
		const { jobId } = await running();
		const queued = h.fixture.seedJob({ userId: h.userId });

		for (const id of [queued, jobId]) {
			expect(
				h.ledger.reopen(h.control.kind, id, {
					userId: h.userId,
					from: ["queued", "running"],
				}),
			).toBeNull();
		}
		expect(job(jobId).status).toBe("running");
	});

	it("refuses another user's job", () => {
		const other = h.fixture.seedUser("user-2");

		expect(
			h.ledger.reopen(h.control.kind, settled(), {
				userId: other,
				from: ["succeeded"],
			}),
		).toBeNull();
	});

	it("asks the kind's rule inside the transaction", () => {
		const id = settled();
		const seen: string[] = [];

		expect(
			h.ledger.reopen(h.control.kind, id, {
				userId: h.userId,
				from: ["succeeded"],
				allow: (tx, row) => {
					seen.push(row.id);
					return (
						tx.select().from(testJobs).where(eq(testJobs.id, id)).all()
							.length === 0
					);
				},
			}),
		).toBeNull();
		expect(seen).toEqual([id]);
		expect(job(id).status).toBe("succeeded");
	});

	it("writes the kind's domain patch with the reopening", () => {
		const id = settled({ label: "old" });

		const reopened = h.ledger.reopen(h.control.kind, id, {
			userId: h.userId,
			from: ["succeeded"],
			patch: (row) => ({ label: `${row.label}+hints` }),
		});

		expect(reopened).toMatchObject({ status: "queued", label: "old+hints" });
	});

	it("keeps the checkpoint when asked to", () => {
		const id = settled();

		const reopened = h.ledger.reopen(h.control.kind, id, {
			userId: h.userId,
			from: ["succeeded"],
			keepCheckpoint: true,
		});

		expect(reopened?.checkpoint).toBe('{"cursor":9}');
	});

	it("rewrites the retry policy's memory with the caller's function", () => {
		const id = settled();

		const reopened = h.ledger.reopen(h.control.kind, id, {
			userId: h.userId,
			from: ["succeeded"],
			retryState: (state) => ({
				waits: (state as { waits: number }).waits,
				since: null,
			}),
		});

		expect(reopened?.retryState).toBe('{"waits":3,"since":null}');
	});

	it("tells the kind it is queued again", () => {
		const id = settled();

		h.ledger.reopen(h.control.kind, id, {
			userId: h.userId,
			from: ["succeeded"],
		});

		expect(h.control.transitions.at(-1)).toEqual({ jobId: id, to: "queued" });
	});
});

describe("the row the engine hands back after the kind's onTransition", () => {
	// The hook runs inside the transaction that makes the transition and may write
	// the kind's own columns (Atlas's `stage`). A caller that shows the row it gets
	// back must see those columns as the hook left them, not as they were when the
	// row was read, before the hook ran. Here the hook writes the `label` column.
	beforeEach(() => {
		h.control.definition.userRetry = { from: ["failed", "cancelled"] };
		h.control.transitionHook = (tx, row, to) => {
			tx.update(testJobs)
				.set({ label: `hook:${to}` })
				.where(eq(testJobs.id, row.id))
				.run();
		};
	});

	it("enqueue returns the job with the hook's write", async () => {
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		expect(row.label).toBe("hook:queued");
		expect(row).toEqual(job(row.id));
	});

	it("the claim returns the job with the hook's write", async () => {
		const { row } = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		const claimed = h.ledger.claimNext(h.control.kind, { workerId: WORKER });

		// The claim's row is the one stored, hook's write included.
		expect(job(row.id).label).toBe("hook:running");
		expect(claimed?.row).toEqual(job(row.id));
	});

	it("the handler's row has the hook's write", async () => {
		let seen: string | null | undefined;
		h.control.run = async (ctx) => {
			seen = ctx.row.label;
			await ctx.succeed();
		};
		await h.engine.enqueue(h.control.kind, { values: { userId: h.userId } });

		await h.engine.drain(h.control.kind);

		expect(seen).toBe("hook:running");
	});

	it("cancel returns the job with the hook's write, queued or running", async () => {
		// The claim takes the oldest job, so the running one goes first.
		const live = await running();
		const queued = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		const fromQueued = h.ledger.cancel(h.control.kind, queued.row.id, {
			userId: h.userId,
		});
		const fromRunning = h.ledger.cancel(h.control.kind, live.jobId, {
			userId: h.userId,
		});

		expect(fromQueued?.label).toBe("hook:cancelled");
		expect(fromQueued).toEqual(job(queued.row.id));
		expect(fromRunning?.label).toBe("hook:cancelled");
		expect(fromRunning).toEqual(job(live.jobId));
	});

	it("cancelAll leaves the hook's write on every job it cancels", async () => {
		const live = await running();
		const queued = await h.engine.enqueue(h.control.kind, {
			values: { userId: h.userId },
		});

		expect(h.ledger.cancelAll(h.control.kind, { userId: h.userId })).toBe(2);

		expect(job(queued.row.id).label).toBe("hook:cancelled");
		expect(job(live.jobId).label).toBe("hook:cancelled");
	});

	it("retry returns the job with the hook's write", () => {
		const jobId = h.fixture.seedJob({
			userId: h.userId,
			status: "failed",
			label: "hook:failed",
		});

		const reopened = h.ledger.retry(h.control.kind, jobId, {
			userId: h.userId,
		});

		expect(reopened?.label).toBe("hook:queued");
		expect(reopened).toEqual(job(jobId));
	});

	it("reopen returns the job with the hook's write", () => {
		const jobId = h.fixture.seedJob({
			userId: h.userId,
			status: "succeeded",
			label: "hook:succeeded",
		});

		const reopened = h.ledger.reopen(h.control.kind, jobId, {
			userId: h.userId,
			from: ["succeeded"],
		});

		expect(reopened?.label).toBe("hook:queued");
		expect(reopened).toEqual(job(jobId));
	});
});

describe("waking the kind", () => {
	const wakes = () => h.engine.inspectJobsForTests().test?.wakeRequests ?? 0;

	it("wakes after retry and after reopen, not after a refusal", async () => {
		h.control.definition.userRetry = { from: ["failed"] };
		const failed = h.fixture.seedJob({ userId: h.userId, status: "failed" });
		const done = h.fixture.seedJob({ userId: h.userId, status: "succeeded" });
		const before = wakes();

		await h.engine.retry(h.control.kind, failed, { userId: h.userId });
		expect(wakes()).toBe(before + 1);

		await h.engine.reopen(h.control.kind, done, {
			userId: h.userId,
			from: ["succeeded"],
		});
		expect(wakes()).toBe(before + 2);

		await h.engine.retry(h.control.kind, "nope", { userId: h.userId });
		await h.engine.reopen(h.control.kind, "nope", {
			userId: h.userId,
			from: ["succeeded"],
		});
		expect(wakes()).toBe(before + 2);
	});
});

describe("a kind's callback that runs inside a transaction", () => {
	// A transaction is synchronous: whatever an async callback does after its
	// first `await` runs after the COMMIT, outside the transaction and outside the
	// fence. TypeScript accepts an async function where `=> void` or `=> unknown`
	// is asked for, so these two are not caught by the types; the engine refuses
	// them, as it already refuses an async `apply`.
	function asyncHooked(): TestKindControl {
		return createTestKind(h.engine.defineJobKind, {
			name: "async-hook",
			onTransition: async () => {
				await Promise.resolve();
			},
		});
	}

	it("refuses an onTransition that returns a promise, and the enqueue writes nothing", async () => {
		const hooked = asyncHooked();

		await expect(
			h.engine.enqueue(hooked.kind, { values: { userId: h.userId } }),
		).rejects.toThrow(/promise/);
		expect(
			h.fixture.sqlite.prepare("select count(*) as n from test_jobs").get(),
		).toEqual({ n: 0 });
	});

	it("refuses an onTransition that returns a promise, and the claim takes nothing", () => {
		const hooked = asyncHooked();
		const id = h.fixture.seedJob({ userId: h.userId });

		expect(() => h.ledger.claimNext(hooked.kind, { workerId: WORKER })).toThrow(
			/promise/,
		);
		expect(job(id).status).toBe("queued");
		expect(h.fixture.readAttempts(id)).toEqual([]);
	});

	it("refuses a retryState that returns a promise, and the reopen writes nothing", () => {
		const id = h.fixture.seedJob({
			userId: h.userId,
			status: "succeeded",
			retryState: '{"waits":3}',
			completedAt: new Date(),
		});

		expect(() =>
			h.ledger.reopen(h.control.kind, id, {
				userId: h.userId,
				from: ["succeeded"],
				retryState: async (state) => state,
			}),
		).toThrow(/promise/);
		expect(job(id)).toMatchObject({
			status: "succeeded",
			retryState: '{"waits":3}',
		});
	});
});
