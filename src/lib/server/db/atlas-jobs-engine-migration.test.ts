import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	createPreEngineAtlasDatabase,
	ENGINE_ATLAS_JOB_COLUMN_DEFAULTS,
	PRE_ENGINE_ATLAS_JOB_COLUMNS,
	type PreEngineAtlasDatabase,
	SEED_EPOCH,
} from "../services/atlas/testing/pre-engine-database";
import * as schema from "./schema";

/**
 * Atlas moves onto the job engine (docs/plans/jobs-merge, slice S2) with ONE
 * expand-only migration: a new attempts table, seven columns on `atlas_jobs` and
 * the live partial index. Nothing is dropped or renamed, because a deploy runs
 * `db:prepare` while the previous release keeps serving and claiming for up to
 * two minutes.
 *
 * The database that matters is not a fresh one but the one the previous release
 * has been using: it holds queued, running and settled Atlas rows, and a running
 * row has a job-level `worker_id` and no attempt at all. The helper builds that
 * database by migrating to the entry before ours, seeding it with the old
 * release's own column set, and only then running the rest of the migrations.
 */

let database: PreEngineAtlasDatabase | null = null;

function openPreEngine(): PreEngineAtlasDatabase {
	database = createPreEngineAtlasDatabase();
	return database;
}

afterEach(() => {
	database?.cleanup();
	database = null;
});

describe("Atlas jobs on the engine migration", () => {
	it("keeps live Atlas rows: queued, running with its job-level worker id, and failed", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		const before = old.readJobs();
		expect(before.map((row) => row.status)).toEqual([
			"failed",
			"queued",
			"running",
		]);
		// The precondition the whole test rests on: this database really is the
		// old release's, without the engine's columns.
		expect(Object.keys(before[0] ?? {}).sort()).toEqual(
			[...PRE_ENGINE_ATLAS_JOB_COLUMNS].sort(),
		);

		old.upgrade();

		const after = old.readJobs();
		expect(after).toHaveLength(3);
		for (const [index, row] of after.entries()) {
			const previous = before[index] ?? {};
			// Every value the old release wrote is still there, byte for byte.
			for (const column of PRE_ENGINE_ATLAS_JOB_COLUMNS) {
				expect(row[column], `${row.id}.${column}`).toEqual(previous[column]);
			}
			// And the engine's columns are at their defaults, so nothing the engine
			// reads has to be guessed.
			for (const [column, expected] of Object.entries(
				ENGINE_ATLAS_JOB_COLUMN_DEFAULTS,
			)) {
				expect(row[column], `${row.id}.${column}`).toBe(expected);
			}
		}
		// The running row keeps its legacy fence columns and gains no attempt:
		// taking it back is the engine's job at the first boot.
		const running = after.find((row) => row.id === "job-running");
		expect(running?.worker_id).toBe(
			"atlas:4242:7c6f1c3e-0000-4000-8000-000000000000",
		);
		expect(
			old.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_job_attempts").get(),
		).toEqual({ n: 0 });
	});

	it("reads the migrated rows through the engine's table, `error_retryable` included", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		const rows = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.atlasJobs)
			.all();
		const failed = rows.find((row) => row.id === "job-failed");
		// `retryable` is the engine's property name for Atlas's `error_retryable`.
		expect(failed).toMatchObject({
			status: "failed",
			retryable: true,
			errorCode: "atlas_pipeline_failed",
			attemptCount: 0,
			priority: 0,
			currentAttemptId: null,
			phase: null,
			runAfter: null,
			checkpoint: null,
			retryState: null,
		});
		expect(failed?.startedAt).toEqual(new Date((SEED_EPOCH + 5) * 1000));
		expect(rows.find((row) => row.id === "job-queued")?.retryable).toBe(false);
	});

	it("builds the live partial index, and the claim's status filter uses it", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();

		const index = old.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'atlas_jobs_live_claim_idx'",
			)
			.get() as { sql: string } | undefined;
		expect(index?.sql).toMatch(/\(`status`,`priority`,`created_at`\)/);
		expect(index?.sql).toMatch(
			/WHERE .*status.* = 'queued' or .*status.* = 'running'/i,
		);

		const plan = old.sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM atlas_jobs WHERE status = 'running'",
			)
			.all() as Array<{ detail: string }>;
		expect(plan.map((step) => step.detail).join("\n")).toContain(
			"atlas_jobs_live_claim_idx",
		);
	});

	it("creates the attempts table with the engine's columns and three indexes", () => {
		const old = openPreEngine();
		old.upgrade();

		const columns = (
			old.sqlite
				.prepare("PRAGMA table_info(atlas_job_attempts)")
				.all() as Array<{
				name: string;
			}>
		).map((column) => column.name);
		expect(columns.sort()).toEqual(
			[
				"id",
				"job_id",
				"attempt_number",
				"status",
				"phase",
				"worker_id",
				"claimed_at",
				"heartbeat_at",
				"started_at",
				"finished_at",
				"error_code",
				"error_message",
				"retryable",
				"diagnostics_json",
				"created_at",
				"updated_at",
			].sort(),
		);

		const indexes = old.sqlite
			.prepare("PRAGMA index_list(atlas_job_attempts)")
			.all() as Array<{ name: string; unique: number }>;
		expect(indexes).toContainEqual(
			expect.objectContaining({
				name: "atlas_job_attempts_job_number_unique_idx",
				unique: 1,
			}),
		);
		expect(indexes.map((index) => index.name)).toEqual(
			expect.arrayContaining([
				"atlas_job_attempts_job_idx",
				"atlas_job_attempts_worker_idx",
			]),
		);
	});

	it("declares the same columns in the SQL and in schema.ts", () => {
		const old = openPreEngine();
		old.upgrade();

		for (const [table, name] of [
			[schema.atlasJobs, "atlas_jobs"],
			[schema.atlasJobAttempts, "atlas_job_attempts"],
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

	it("deletes an attempt with its job", () => {
		const old = openPreEngine();
		old.seedLiveRows();
		old.upgrade();
		old.sqlite
			.prepare(
				"INSERT INTO atlas_job_attempts (id, job_id, attempt_number) VALUES ('attempt-1', 'job-running', 1)",
			)
			.run();

		old.sqlite.prepare("DELETE FROM atlas_jobs WHERE id = 'job-running'").run();

		expect(
			old.sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_job_attempts").get(),
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
		old.insertJob({
			id: "job-new-from-old-process",
			assistant_message_id: null,
			status: "queued",
			stage: "queued",
		});
		const changes = (sql: string, ...params: Array<string | number>) =>
			old.sqlite.prepare(sql).run(...params).changes;
		const at = (seconds: number) => SEED_EPOCH + seconds;

		expect(
			changes(
				"UPDATE atlas_jobs SET status = 'running', pipeline_version = 3, stage = 'ask', progress_percent = 0, progress_details_json = '{}', worker_id = ?, heartbeat_at = ?, started_at = ?, error_code = NULL, error_message = NULL, error_retryable = 0, failure_metadata_json = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
				"atlas:1:old",
				at(100),
				at(100),
				at(100),
				"job-queued",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE atlas_jobs SET heartbeat_at = ?, stage = ?, progress_percent = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
				at(110),
				"search",
				20,
				at(110),
				"job-queued",
				"atlas:1:old",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE atlas_jobs SET status = 'succeeded', stage = 'render', progress_percent = 100, worker_id = NULL, heartbeat_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
				at(120),
				at(120),
				at(120),
				"job-queued",
				"atlas:1:old",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE atlas_jobs SET status = 'cancelled', stage = 'cancelled', cancel_requested_at = ?, completed_at = ?, worker_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')",
				at(130),
				at(130),
				at(130),
				"job-running",
			),
		).toBe(1);

		// What the old process wrote reads back through the engine's table.
		const rows = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.atlasJobs)
			.all();
		expect(rows.find((row) => row.id === "job-queued")?.status).toBe(
			"succeeded",
		);
		expect(rows.find((row) => row.id === "job-running")?.status).toBe(
			"cancelled",
		);
	});
});
