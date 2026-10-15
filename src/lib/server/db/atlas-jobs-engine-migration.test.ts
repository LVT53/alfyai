import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
 * row has a job-level `worker_id` and no attempt at all. These tests build that
 * database by migrating to the entry before ours, seeding it with the old
 * release's own column set, and only then running the rest of the migrations.
 */

const ENGINE_TAG = "1777140000114_atlas_jobs_on_engine";

/** Every column the previous release's `atlas_jobs` had, in the order it listed them. */
const OLD_JOB_COLUMNS = [
	"id",
	"user_id",
	"conversation_id",
	"assistant_message_id",
	"action",
	"parent_atlas_job_id",
	"profile",
	"pipeline_version",
	"normalized_query_hash",
	"client_atlas_turn_id",
	"idempotency_key",
	"title",
	"status",
	"stage",
	"progress_percent",
	"progress_details_json",
	"worker_id",
	"heartbeat_at",
	"started_at",
	"completed_at",
	"cancel_requested_at",
	"input_tokens",
	"output_tokens",
	"total_tokens",
	"cost_usd_micros",
	"local_source_count",
	"web_source_count",
	"accepted_source_count",
	"rejected_source_count",
	"file_production_job_id",
	"html_chat_generated_file_id",
	"pdf_chat_generated_file_id",
	"markdown_chat_generated_file_id",
	"error_code",
	"error_message",
	"error_retryable",
	"failure_metadata_json",
	"created_at",
	"updated_at",
] as const;

/** The seven columns the migration adds, with what an existing row holds in each. */
const NEW_JOB_COLUMN_DEFAULTS = {
	current_attempt_id: null,
	attempt_count: 0,
	run_after: null,
	priority: 0,
	phase: null,
	checkpoint_json: null,
	retry_state_json: null,
} as const;

const T0 = 1_781_000_000;

describe("Atlas jobs on the engine migration", () => {
	let workDir: string;

	beforeAll(() => {
		workDir = mkdtempSync(join(tmpdir(), "alfyai-atlas-engine-"));
	});

	afterAll(() => {
		rmSync(workDir, { recursive: true, force: true });
	});

	/**
	 * The migrations folder as it stood the moment BEFORE this migration: every
	 * entry up to it and none after, so the second `migrate()` is a real upgrade
	 * step on a database the old release had been writing to (the same helper as
	 * `home-suggestion-events-drop-migration.test.ts`).
	 */
	function migrationsFolderBeforeEngine(): string {
		const folder = join(workDir, "drizzle-before");
		if (existsSync(folder)) return folder;

		const journal = JSON.parse(
			readFileSync("./drizzle/meta/_journal.json", "utf8"),
		) as { entries: Array<{ tag: string }> };
		const cutoff = journal.entries.findIndex(
			(entry) => entry.tag === ENGINE_TAG,
		);
		expect(
			cutoff,
			"the journal has no entry for the migration",
		).toBeGreaterThan(0);
		mkdirSync(join(folder, "meta"), { recursive: true });
		const kept = journal.entries.slice(0, cutoff);
		const keptTags = new Set(kept.map((entry) => entry.tag));
		writeFileSync(
			join(folder, "meta", "_journal.json"),
			JSON.stringify({ ...journal, entries: kept }),
		);
		for (const file of readdirSync("./drizzle")) {
			if (!file.endsWith(".sql")) continue;
			if (!keptTags.has(file.slice(0, -".sql".length))) continue;
			copyFileSync(join("./drizzle", file), join(folder, file));
		}
		return folder;
	}

	function openMigratedToBefore(name: string) {
		const sqlite = new Database(join(workDir, name));
		sqlite.pragma("foreign_keys = ON");
		const db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: migrationsFolderBeforeEngine() });
		return { sqlite, db };
	}

	function upgrade(sqlite: Database.Database): void {
		migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	}

	/** A user, a conversation and the two messages the seeded jobs hang from. */
	function seedWorld(sqlite: Database.Database): void {
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'atlas@example.com', 'hash')",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'Atlas', ?, ?)",
			)
			.run(T0, T0);
		for (const id of ["msg-queued", "msg-running", "msg-failed"]) {
			sqlite
				.prepare(
					"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, 'conv-1', 'assistant', 'Atlas is queued.', ?)",
				)
				.run(id, T0);
		}
	}

	/**
	 * A job row written with the previous release's column set and nothing else, so
	 * a column the migration added (and the old release has never heard of) holds
	 * only what the migration gave it.
	 */
	function insertOldJob(
		sqlite: Database.Database,
		values: Record<string, string | number | null>,
	): void {
		const row: Record<string, string | number | null> = {
			user_id: "user-1",
			conversation_id: "conv-1",
			action: "create",
			profile: "overview",
			pipeline_version: 3,
			normalized_query_hash: `hash-${values.id}`,
			client_atlas_turn_id: `turn-${values.id}`,
			idempotency_key: `atlas:v1:${values.id}`,
			title: `Atlas ${values.id}`,
			created_at: T0,
			updated_at: T0,
			...values,
		};
		const columns = Object.keys(row);
		sqlite
			.prepare(
				`INSERT INTO atlas_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			)
			.run(...columns.map((column) => row[column]));
	}

	function seedOldRows(sqlite: Database.Database): void {
		seedWorld(sqlite);
		insertOldJob(sqlite, {
			id: "job-queued",
			assistant_message_id: "msg-queued",
			status: "queued",
			stage: "queued",
		});
		insertOldJob(sqlite, {
			id: "job-running",
			assistant_message_id: "msg-running",
			status: "running",
			stage: "research",
			progress_percent: 40,
			progress_details_json: '{"queries":["enterprise retrieval patterns"]}',
			worker_id: "atlas:4242:7c6f1c3e-0000-4000-8000-000000000000",
			heartbeat_at: T0 + 30,
			started_at: T0 + 5,
			input_tokens: 11,
			output_tokens: 12,
			total_tokens: 23,
			updated_at: T0 + 30,
		});
		insertOldJob(sqlite, {
			id: "job-failed",
			assistant_message_id: "msg-failed",
			status: "failed",
			stage: "failed",
			started_at: T0 + 5,
			completed_at: T0 + 60,
			error_code: "atlas_pipeline_failed",
			error_message: "boom",
			error_retryable: 1,
			failure_metadata_json: '{"step":"write"}',
			updated_at: T0 + 60,
		});
	}

	function readJobs(sqlite: Database.Database) {
		return sqlite
			.prepare("SELECT * FROM atlas_jobs ORDER BY id")
			.all() as Array<Record<string, unknown>>;
	}

	it("keeps live Atlas rows: queued, running with its job-level worker id, and failed", () => {
		const { sqlite } = openMigratedToBefore("live-rows.db");
		try {
			seedOldRows(sqlite);
			const before = readJobs(sqlite);
			expect(before.map((row) => row.status)).toEqual([
				"failed",
				"queued",
				"running",
			]);
			// The precondition the whole test rests on: this database really is the
			// old release's, without the engine's columns.
			expect(Object.keys(before[0] ?? {}).sort()).toEqual(
				[...OLD_JOB_COLUMNS].sort(),
			);

			upgrade(sqlite);

			const after = readJobs(sqlite);
			expect(after).toHaveLength(3);
			for (const [index, row] of after.entries()) {
				const old = before[index] ?? {};
				// Every value the old release wrote is still there, byte for byte.
				for (const column of OLD_JOB_COLUMNS) {
					expect(row[column], `${row.id}.${column}`).toEqual(old[column]);
				}
				// And the engine's columns are at their defaults, so nothing the engine
				// reads has to be guessed.
				for (const [column, expected] of Object.entries(
					NEW_JOB_COLUMN_DEFAULTS,
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
				sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_job_attempts").get(),
			).toEqual({ n: 0 });
		} finally {
			sqlite.close();
		}
	});

	it("reads the migrated rows through the engine's table, `error_retryable` included", () => {
		const { sqlite } = openMigratedToBefore("drizzle-read.db");
		try {
			seedOldRows(sqlite);
			upgrade(sqlite);

			const rows = drizzle(sqlite, { schema })
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
			expect(failed?.startedAt).toEqual(new Date((T0 + 5) * 1000));
			expect(rows.find((row) => row.id === "job-queued")?.retryable).toBe(
				false,
			);
		} finally {
			sqlite.close();
		}
	});

	it("builds the live partial index, and the claim's status filter uses it", () => {
		const { sqlite } = openMigratedToBefore("live-index.db");
		try {
			seedOldRows(sqlite);
			upgrade(sqlite);

			const index = sqlite
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'atlas_jobs_live_claim_idx'",
				)
				.get() as { sql: string } | undefined;
			expect(index?.sql).toMatch(/\(`status`,`priority`,`created_at`\)/);
			expect(index?.sql).toMatch(
				/WHERE .*status.* = 'queued' or .*status.* = 'running'/i,
			);

			const plan = sqlite
				.prepare(
					"EXPLAIN QUERY PLAN SELECT id FROM atlas_jobs WHERE status = 'running'",
				)
				.all() as Array<{ detail: string }>;
			expect(plan.map((step) => step.detail).join("\n")).toContain(
				"atlas_jobs_live_claim_idx",
			);
		} finally {
			sqlite.close();
		}
	});

	it("creates the attempts table with the engine's columns and three indexes", () => {
		const { sqlite } = openMigratedToBefore("attempts-table.db");
		try {
			upgrade(sqlite);

			const columns = (
				sqlite.prepare("PRAGMA table_info(atlas_job_attempts)").all() as Array<{
					name: string;
					notnull: number;
					dflt_value: string | null;
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

			const indexes = sqlite
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
		} finally {
			sqlite.close();
		}
	});

	it("declares the same columns in the SQL and in schema.ts", () => {
		const { sqlite } = openMigratedToBefore("schema-drift.db");
		try {
			upgrade(sqlite);

			for (const [table, name] of [
				[schema.atlasJobs, "atlas_jobs"],
				[schema.atlasJobAttempts, "atlas_job_attempts"],
			] as const) {
				const declared = getTableConfig(table)
					.columns.map((column) => column.name)
					.sort();
				const actual = (
					sqlite.prepare(`PRAGMA table_info(${name})`).all() as Array<{
						name: string;
					}>
				)
					.map((column) => column.name)
					.sort();
				expect(declared, name).toEqual(actual);
			}
		} finally {
			sqlite.close();
		}
	});

	it("deletes an attempt with its job", () => {
		const { sqlite } = openMigratedToBefore("cascade.db");
		try {
			seedOldRows(sqlite);
			upgrade(sqlite);
			sqlite
				.prepare(
					"INSERT INTO atlas_job_attempts (id, job_id, attempt_number) VALUES ('attempt-1', 'job-running', 1)",
				)
				.run();

			sqlite.prepare("DELETE FROM atlas_jobs WHERE id = 'job-running'").run();

			expect(
				sqlite.prepare("SELECT COUNT(*) AS n FROM atlas_job_attempts").get(),
			).toEqual({ n: 0 });
		} finally {
			sqlite.close();
		}
	});

	it("lets the previous release's statements run against the migrated table (the two-minute window)", () => {
		const { sqlite } = openMigratedToBefore("old-process.db");
		try {
			seedOldRows(sqlite);
			upgrade(sqlite);

			// The old process keeps serving and claiming after `db:prepare`. Each
			// statement below is the shape its ledger ran, naming only the columns it
			// knew: a column the migration added without a default would fail the
			// insert, and one it renamed would fail every update.
			insertOldJob(sqlite, {
				id: "job-new-from-old-process",
				assistant_message_id: null,
				status: "queued",
				stage: "queued",
			});
			const changes = (sql: string, ...params: Array<string | number>) =>
				sqlite.prepare(sql).run(...params).changes;

			expect(
				changes(
					"UPDATE atlas_jobs SET status = 'running', pipeline_version = 3, stage = 'ask', progress_percent = 0, progress_details_json = '{}', worker_id = ?, heartbeat_at = ?, started_at = ?, error_code = NULL, error_message = NULL, error_retryable = 0, failure_metadata_json = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
					"atlas:1:old",
					T0 + 100,
					T0 + 100,
					T0 + 100,
					"job-queued",
				),
			).toBe(1);
			expect(
				changes(
					"UPDATE atlas_jobs SET heartbeat_at = ?, stage = ?, progress_percent = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
					T0 + 110,
					"search",
					20,
					T0 + 110,
					"job-queued",
					"atlas:1:old",
				),
			).toBe(1);
			expect(
				changes(
					"UPDATE atlas_jobs SET status = 'succeeded', stage = 'render', progress_percent = 100, worker_id = NULL, heartbeat_at = ?, completed_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND status = 'running'",
					T0 + 120,
					T0 + 120,
					T0 + 120,
					"job-queued",
					"atlas:1:old",
				),
			).toBe(1);
			expect(
				changes(
					"UPDATE atlas_jobs SET status = 'cancelled', stage = 'cancelled', cancel_requested_at = ?, completed_at = ?, worker_id = NULL, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')",
					T0 + 130,
					T0 + 130,
					T0 + 130,
					"job-running",
				),
			).toBe(1);

			// What the old process wrote reads back through the engine's table.
			const rows = drizzle(sqlite, { schema })
				.select()
				.from(schema.atlasJobs)
				.all();
			expect(rows.find((row) => row.id === "job-queued")?.status).toBe(
				"succeeded",
			);
			expect(rows.find((row) => row.id === "job-running")?.status).toBe(
				"cancelled",
			);
		} finally {
			sqlite.close();
		}
	});
});
