// An Atlas database as the release BEFORE the job engine left it, upgraded the
// way a deploy upgrades it.
//
// Two tests need it: the migration test (`db/atlas-jobs-engine-migration.test.ts`:
// do the old rows survive, do the old release's statements still run) and the
// cutover test (`research-runner.test.ts`: a row that was `running` when the
// deploy landed is taken back, once, by the engine). Both are about a database
// that is NOT fresh, which `migrate()` over an empty file can never show, so the
// helper stops the migrations one entry before the engine's, seeds rows with the
// old release's own column set, and only then lets the rest run.

import {
	copyFileSync,
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

/** The journal entry of the migration that puts Atlas on the engine. */
export const ATLAS_ENGINE_MIGRATION_TAG = "1777140000114_atlas_jobs_on_engine";

/** Every column the previous release's `atlas_jobs` had. */
export const PRE_ENGINE_ATLAS_JOB_COLUMNS = [
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

/** The seven columns the migration adds, and what an existing row holds in each. */
export const ENGINE_ATLAS_JOB_COLUMN_DEFAULTS = {
	current_attempt_id: null,
	attempt_count: 0,
	run_after: null,
	priority: 0,
	phase: null,
	checkpoint_json: null,
	retry_state_json: null,
} as const;

/** Unix seconds the seeded rows are stamped with. */
export const SEED_EPOCH = 1_781_000_000;

export type SeedValue = string | number | null;

export interface PreEngineAtlasDatabase {
	dbPath: string;
	sqlite: Database.Database;
	/** A user, a conversation, and the assistant messages the live rows hang from. */
	seedWorld(): void;
	/** A job row written with the old column set and nothing else. */
	insertJob(values: Record<string, SeedValue>): void;
	/** `job-queued`, `job-running` (job-level worker id, no attempt) and `job-failed`. */
	seedLiveRows(): void;
	/** Runs the migrations the deploy would run: the engine's and anything after. */
	upgrade(): void;
	/** Every row of `atlas_jobs` as a plain object, ordered by id. */
	readJobs(): Array<Record<string, unknown>>;
	close(): void;
	cleanup(): void;
}

/**
 * A fresh database migrated to the entry before the engine's migration. The
 * caller owns it: `cleanup()` removes it. After `upgrade()` a test can `close()`
 * the helper's connection and point `DATABASE_PATH` at `dbPath`, so the app's own
 * connection finds the file as a deploy would.
 */
export function createPreEngineAtlasDatabase(): PreEngineAtlasDatabase {
	const workDir = mkdtempSync(join(tmpdir(), "alfyai-atlas-pre-engine-"));
	const before = join(workDir, "drizzle-before");

	const journal = JSON.parse(
		readFileSync("./drizzle/meta/_journal.json", "utf8"),
	) as { entries: Array<{ tag: string }> };
	const cutoff = journal.entries.findIndex(
		(entry) => entry.tag === ATLAS_ENGINE_MIGRATION_TAG,
	);
	if (cutoff <= 0) {
		rmSync(workDir, { recursive: true, force: true });
		throw new Error(
			`The journal has no entry ${ATLAS_ENGINE_MIGRATION_TAG}: the pre-engine database cannot be built.`,
		);
	}
	// Truncating the journal and copying only the SQL it still lists is what makes
	// the later `migrate()` a real upgrade step and not a replay.
	const kept = journal.entries.slice(0, cutoff);
	const keptTags = new Set(kept.map((entry) => entry.tag));
	mkdirSync(join(before, "meta"), { recursive: true });
	writeFileSync(
		join(before, "meta", "_journal.json"),
		JSON.stringify({ ...journal, entries: kept }),
	);
	for (const file of readdirSync("./drizzle")) {
		if (!file.endsWith(".sql")) continue;
		if (!keptTags.has(file.slice(0, -".sql".length))) continue;
		copyFileSync(join("./drizzle", file), join(before, file));
	}

	const dbPath = join(workDir, "pre-engine.db");
	const sqlite = new Database(dbPath);
	sqlite.pragma("journal_mode = WAL");
	sqlite.pragma("foreign_keys = ON");
	migrate(drizzle(sqlite), { migrationsFolder: before });

	const insertJob = (values: Record<string, SeedValue>): void => {
		const row: Record<string, SeedValue> = {
			user_id: "user-1",
			conversation_id: "conv-1",
			action: "create",
			profile: "overview",
			pipeline_version: 3,
			normalized_query_hash: `hash-${values.id}`,
			client_atlas_turn_id: `turn-${values.id}`,
			idempotency_key: `atlas:v1:${values.id}`,
			title: `Atlas ${values.id}`,
			created_at: SEED_EPOCH,
			updated_at: SEED_EPOCH,
			...values,
		};
		const columns = Object.keys(row);
		sqlite
			.prepare(
				`INSERT INTO atlas_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			)
			.run(...columns.map((column) => row[column]));
	};

	const seedWorld = (): void => {
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'atlas@example.com', 'hash')",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'Atlas', ?, ?)",
			)
			.run(SEED_EPOCH, SEED_EPOCH);
		for (const id of ["msg-queued", "msg-running", "msg-failed"]) {
			sqlite
				.prepare(
					"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, 'conv-1', 'assistant', 'Atlas is queued.', ?)",
				)
				.run(id, SEED_EPOCH);
		}
	};

	return {
		dbPath,
		sqlite,
		insertJob,
		seedWorld,
		seedLiveRows() {
			seedWorld();
			insertJob({
				id: "job-queued",
				assistant_message_id: "msg-queued",
				status: "queued",
				stage: "queued",
			});
			insertJob({
				id: "job-running",
				assistant_message_id: "msg-running",
				status: "running",
				stage: "research",
				progress_percent: 40,
				progress_details_json: '{"queries":["enterprise retrieval patterns"]}',
				worker_id: "atlas:4242:7c6f1c3e-0000-4000-8000-000000000000",
				heartbeat_at: SEED_EPOCH + 30,
				started_at: SEED_EPOCH + 5,
				input_tokens: 11,
				output_tokens: 12,
				total_tokens: 23,
				updated_at: SEED_EPOCH + 30,
			});
			insertJob({
				id: "job-failed",
				assistant_message_id: "msg-failed",
				status: "failed",
				stage: "failed",
				started_at: SEED_EPOCH + 5,
				completed_at: SEED_EPOCH + 60,
				error_code: "atlas_pipeline_failed",
				error_message: "boom",
				error_retryable: 1,
				failure_metadata_json: '{"step":"write"}',
				updated_at: SEED_EPOCH + 60,
			});
		},
		upgrade() {
			migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		},
		readJobs() {
			return sqlite
				.prepare("SELECT * FROM atlas_jobs ORDER BY id")
				.all() as Array<Record<string, unknown>>;
		},
		close() {
			try {
				sqlite.close();
			} catch {
				// Closed by the test already.
			}
		},
		cleanup() {
			try {
				sqlite.close();
			} catch {
				// Closed by the test already.
			}
			rmSync(workDir, { recursive: true, force: true });
		},
	};
}
