// A file-production database as the release BEFORE the job engine left it,
// upgraded the way a deploy upgrades it.
//
// Two tests need it: the migration test
// (`db/file-production-jobs-engine-migration.test.ts`: do the old rows survive, do
// the old release's statements still run in the deploy window) and the cutover
// test (`production-runner.test.ts`: a job that was `running` when the deploy
// landed is taken back, once, and the job behind it runs). Both are about a
// database that is NOT fresh, which `migrate()` over an empty file can never show,
// so the helper stops the migrations one entry before the engine's, seeds rows with
// the old release's own column set and words, and only then lets the rest run
// (`jobs/testing/pre-engine.ts` builds the file and writes the rows).

import type Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
	insertRow,
	migrateUpToBefore,
	removeDatabaseBeforeMigration,
	type SeedValue,
} from "../../jobs/testing/pre-engine";

/** The journal entry of the migration that puts file production on the engine. */
export const FILE_PRODUCTION_ENGINE_MIGRATION_TAG =
	"1777140000116_file_production_jobs_on_engine";

/** Every column the previous release's `file_production_jobs` had. */
export const PRE_ENGINE_FILE_PRODUCTION_JOB_COLUMNS = [
	"id",
	"conversation_id",
	"assistant_message_id",
	"user_id",
	"title",
	"status",
	"stage",
	"origin",
	"created_at",
	"updated_at",
	"current_attempt_id",
	"retryable",
	"error_code",
	"error_message",
	"completed_at",
	"cancel_requested_at",
	"idempotency_key",
	"request_json",
	"source_mode",
	"document_intent",
	"dismissed",
] as const;

/** The six columns the migration adds. */
export const ENGINE_FILE_PRODUCTION_JOB_NEW_COLUMNS = [
	"attempt_count",
	"run_after",
	"priority",
	"checkpoint_json",
	"retry_state_json",
	"started_at",
] as const;

/** Unix seconds the seeded rows are stamped with. */
export const SEED_EPOCH = 1_781_000_000;

/** The worker id of the process that was running when the deploy landed. */
export const OLD_PROCESS_WORKER_ID =
	"file-production:alfy-box:4242:7c6f1c3e-0000-4000-8000-000000000000";

/** What the succeeded job's second attempt kept as its warnings. */
export const SEED_WARNING = "Used a fallback font for one heading.";

export interface PreEngineFileProductionDatabase {
	dbPath: string;
	sqlite: Database.Database;
	/** A user, a conversation, a reply message and the produced file the succeeded job links. */
	seedWorld(): void;
	/** A job row written with the old column set and nothing else. */
	insertJob(values: Record<string, SeedValue>): void;
	/** An attempt row written the way the old ledger wrote it. */
	insertAttempt(values: Record<string, SeedValue>): void;
	/**
	 * One job in each state the previous release could leave: `job-succeeded` (two
	 * attempts, the second with warnings, one produced file), `job-failed` (two
	 * failed attempts, retryable), `job-cancelled` (dismissed), `job-queued` (no
	 * attempt) and `job-running` (its only attempt claimed by a process that is gone).
	 */
	seedLiveRows(): void;
	/** Runs the migrations the deploy would run: the engine's and anything after. */
	upgrade(): void;
	readJobs(): Array<Record<string, unknown>>;
	readAttempts(): Array<Record<string, unknown>>;
	close(): void;
	cleanup(): void;
}

/**
 * A fresh database migrated to the entry before the engine's migration. The
 * caller owns it: `cleanup()` removes it. After `upgrade()` a test can `close()`
 * the helper's connection and point `DATABASE_PATH` at `dbPath`, so the app's own
 * connection finds the file as a deploy would.
 */
export function createPreEngineFileProductionDatabase(): PreEngineFileProductionDatabase {
	const database = migrateUpToBefore(
		FILE_PRODUCTION_ENGINE_MIGRATION_TAG,
		"alfyai-file-production-pre-engine-",
	);
	const { sqlite, dbPath } = database;

	const insertJob = (values: Record<string, SeedValue>): void => {
		insertRow(sqlite, "file_production_jobs", {
			conversation_id: "conv-1",
			assistant_message_id: "msg-1",
			user_id: "user-1",
			title: `Report ${values.id}`,
			origin: "unified_produce",
			request_json: JSON.stringify({
				sourceMode: "program",
				program: {
					language: "python",
					sourceCode: "print('hi')",
					filename: "out.txt",
				},
				outputs: [{ type: "txt" }],
			}),
			source_mode: "program",
			created_at: SEED_EPOCH,
			updated_at: SEED_EPOCH,
			...values,
		});
	};

	const insertAttempt = (values: Record<string, SeedValue>): void => {
		insertRow(sqlite, "file_production_job_attempts", {
			attempt_number: 1,
			status: "running",
			claimed_at: SEED_EPOCH,
			heartbeat_at: SEED_EPOCH,
			started_at: SEED_EPOCH,
			retryable: 0,
			created_at: SEED_EPOCH,
			updated_at: SEED_EPOCH,
			...values,
		});
	};

	const seedWorld = (): void => {
		sqlite
			.prepare(
				"INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'file-production@example.com', 'hash')",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'Reports', ?, ?)",
			)
			.run(SEED_EPOCH, SEED_EPOCH);
		sqlite
			.prepare(
				"INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES ('msg-1', 'conv-1', 'assistant', 'Here is the file.', ?)",
			)
			.run(SEED_EPOCH);
		insertRow(sqlite, "chat_generated_files", {
			id: "file-1",
			conversation_id: "conv-1",
			assistant_message_id: "msg-1",
			user_id: "user-1",
			filename: "out.txt",
			mime_type: "text/plain",
			size_bytes: 12,
			storage_path: "conv-1/file-1.txt",
			created_at: SEED_EPOCH,
		});
	};

	return {
		dbPath,
		sqlite,
		insertJob,
		insertAttempt,
		seedWorld,
		seedLiveRows() {
			seedWorld();

			// Succeeded on the second attempt, with a warning kept on that attempt's
			// diagnostics and one produced file.
			insertJob({
				id: "job-succeeded",
				status: "succeeded",
				current_attempt_id: "att-succeeded-2",
				completed_at: SEED_EPOCH + 90,
				updated_at: SEED_EPOCH + 90,
			});
			insertAttempt({
				id: "att-succeeded-1",
				job_id: "job-succeeded",
				attempt_number: 1,
				status: "failed",
				worker_id: OLD_PROCESS_WORKER_ID,
				claimed_at: SEED_EPOCH + 10,
				heartbeat_at: SEED_EPOCH + 10,
				started_at: SEED_EPOCH + 10,
				finished_at: SEED_EPOCH + 20,
				error_code: "program_execution_failed",
				error_message: "boom",
				retryable: 1,
			});
			insertAttempt({
				id: "att-succeeded-2",
				job_id: "job-succeeded",
				attempt_number: 2,
				status: "succeeded",
				worker_id: OLD_PROCESS_WORKER_ID,
				claimed_at: SEED_EPOCH + 60,
				heartbeat_at: SEED_EPOCH + 80,
				started_at: SEED_EPOCH + 60,
				finished_at: SEED_EPOCH + 90,
				diagnostics_json: JSON.stringify({ warnings: [SEED_WARNING] }),
			});
			insertRow(sqlite, "file_production_job_files", {
				id: "link-1",
				job_id: "job-succeeded",
				chat_generated_file_id: "file-1",
				sort_order: 0,
				created_at: SEED_EPOCH + 90,
			});

			// Failed twice; the second failure left it retryable.
			insertJob({
				id: "job-failed",
				status: "failed",
				current_attempt_id: "att-failed-2",
				retryable: 1,
				error_code: "sandbox_timeout",
				error_message: "Execution timed out",
				completed_at: SEED_EPOCH + 130,
				updated_at: SEED_EPOCH + 130,
			});
			for (const number of [1, 2]) {
				insertAttempt({
					id: `att-failed-${number}`,
					job_id: "job-failed",
					attempt_number: number,
					status: "failed",
					worker_id: OLD_PROCESS_WORKER_ID,
					claimed_at: SEED_EPOCH + 100 * number,
					heartbeat_at: SEED_EPOCH + 100 * number,
					started_at: SEED_EPOCH + 100 * number,
					finished_at: SEED_EPOCH + 100 * number + 30,
					error_code: "sandbox_timeout",
					error_message: "Execution timed out",
					retryable: 1,
				});
			}

			// Cancelled, and the person pressed Dismiss on the card.
			insertJob({
				id: "job-cancelled",
				status: "cancelled",
				dismissed: 1,
				cancel_requested_at: SEED_EPOCH + 140,
				completed_at: SEED_EPOCH + 140,
				updated_at: SEED_EPOCH + 140,
			});

			// Waiting for the single slot.
			insertJob({ id: "job-queued", status: "queued" });

			// Running when the deploy landed: its only attempt belongs to a process that
			// was on this host and is gone.
			insertJob({
				id: "job-running",
				status: "running",
				current_attempt_id: "att-running-1",
				updated_at: SEED_EPOCH + 150,
			});
			insertAttempt({
				id: "att-running-1",
				job_id: "job-running",
				attempt_number: 1,
				status: "running",
				worker_id: OLD_PROCESS_WORKER_ID,
				claimed_at: SEED_EPOCH + 150,
				heartbeat_at: SEED_EPOCH + 160,
				started_at: SEED_EPOCH + 150,
			});
		},
		upgrade() {
			migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		},
		readJobs() {
			return sqlite
				.prepare("SELECT * FROM file_production_jobs ORDER BY id")
				.all() as Array<Record<string, unknown>>;
		},
		readAttempts() {
			return sqlite
				.prepare("SELECT * FROM file_production_job_attempts ORDER BY id")
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
			removeDatabaseBeforeMigration(database);
		},
	};
}
