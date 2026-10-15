import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPreEngineExtractionDatabase,
	type PreEngineExtractionDatabase,
	SEED_EPOCH,
	SEED_HANDLE_JSON,
} from "../services/extraction/testing/pre-engine-database";

/**
 * The whole data path of the extraction slice, both ways, on one database
 * (docs/plans/jobs-merge, review R2): the previous release's rows, migration 115,
 * the startup shim, the REAL engine moving them through every state it can leave,
 * the process dying, then `rollback-extraction.sql`, and the previous release's
 * own reads and claims against what it finds.
 *
 * The migration test (`extraction-jobs-engine-migration.test.ts`) checks the
 * reverse SQL on rows written by hand to look like the engine's. This one lets the
 * engine write them, so a column the engine leaves in a state nobody thought of
 * is caught here and not on the box after an automatic rollback.
 */

/** Every status word the previous release's code knows. */
const OLD_JOB_WORDS = [
	"queued",
	"uploading",
	"parsing",
	"downloading",
	"indexing",
	"succeeded",
	"failed",
	"canceled",
];
const OLD_ACTIVE_WORDS = ["uploading", "parsing", "downloading", "indexing"];

let old: PreEngineExtractionDatabase | null = null;

afterEach(async () => {
	try {
		const { resetJobsForTests } = await import("$lib/server/services/jobs");
		resetJobsForTests();
	} catch {
		// The engine was never imported.
	}
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The DB module may not have been imported if a test failed early.
	}
	old?.cleanup();
	old = null;
});

describe("extraction rows, there and back", () => {
	it("leaves the previous release rows it can claim, reclaim, retry and read after the reverse SQL", async () => {
		old = createPreEngineExtractionDatabase();
		old.seedEveryOldWord();
		old.upgrade();
		// The restarted server opens its own connection, runs the shim, then the
		// engine.
		old.close();
		process.env.DATABASE_PATH = old.dbPath;
		vi.resetModules();
		const { sqlite } = await import("$lib/server/db");
		const { normalizeExtractionLifecycleWords } = await import("./compat");
		normalizeExtractionLifecycleWords(sqlite);

		const ledger = await import("$lib/server/services/jobs/ledger");
		const { takeBack } = await import("$lib/server/services/jobs/recovery");
		const { createWorkerId, parseWorkerId } = await import(
			"$lib/server/services/jobs/worker-identity"
		);
		const { cancelExtractionJob, extractionJob, retryExtractionJob } =
			await import("$lib/server/services/extraction/extraction-job");
		const { requeueExtractionJobForReextraction } = await import(
			"$lib/server/services/extraction/reextract"
		);
		const { readExtractionOutageState } = await import(
			"$lib/server/services/extraction/retry-policy"
		);
		const userId = "user-1";
		const workerId = createWorkerId("extraction");
		const claim = (jobId: string) => {
			const claimed = ledger.claimNext(extractionJob, {
				workerId,
				jobId,
				ignoreCaps: true,
			});
			if (!claimed) throw new Error(`could not claim ${jobId}`);
			return { jobId, attemptId: claimed.attempt.id, workerId };
		};
		const handle = JSON.parse(SEED_HANDLE_JSON) as unknown;

		// The boot: the four rows the old process was running are taken back.
		expect(
			takeBack(extractionJob, { reason: "stale", staleBefore: new Date() }),
		).toMatchObject({ recovered: 4, requeued: 4 });

		// An outage wait: claimed, a phase and a checkpoint, then the backend is
		// down. Requeued behind a backoff, its memory in `retry_state_json`.
		const waiting = claim("job-queued");
		expect(
			ledger.progress(extractionJob, waiting, {
				phase: "parsing",
				checkpoint: handle,
			}),
		).toBe("applied");
		expect(
			ledger.fail(extractionJob, waiting, {
				code: "unavailable",
				message: "The document service could not be reached.",
				retryable: true,
			}),
		).toMatchObject({ applied: true, requeued: true });

		// Retried by the user, claimed, mid-download when the process dies.
		expect(await retryExtractionJob({ userId, jobId: "job-failed" })).not.toBe(
			null,
		);
		const dying = claim("job-failed");
		expect(
			ledger.progress(extractionJob, dying, {
				phase: "downloading",
				checkpoint: handle,
			}),
		).toBe("applied");

		// Re-extracted and succeeded: the handler clears the hints, the engine keeps
		// the retry policy's memory.
		expect(
			await requeueExtractionJobForReextraction({
				userId,
				jobId: "job-succeeded",
				hints: { tier: "advanced", reextract: true },
			}),
		).toMatchObject({ ok: true });
		const succeeding = claim("job-succeeded");
		expect(
			ledger.succeed(extractionJob, succeeding, {
				apply: (tx) => {
					tx.run(
						`UPDATE document_extraction_jobs SET hints_json = NULL, normalized_artifact_id = 'norm-1' WHERE id = 'job-succeeded'`,
					);
				},
			}),
		).toBe(true);

		// Retried and cancelled while it runs; and one cancelled while it waits.
		expect(
			await retryExtractionJob({ userId, jobId: "job-canceled" }),
		).not.toBe(null);
		claim("job-canceled");
		expect(
			await cancelExtractionJob({ userId, jobId: "job-canceled" }),
		).toMatchObject({ status: "cancelled" });
		expect(
			await cancelExtractionJob({ userId, jobId: "job-uploading" }),
		).toMatchObject({ status: "cancelled" });

		// The process dies: its pid is gone. The deploy rolls back, the previous
		// release is stopped again, and the reverse SQL runs.
		const dead = workerId.replace(`:${process.pid}:`, ":999999:");
		sqlite
			.prepare(
				"UPDATE document_extraction_job_attempts SET worker_id = ? WHERE worker_id = ?",
			)
			.run(dead, workerId);
		sqlite.exec(
			readFileSync("docs/plans/jobs-merge/rollback-extraction.sql", "utf8"),
		);

		type JobRow = {
			id: string;
			status: string;
			attempt_count: number;
			current_attempt_id: string | null;
			remote_handle_json: string | null;
			hints_json: string | null;
			retry_state_json: string | null;
			next_attempt_at: number | null;
		};
		const jobs = new Map(
			(
				sqlite
					.prepare("SELECT * FROM document_extraction_jobs")
					.all() as JobRow[]
			).map((row) => [row.id, row] as const),
		);
		const attempts = sqlite
			.prepare(
				"SELECT id, job_id, attempt_number, status, worker_id FROM document_extraction_job_attempts ORDER BY job_id, attempt_number",
			)
			.all() as Array<{
			id: string;
			job_id: string;
			attempt_number: number;
			status: string;
			worker_id: string | null;
		}>;

		// Every word is one the previous release reads, and none of the engine's
		// own columns carry anything it would need.
		for (const row of jobs.values()) {
			expect(OLD_JOB_WORDS, row.id).toContain(row.status);
			expect(row.retry_state_json, row.id).toBeNull();
		}
		for (const attempt of attempts) {
			expect(["running", "succeeded", "failed", "canceled"]).toContain(
				attempt.status,
			);
		}

		// Its boot reclaim (job in an active word, pointing at a running attempt)
		// finds exactly the attempt the dead process held, under an id it reads as
		// this host and a pid that is gone, and resumes the stored handle.
		const reclaimable = sqlite
			.prepare(
				`SELECT j.id AS job_id, a.worker_id FROM document_extraction_job_attempts a
				 JOIN document_extraction_jobs j ON j.id = a.job_id
				 WHERE j.status IN (${OLD_ACTIVE_WORDS.map(() => "?").join(", ")})
				   AND j.current_attempt_id = a.id AND a.status = 'running'`,
			)
			.all(...OLD_ACTIVE_WORDS) as Array<{
			job_id: string;
			worker_id: string;
		}>;
		expect(reclaimable.map((row) => row.job_id)).toEqual(["job-failed"]);
		expect(parseWorkerId(reclaimable[0]?.worker_id)).toMatchObject({
			pid: 999999,
		});
		expect(jobs.get("job-failed")).toMatchObject({
			status: "downloading",
			remote_handle_json: SEED_HANDLE_JSON,
		});

		// Its claim: every queued row has no current attempt, and the attempt it
		// would number (`attempt_count + 1`) is free, so the unique index never fires.
		const queued = [...jobs.values()].filter((row) => row.status === "queued");
		expect(queued.map((row) => row.id).sort()).toEqual(
			["job-downloading", "job-indexing", "job-parsing", "job-queued"].sort(),
		);
		for (const row of queued) {
			expect(row.current_attempt_id, row.id).toBeNull();
			const taken = attempts
				.filter((attempt) => attempt.job_id === row.id)
				.map((attempt) => attempt.attempt_number);
			expect(taken, row.id).not.toContain(row.attempt_count + 1);
			// Still behind its backoff, in the unit the old gate compares.
			expect(row.next_attempt_at, row.id).toBeGreaterThan(SEED_EPOCH);
		}
		// The outage wait it reads where it always did, and resumes from the handle.
		expect(
			readExtractionOutageState(jobs.get("job-queued")?.hints_json),
		).toMatchObject({ waits: 1 });
		expect(
			JSON.parse(jobs.get("job-queued")?.hints_json ?? "{}"),
		).toMatchObject({ tier: "basic" });
		expect(jobs.get("job-queued")?.remote_handle_json).toBe(SEED_HANDLE_JSON);

		// Its Retry is legal from both settled words it knows, and its ceiling still
		// discounts the outage waits the job had before the deploy.
		expect(jobs.get("job-canceled")).toMatchObject({
			status: "canceled",
			current_attempt_id: null,
		});
		expect(jobs.get("job-uploading")?.status).toBe("canceled");
		// The attempt the previous release cancelled, and the engine's.
		expect(
			attempts
				.filter((attempt) => attempt.job_id === "job-canceled")
				.map((attempt) => [attempt.attempt_number, attempt.status]),
		).toEqual([
			[1, "canceled"],
			[2, "canceled"],
		]);
		expect(jobs.get("job-succeeded")).toMatchObject({
			status: "succeeded",
			current_attempt_id: null,
		});
		expect(
			readExtractionOutageState(jobs.get("job-succeeded")?.hints_json),
		).toEqual({ since: null, waits: 2 });
		expect(
			readExtractionOutageState(jobs.get("job-failed")?.hints_json).waits,
		).toBe(5);
	});
});
