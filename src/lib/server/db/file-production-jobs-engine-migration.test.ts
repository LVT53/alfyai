import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPreEngineFileProductionDatabase,
	ENGINE_FILE_PRODUCTION_JOB_NEW_COLUMNS,
	OLD_PROCESS_WORKER_ID,
	PRE_ENGINE_FILE_PRODUCTION_JOB_COLUMNS,
	type PreEngineFileProductionDatabase,
	SEED_EPOCH,
	SEED_WARNING,
} from "../services/file-production/testing/pre-engine-database";
import { parseFileProductionAttemptWarnings } from "../services/file-production/types";
import * as schema from "./schema";

/**
 * File production moves onto the job engine (docs/plans/jobs-merge, slice S4)
 * with ONE expand-only migration: six columns on `file_production_jobs` and the
 * live partial index widened to the engine's three columns. Nothing is dropped
 * or renamed, because a deploy runs `db:prepare` while the previous release keeps
 * serving and claiming for up to two minutes. The attempts table already carried
 * every column the engine reads, so it is not touched.
 *
 * The database that matters is not a fresh one but the one the previous release
 * has been using: it holds queued, running and settled jobs, a succeeded job
 * keeps its warnings on an attempt's diagnostics, and a running job belongs to a
 * process that may be gone. The helper builds that database by migrating to the
 * entry before ours, seeding it with the old release's own column set, and only
 * then running the rest of the migrations.
 */

let database: PreEngineFileProductionDatabase | null = null;

function openPreEngine(): PreEngineFileProductionDatabase {
	database = createPreEngineFileProductionDatabase();
	return database;
}

afterEach(() => {
	database?.cleanup();
	database = null;
});

describe("File-production jobs on the engine migration", () => {
	it("keeps live file-production rows: succeeded with files and warnings, failed, cancelled, queued and running", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		const before = old.readJobs();
		expect(before.map((row) => row.id)).toEqual([
			"job-cancelled",
			"job-failed",
			"job-queued",
			"job-running",
			"job-succeeded",
		]);
		// The precondition the whole test rests on: this database really is the old
		// release's, without the engine's columns.
		expect(Object.keys(before[0] ?? {}).sort()).toEqual(
			[...PRE_ENGINE_FILE_PRODUCTION_JOB_COLUMNS].sort(),
		);

		old.upgrade();

		const after = old.readJobs();
		expect(after).toHaveLength(5);
		for (const [index, row] of after.entries()) {
			const previous = before[index] ?? {};
			// Every value the old release wrote is still there, byte for byte.
			for (const column of PRE_ENGINE_FILE_PRODUCTION_JOB_COLUMNS) {
				expect(row[column], `${row.id}.${column}`).toEqual(previous[column]);
			}
			// And the new columns are all there.
			for (const column of ENGINE_FILE_PRODUCTION_JOB_NEW_COLUMNS) {
				expect(column in row, `${row.id}.${column}`).toBe(true);
			}
		}
		// The files a succeeded job produced are still linked to it.
		expect(
			old.sqlite.prepare("SELECT job_id FROM file_production_job_files").all(),
		).toEqual([{ job_id: "job-succeeded" }]);
		// The running job keeps its dead worker's attempt: taking it back is the
		// engine's job at the first boot, not the migration's.
		expect(
			old.sqlite
				.prepare(
					"SELECT status, worker_id FROM file_production_job_attempts WHERE job_id = 'job-running'",
				)
				.all(),
		).toEqual([{ status: "running", worker_id: OLD_PROCESS_WORKER_ID }]);
	});

	it("backfills attempt_count from the highest attempt number and started_at from the first attempt", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		const byId = new Map(old.readJobs().map((row) => [row.id as string, row]));
		// The count is the highest attempt number the job has: the engine numbers the
		// next attempt one past it, so a count the old release never kept cannot make
		// the next claim collide with the unique (job, number) index.
		expect(byId.get("job-succeeded")).toMatchObject({
			attempt_count: 2,
			// The FIRST attempt's start, not the successful one's.
			started_at: SEED_EPOCH + 10,
		});
		expect(byId.get("job-failed")).toMatchObject({
			attempt_count: 2,
			started_at: SEED_EPOCH + 100,
		});
		expect(byId.get("job-running")).toMatchObject({
			attempt_count: 1,
			started_at: SEED_EPOCH + 150,
		});
		// A job that never ran has nothing to count and no start.
		for (const id of ["job-queued", "job-cancelled"]) {
			expect(byId.get(id), id).toMatchObject({
				attempt_count: 0,
				started_at: null,
			});
		}
		// The rest are the engine's defaults.
		for (const row of byId.values()) {
			expect(row, String(row.id)).toMatchObject({
				run_after: null,
				priority: 0,
				checkpoint_json: null,
				retry_state_json: null,
			});
		}
	});

	it("reads the migrated rows through the engine's table, `stage` included", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		const rows = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.fileProductionJobs)
			.all();
		const failed = rows.find((row) => row.id === "job-failed");
		expect(failed).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "sandbox_timeout",
			attemptCount: 2,
			priority: 0,
			currentAttemptId: "att-failed-2",
			phase: null,
			runAfter: null,
			checkpoint: null,
			retryState: null,
			dismissed: false,
		});
		expect(failed?.startedAt).toEqual(new Date((SEED_EPOCH + 100) * 1000));
		expect(rows.find((row) => row.id === "job-cancelled")?.dismissed).toBe(
			true,
		);
	});

	it("reads a succeeded job's warnings through current_attempt_id, as the read model does", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		const db = drizzle(old.sqlite, { schema });
		const job = db
			.select()
			.from(schema.fileProductionJobs)
			.all()
			.find((row) => row.id === "job-succeeded");
		expect(job?.currentAttemptId).toBe("att-succeeded-2");
		const attempt = db
			.select()
			.from(schema.fileProductionJobAttempts)
			.all()
			.find((row) => row.id === job?.currentAttemptId);
		expect(
			parseFileProductionAttemptWarnings(attempt?.diagnosticsJson),
		).toEqual([SEED_WARNING]);
		// And the attempt's `stage` column is the engine's `phase` property.
		expect(attempt).toMatchObject({ phase: null, status: "succeeded" });
	});

	it("widens the live partial index to (status, priority, created_at) under its old name, and the claim's filter uses it", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		const wasIndex = old.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'file_production_jobs_live_claim_idx'",
			)
			.get() as { sql: string };
		expect(wasIndex.sql).toMatch(/\(`status`,`created_at`\)/);

		old.upgrade();

		const indexes = old.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'file_production_jobs_live_claim_idx'",
			)
			.all() as Array<{ sql: string }>;
		expect(indexes).toHaveLength(1);
		expect(indexes[0]?.sql).toMatch(/\(`status`,`priority`,`created_at`\)/);
		expect(indexes[0]?.sql).toMatch(
			/WHERE .*status.* = 'queued' or .*status.* = 'running'/i,
		);

		const plan = old.sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM file_production_jobs WHERE status = 'running'",
			)
			.all() as Array<{ detail: string }>;
		expect(plan.map((step) => step.detail).join("\n")).toContain(
			"file_production_jobs_live_claim_idx",
		);
	});

	it("migrates a database whose live index was already dropped by hand", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.sqlite.prepare("DROP INDEX file_production_jobs_live_claim_idx").run();

		old.upgrade();

		const index = old.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'file_production_jobs_live_claim_idx'",
			)
			.get() as { sql: string } | undefined;
		expect(index?.sql).toMatch(/\(`status`,`priority`,`created_at`\)/);
		expect(old.readJobs()).toHaveLength(5);
	});

	it("declares the same columns in the SQL and in schema.ts", () => {
		const old = openPreEngine();
		old.upgrade();

		for (const [table, name] of [
			[schema.fileProductionJobs, "file_production_jobs"],
			[schema.fileProductionJobAttempts, "file_production_job_attempts"],
		] as const) {
			const declared = getTableConfig(table)
				.columns.map((column) => column.name)
				.sort();
			const actual = (
				old.sqlite.prepare(`PRAGMA table_info(${name})`).all() as Array<{
					name: string;
				}>
			)
				.map((column) => column.name)
				.sort();
			expect(declared, name).toEqual(actual);
		}
	});

	it("keeps the cascade: an attempt and a file link go with their job", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		old.sqlite
			.prepare("DELETE FROM file_production_jobs WHERE id = 'job-succeeded'")
			.run();

		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM file_production_job_attempts WHERE job_id = 'job-succeeded'",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			old.sqlite
				.prepare("SELECT COUNT(*) AS n FROM file_production_job_files")
				.get(),
		).toEqual({ n: 0 });
	});

	it("lets the previous release's statements run against the migrated table (the two-minute window)", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		// The old process keeps serving and claiming after `db:prepare`. Each
		// statement below is the shape its ledger ran, naming only the columns it
		// knew: a column the migration added without a default would fail the
		// insert, and one it renamed would fail every update.
		const changes = (sql: string, ...params: Array<string | number | null>) =>
			old.sqlite.prepare(sql).run(...params).changes;
		const at = (seconds: number) => SEED_EPOCH + seconds;

		// A job the old intake makes.
		expect(
			changes(
				"INSERT INTO file_production_jobs (id, conversation_id, assistant_message_id, user_id, title, status, stage, origin, current_attempt_id, retryable, error_code, error_message, completed_at, cancel_requested_at, idempotency_key, request_json, source_mode, document_intent, created_at, updated_at) VALUES (?, 'conv-1', 'msg-1', 'user-1', 'From the old process', 'queued', NULL, 'unified_produce', NULL, 0, NULL, NULL, NULL, NULL, 'key-old', '{}', 'program', NULL, ?, ?)",
				"job-from-old-process",
				at(200),
				at(200),
			),
		).toBe(1);
		// Its claim: an attempt row, then the job.
		expect(
			changes(
				"INSERT INTO file_production_job_attempts (id, job_id, attempt_number, status, stage, worker_id, claimed_at, heartbeat_at, started_at, finished_at, error_code, error_message, retryable, created_at, updated_at) VALUES ('att-old-1', ?, 1, 'running', NULL, 'file-production:old-host:1:old', ?, ?, ?, NULL, NULL, NULL, 0, ?, ?)",
				"job-from-old-process",
				at(210),
				at(210),
				at(210),
				at(210),
				at(210),
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE file_production_jobs SET status = 'running', current_attempt_id = 'att-old-1', retryable = 0, error_code = NULL, error_message = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
				at(210),
				"job-from-old-process",
			),
		).toBe(1);
		// Its heartbeat, then its completion.
		expect(
			changes(
				"UPDATE file_production_job_attempts SET heartbeat_at = ?, updated_at = ? WHERE id = 'att-old-1' AND job_id = ? AND worker_id = 'file-production:old-host:1:old' AND status = 'running'",
				at(225),
				at(225),
				"job-from-old-process",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE file_production_job_attempts SET status = 'succeeded', finished_at = ?, updated_at = ? WHERE id = 'att-old-1'",
				at(230),
				at(230),
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE file_production_jobs SET status = 'succeeded', stage = NULL, retryable = 0, error_code = NULL, error_message = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
				at(230),
				at(230),
				"job-from-old-process",
			),
		).toBe(1);
		// Its retry of the failed job, a cancel of the queued one, and a dismiss.
		expect(
			changes(
				"UPDATE file_production_jobs SET status = 'queued', stage = NULL, current_attempt_id = NULL, retryable = 0, error_code = NULL, error_message = NULL, completed_at = NULL, cancel_requested_at = NULL, updated_at = ? WHERE id = ? AND status = 'failed' AND retryable = 1",
				at(240),
				"job-failed",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE file_production_jobs SET status = 'cancelled', stage = NULL, retryable = 0, completed_at = ?, cancel_requested_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')",
				at(250),
				at(250),
				at(250),
				"job-queued",
			),
		).toBe(1);

		// What the old process wrote reads back through the engine's table.
		const rows = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.fileProductionJobs)
			.all();
		expect(rows.find((row) => row.id === "job-from-old-process")).toMatchObject(
			{ status: "succeeded", attemptCount: 0, priority: 0 },
		);
		expect(rows.find((row) => row.id === "job-failed")?.status).toBe("queued");
		expect(rows.find((row) => row.id === "job-queued")?.status).toBe(
			"cancelled",
		);
	});
});
