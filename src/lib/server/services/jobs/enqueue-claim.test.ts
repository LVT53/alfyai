// Creating a job and taking one: `defineJobKind`, `enqueue`, the fair claim and
// `describeJob`, over the engine's test kind.

import { and, eq, sql } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { jobAttemptColumns, jobColumns } from "./columns";
import { bootEngine, type EngineHarness } from "./testing/harness";
import { createTestKind, testJobs } from "./testing/test-kind";
import type { EnqueueInput, JobKindDefinition, JobTable } from "./types";

type TestJobs = typeof testJobs;

let h: EngineHarness;

beforeEach(async () => {
	h = await bootEngine("enqueue-claim");
});

afterEach(() => {
	h.cleanup();
});

function enqueue(
	input: Omit<EnqueueInput<TestJobs>, "values"> & {
		values?: Partial<EnqueueInput<TestJobs>["values"]>;
	} = {},
	engine = h.engine,
	kind = h.control.kind,
) {
	return engine.enqueue(kind, {
		...input,
		values: { userId: h.userId, ...input.values },
	});
}

function wakeRequests(): number {
	return h.engine.inspectJobsForTests().test?.wakeRequests ?? 0;
}

/** Finds the job a test key stands for, through the idempotency hooks. */
function byKey(key: string, verdict: "reuse" | "replace" | "insert") {
	return {
		find: (
			tx: Parameters<
				NonNullable<EnqueueInput<TestJobs>["idempotency"]>["find"]
			>[0],
		) =>
			tx
				.select()
				.from(testJobs)
				.where(and(eq(testJobs.userId, h.userId), eq(testJobs.idemKey, key)))
				.get() ?? null,
		onExisting: () => verdict,
	};
}

describe("defineJobKind", () => {
	const define = (overrides: Record<string, unknown>) =>
		createTestKind(h.engine.defineJobKind, overrides as never);

	it("hands back a kind that carries its name and log prefix", () => {
		expect(h.control.kind.name).toBe("test");
		expect(h.control.kind.logPrefix).toBe("[TEST]");
	});

	it("rejects a name that is already another table's", () => {
		const otherJobs = sqliteTable("other_jobs", { ...jobColumns() });
		const otherAttempts = sqliteTable("other_job_attempts", {
			...jobAttemptColumns({ jobId: () => otherJobs.id }),
		});

		expect(() =>
			h.engine.defineJobKind({
				...h.control.definition,
				tables: { jobs: otherJobs, attempts: otherAttempts },
			} as unknown as JobKindDefinition<
				typeof otherJobs,
				typeof otherAttempts
			>),
		).toThrow(/test.*another/i);
	});

	it("accepts the same name over the same table again (a module re-evaluated)", () => {
		// HMR re-runs the file that defines a kind while this module stays put.
		expect(() => define({})).not.toThrow();
	});

	it("rejects a phase list with duplicates", () => {
		expect(() => define({ name: "phases", phases: ["a", "b", "a"] })).toThrow(
			/duplicate/i,
		);
	});

	it("rejects a definition without a handler or without onFailure", () => {
		expect(() => define({ name: "no-handler", handler: undefined })).toThrow(
			/handler/,
		);
		expect(() => define({ name: "no-policy", onFailure: undefined })).toThrow(
			/onFailure/,
		);
	});

	it("rejects a table that lacks a lifecycle column", () => {
		const { checkpoint: _dropped, ...withoutCheckpoint } = jobColumns();
		const brokenJobs = sqliteTable("broken_jobs", {
			...withoutCheckpoint,
			label: text("label"),
		});
		const brokenAttempts = sqliteTable("broken_job_attempts", {
			...jobAttemptColumns({ jobId: () => brokenJobs.id }),
		});

		expect(() =>
			h.engine.defineJobKind({
				...h.control.definition,
				name: "broken",
				tables: { jobs: brokenJobs, attempts: brokenAttempts },
			} as unknown as JobKindDefinition<JobTable, never>),
		).toThrow(/checkpoint/);
	});

	it("rejects a name the worker id cannot carry", () => {
		// Worker ids are colon-separated; a colon in the name shifts every field.
		expect(() => define({ name: "bad:name" })).toThrow(/name/);
		expect(() => define({ name: "" })).toThrow(/name/);
	});
});

describe("enqueue", () => {
	it("inserts a queued job with lifecycle defaults", async () => {
		const { row, reused } = await enqueue({ values: { label: "a" } });

		expect(reused).toBe(false);
		expect(row).toMatchObject({
			userId: h.userId,
			label: "a",
			status: "queued",
			attemptCount: 0,
			currentAttemptId: null,
			priority: 0,
			runAfter: null,
			phase: null,
			retryable: false,
			errorCode: null,
			errorMessage: null,
			checkpoint: null,
			retryState: null,
			cancelRequestedAt: null,
			startedAt: null,
			completedAt: null,
		});
		expect(row.createdAt).toBeInstanceOf(Date);
		expect(h.fixture.readJob(row.id)).toMatchObject({
			id: row.id,
			status: "queued",
			label: "a",
		});
		expect(h.fixture.readAttempts(row.id)).toEqual([]);
		// The kind hears about a birth too (Atlas keeps its `stage` in step).
		expect(h.control.transitions).toEqual([{ jobId: row.id, to: "queued" }]);
	});

	it("takes the priority and the earliest run time it is given", async () => {
		const runAfter = new Date(Date.now() + 60_000);
		const { row } = await enqueue({ priority: 10, runAfter });

		expect(row.priority).toBe(10);
		expect(row.runAfter?.getTime()).toBe(
			Math.floor(runAfter.getTime() / 1000) * 1000,
		);
	});

	it("wakes the kind for a queued job", async () => {
		const before = wakeRequests();
		await enqueue();
		expect(wakeRequests()).toBe(before + 1);
	});

	it("refuses a job without a user", async () => {
		await expect(
			h.engine.enqueue(h.control.kind, { values: {} as never }),
		).rejects.toThrow(/userId/);
	});

	it("settles a job born failed at once, and wakes nothing", async () => {
		const before = wakeRequests();
		const { row } = await enqueue({
			born: {
				status: "failed",
				code: "invalid_request",
				message: "The request was refused.",
				retryable: true,
			},
		});

		expect(row).toMatchObject({
			status: "failed",
			errorCode: "invalid_request",
			errorMessage: "The request was refused.",
			retryable: true,
			attemptCount: 0,
			currentAttemptId: null,
		});
		expect(row.completedAt).toBeInstanceOf(Date);
		expect(row.runAfter).toBeNull();
		expect(wakeRequests()).toBe(before);
	});

	it("settles a job born succeeded at once, and wakes nothing", async () => {
		const before = wakeRequests();
		const { row } = await enqueue({ born: { status: "succeeded" } });

		expect(row).toMatchObject({
			status: "succeeded",
			errorCode: null,
			errorMessage: null,
			retryable: false,
		});
		expect(row.completedAt).toBeInstanceOf(Date);
		expect(wakeRequests()).toBe(before);
	});

	it("tells the kind about a job born settled", async () => {
		await enqueue({ born: { status: "succeeded" } });
		expect(h.control.transitions.map((entry) => entry.to)).toEqual([
			"succeeded",
		]);
	});

	it("reuses the job a repeated request finds", async () => {
		const first = await enqueue({
			values: { idemKey: "k" },
			idempotency: byKey("k", "reuse"),
		});
		const second = await enqueue({
			values: { idemKey: "k" },
			idempotency: byKey("k", "reuse"),
		});

		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.row.id).toBe(first.row.id);
		expect(
			h.fixture.sqlite.prepare("select count(*) as n from test_jobs").get(),
		).toEqual({ n: 1 });
	});

	it("replaces the job a repeated request finds, and its attempts with it", async () => {
		const oldId = h.fixture.seedJob({
			userId: h.userId,
			idemKey: "k",
			status: "failed",
		});
		h.fixture.seedAttempt({
			jobId: oldId,
			attemptNumber: 1,
			status: "failed",
		});

		const { row, reused } = await enqueue({
			values: { idemKey: "k" },
			idempotency: byKey("k", "replace"),
		});

		expect(reused).toBe(false);
		expect(row.id).not.toBe(oldId);
		expect(h.fixture.readJob(oldId)).toBeNull();
		expect(h.fixture.readAttempts(oldId)).toEqual([]);
		expect(h.fixture.readJob(row.id)).toMatchObject({ idemKey: "k" });
	});

	it("lets the kind release a key before it inserts", async () => {
		const oldId = h.fixture.seedJob({
			userId: h.userId,
			idemKey: "k",
			status: "failed",
		});

		const { row, reused } = await enqueue({
			values: { idemKey: "k" },
			idempotency: {
				find: byKey("k", "insert").find,
				// File production's `#superseded:` rename: free the key, then insert.
				onExisting: (tx, existing) => {
					tx.update(testJobs)
						.set({ idemKey: `${existing.idemKey}#superseded:${existing.id}` })
						.where(eq(testJobs.id, existing.id))
						.run();
					return "insert";
				},
			},
		});

		expect(reused).toBe(false);
		expect(h.fixture.readJob(oldId)?.idemKey).toBe(`k#superseded:${oldId}`);
		expect(h.fixture.readJob(row.id)?.idemKey).toBe("k");
	});

	it("makes one job of parallel enqueues with one key", async () => {
		const results = await Promise.all([
			enqueue({ values: { idemKey: "k" }, idempotency: byKey("k", "reuse") }),
			enqueue({ values: { idemKey: "k" }, idempotency: byKey("k", "reuse") }),
		]);

		expect(results.map((result) => result.reused).sort()).toEqual([
			false,
			true,
		]);
		expect(results[0].row.id).toBe(results[1].row.id);
		expect(
			h.fixture.sqlite.prepare("select count(*) as n from test_jobs").get(),
		).toEqual({ n: 1 });
	});

	it("reuses the winner when another connection inserted between find and insert", async () => {
		const winner = h.fixture.seedJob({ userId: h.userId, idemKey: "k" });
		let finds = 0;

		const { row, reused } = await enqueue({
			values: { idemKey: "k" },
			idempotency: {
				// The first look misses (the other connection had not committed yet);
				// the insert then meets the unique index; the second look finds it.
				find: (tx) => {
					finds += 1;
					return finds === 1 ? null : (byKey("k", "reuse").find(tx) ?? null);
				},
				onExisting: () => "reuse",
			},
		});

		expect(reused).toBe(true);
		expect(row.id).toBe(winner);
		expect(finds).toBe(2);
	});

	it("does not swallow a unique violation that has no winner", async () => {
		h.fixture.seedJob({ userId: h.userId, idemKey: "k" });

		await expect(
			enqueue({
				values: { idemKey: "k" },
				idempotency: { find: () => null, onExisting: () => "reuse" },
			}),
		).rejects.toThrow(/UNIQUE/);
	});
});

describe("claim", () => {
	it("opens an attempt and marks the job running", async () => {
		const { row } = await enqueue();

		const claimed = h.ledger.claimNext(h.control.kind, { workerId: "w1" });

		expect(claimed?.attempt.number).toBe(1);
		expect(claimed?.row).toMatchObject({
			id: row.id,
			status: "running",
			attemptCount: 1,
			currentAttemptId: claimed?.attempt.id,
			runAfter: null,
			errorCode: null,
		});
		expect(claimed?.row.startedAt).toBeInstanceOf(Date);
		const [attempt] = h.fixture.readAttempts(row.id);
		expect(attempt).toMatchObject({
			id: claimed?.attempt.id,
			attemptNumber: 1,
			status: "running",
			workerId: "w1",
		});
		expect(attempt.claimedAt).toBeInstanceOf(Date);
		expect(attempt.heartbeatAt).toBeInstanceOf(Date);
		expect(h.control.transitions).toEqual([
			{ jobId: row.id, to: "queued" },
			{ jobId: row.id, to: "running" },
		]);
	});

	it("clears the error a requeue kept, and keeps the first start", async () => {
		const startedAt = new Date(Date.now() - 3_600_000);
		const jobId = h.fixture.seedJob({
			userId: h.userId,
			attemptCount: 1,
			startedAt,
			errorCode: "boom",
			errorMessage: "It broke.",
			retryable: true,
			checkpoint: '{"cursor":4}',
		});
		h.fixture.seedAttempt({ jobId, attemptNumber: 1, status: "failed" });

		const claimed = h.ledger.claimNext(h.control.kind, { workerId: "w1" });

		expect(claimed?.attempt.number).toBe(2);
		expect(claimed?.row).toMatchObject({
			errorCode: null,
			errorMessage: null,
			retryable: false,
			// A requeue's checkpoint is what the next attempt resumes from.
			checkpoint: '{"cursor":4}',
		});
		expect(claimed?.row.startedAt?.getTime()).toBe(
			Math.floor(startedAt.getTime() / 1000) * 1000,
		);
	});

	it("starts an attempt at the first phase of the kind", async () => {
		const phased = createTestKind(h.engine.defineJobKind, {
			name: "phased",
			phases: ["upload", "parse"],
		});
		const { row } = await enqueue({}, h.engine, phased.kind);

		const claimed = h.ledger.claimNext(phased.kind, { workerId: "w1" });

		expect(claimed?.row.phase).toBe("upload");
		expect(h.fixture.readAttempts(row.id)[0].phase).toBe("upload");
	});

	it("rolls the whole claim back when the kind's transition hook throws", async () => {
		const { row } = await enqueue();
		h.control.transitionHook = () => {
			throw new Error("hook failed");
		};

		expect(() =>
			h.ledger.claimNext(h.control.kind, { workerId: "w1" }),
		).toThrow("hook failed");
		expect(h.fixture.readJob(row.id)?.status).toBe("queued");
		expect(h.fixture.readAttempts(row.id)).toEqual([]);
	});

	it("claims only the job it is asked for", async () => {
		const first = await enqueue();
		const second = await enqueue();

		const claimed = h.ledger.claimNext(h.control.kind, {
			workerId: "w1",
			jobId: second.row.id,
		});

		expect(claimed?.row.id).toBe(second.row.id);
		expect(h.fixture.readJob(first.row.id)?.status).toBe("queued");
	});

	it("claims past the caps when told to (an inline run)", async () => {
		h.control.config.global = 1;
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign" });
		const { row } = await enqueue();

		expect(h.ledger.claimNext(h.control.kind, { workerId: "w1" })).toBeNull();
		expect(
			h.ledger.claimNext(h.control.kind, {
				workerId: "w1",
				jobId: row.id,
				ignoreCaps: true,
			})?.row.id,
		).toBe(row.id);
	});

	it("never hands a running job to a second claimer, on this connection or another", async () => {
		const other = await h.bootSecondProcess();
		await enqueue();

		const first = h.ledger.claimNext(h.control.kind, { workerId: "w1" });
		const second = other.ledger.claimNext(other.control.kind, {
			workerId: "w2",
		});
		const third = h.ledger.claimNext(h.control.kind, { workerId: "w3" });

		expect(first).not.toBeNull();
		expect(second).toBeNull();
		expect(third).toBeNull();
		expect(
			h.fixture.sqlite
				.prepare("select count(*) as n from test_job_attempts")
				.get(),
		).toEqual({ n: 1 });
	});

	it("does not claim a job whose run time has not come", async () => {
		const { row } = await enqueue({ runAfter: new Date(Date.now() + 60_000) });

		await h.engine.drain(h.control.kind);
		expect(h.control.ran).toEqual([]);
		expect(h.fixture.readJob(row.id)?.status).toBe("queued");

		h.fixture.sqlite
			.prepare("update test_jobs set run_after = ? where id = ?")
			.run(Math.floor(Date.now() / 1000) - 5, row.id);
		await h.engine.drain(h.control.kind);
		expect(h.control.ran).toEqual([row.id]);
	});

	it("honours the kind's own claim condition", async () => {
		const labelled = createTestKind(h.engine.defineJobKind, {
			name: "labelled",
			claimable: (jobs) => sql`${jobs.label} is not null`,
		});
		const unlabelled = await enqueue({}, h.engine, labelled.kind);
		const withLabel = await enqueue(
			{ values: { label: "ready" } },
			h.engine,
			labelled.kind,
		);

		await h.engine.drain(labelled.kind);

		expect(labelled.ran).toEqual([withLabel.row.id]);
		expect(h.fixture.readJob(unlabelled.row.id)?.status).toBe("queued");
	});

	it("numbers an attempt from the attempts table, not from the count", async () => {
		// The old process can leave a count behind that disagrees with its rows;
		// the unique (job, number) index must never be what finds out.
		const jobId = h.fixture.seedJob({ userId: h.userId, attemptCount: 0 });
		h.fixture.seedAttempt({ jobId, attemptNumber: 3, status: "failed" });

		const claimed = h.ledger.claimNext(h.control.kind, { workerId: "w1" });

		expect(claimed?.attempt.number).toBe(4);
		expect(claimed?.row.attemptCount).toBe(4);
	});

	it("never lets the count go backwards", async () => {
		const jobId = h.fixture.seedJob({ userId: h.userId, attemptCount: 5 });

		const claimed = h.ledger.claimNext(h.control.kind, { workerId: "w1" });

		expect(claimed?.row.id).toBe(jobId);
		expect(claimed?.attempt.number).toBe(6);
		expect(claimed?.row.attemptCount).toBe(6);
	});
});

describe("the claim's order and caps", () => {
	it("runs jobs by priority, then by age", async () => {
		const slow = await enqueue({ priority: 10 });
		const fast = await enqueue({ priority: 0 });

		await h.engine.drain(h.control.kind);

		expect(h.control.ran).toEqual([fast.row.id, slow.row.id]);
	});

	it("runs jobs of one priority in the order they arrived, inside one second", async () => {
		// `created_at` has one-second resolution, so a burst ties on it. The tie
		// breaks on insertion order, not on the random id.
		const ids: string[] = [];
		for (let n = 0; n < 6; n += 1) ids.push((await enqueue()).row.id);

		await h.engine.drain(h.control.kind);

		expect(h.control.ran).toEqual(ids);
	});

	it("looks at one job per user, so a busy user does not starve another", async () => {
		const userB = h.fixture.seedUser("user-2");
		h.control.config.perUser = 1;
		// A already has a job running (another worker's), which is A's whole share.
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign" });
		for (let n = 0; n < 40; n += 1) await enqueue();
		const b = await h.engine.enqueue(h.control.kind, {
			values: { userId: userB },
		});

		await h.engine.drain(h.control.kind);

		// If the window were the oldest 32 ROWS, it would be all A's and B would
		// wait for A's backlog to drain below 32.
		expect(h.control.ran).toEqual([b.row.id]);
	});

	it("counts the running rows of other workers against the global cap", async () => {
		h.control.config.global = 2;
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign-1" });
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign-2" });
		const { row } = await enqueue();

		await h.engine.drain(h.control.kind);

		expect(h.control.ran).toEqual([]);
		expect(h.fixture.readJob(row.id)?.status).toBe("queued");
	});

	it("claims while a running row of another worker leaves room", async () => {
		h.control.config.global = 2;
		h.fixture.seedRunningJob({ userId: h.userId, workerId: "foreign-1" });
		const { row } = await enqueue();

		await h.engine.drain(h.control.kind);

		expect(h.control.ran).toEqual([row.id]);
	});

	it("counts the running rows of another connection against the per-user cap", async () => {
		const other = await h.bootSecondProcess();
		h.control.config.perUser = 1;
		other.control.config.perUser = 1;
		await enqueue();
		await enqueue();

		const first = other.ledger.claimNext(other.control.kind, {
			workerId: "w1",
		});
		const second = h.ledger.claimNext(h.control.kind, { workerId: "w2" });

		expect(first).not.toBeNull();
		expect(second).toBeNull();
	});

	it("takes no job while the kind is switched off", async () => {
		h.control.config.enabled = false;
		await enqueue();

		await h.engine.drain(h.control.kind);

		expect(h.control.ran).toEqual([]);
	});
});

describe("describeJob", () => {
	const row = (status: string, retryable = false) =>
		({ status, retryable }) as never;

	it("says a settled job is terminal and may not be cancelled", () => {
		for (const status of ["succeeded", "failed", "cancelled"]) {
			expect(h.engine.describeJob(h.control.kind, row(status))).toMatchObject({
				terminal: true,
				canCancel: false,
			});
		}
	});

	it("says a queued or running job may be cancelled", () => {
		for (const status of ["queued", "running"]) {
			expect(h.engine.describeJob(h.control.kind, row(status))).toEqual({
				terminal: false,
				canCancel: true,
				canRetry: false,
			});
		}
	});

	it("offers no retry to a kind that has no retry rule", () => {
		expect(
			h.engine.describeJob(h.control.kind, row("failed", true)).canRetry,
		).toBe(false);
	});

	it("offers a retry from the statuses the kind names", () => {
		h.control.definition.userRetry = { from: ["failed"] };
		const canRetry = (status: string) =>
			h.engine.describeJob(h.control.kind, row(status)).canRetry;

		expect(canRetry("failed")).toBe(true);
		expect(canRetry("cancelled")).toBe(false);
		expect(canRetry("succeeded")).toBe(false);
		expect(canRetry("running")).toBe(false);
		expect(canRetry("queued")).toBe(false);
	});

	it("offers a retry only to a retryable job when the kind requires it", () => {
		h.control.definition.userRetry = {
			from: ["failed", "cancelled"],
			requireRetryable: true,
		};
		const canRetry = (status: string, retryable: boolean) =>
			h.engine.describeJob(h.control.kind, row(status, retryable)).canRetry;

		expect(canRetry("failed", true)).toBe(true);
		expect(canRetry("failed", false)).toBe(false);
		expect(canRetry("cancelled", true)).toBe(true);
	});

	it("asks the kind's own rule too", () => {
		h.control.definition.userRetry = {
			from: ["failed"],
			allow: (candidate) => candidate.attemptCount < 3,
		};
		const canRetry = (attemptCount: number) =>
			h.engine.describeJob(h.control.kind, {
				status: "failed",
				retryable: true,
				attemptCount,
			} as never).canRetry;

		expect(canRetry(2)).toBe(true);
		expect(canRetry(3)).toBe(false);
	});
});
