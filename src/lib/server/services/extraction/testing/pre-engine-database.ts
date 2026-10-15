// An extraction database as the release BEFORE the job engine left it, upgraded
// the way a deploy upgrades it.
//
// Three tests need it: the migration test (`db/extraction-jobs-engine-migration.test.ts`:
// does every old status word come out as the engine's, does the old release's
// statement set still run in the deploy window, does the reverse SQL put it all
// back), the cutover test (`extraction-runner.test.ts`: a job that was
// `parsing` when the deploy landed is taken back, once, and resumed) and the
// shim's own test. All three are about a database that is NOT fresh, which
// `migrate()` over an empty file can never show, so the helper stops the
// migrations one entry before the engine's, seeds rows with the old release's own
// column set and words, and only then lets the rest run.

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

/** The journal entry of the migration that puts extraction on the engine. */
export const EXTRACTION_ENGINE_MIGRATION_TAG =
	"1777140000115_extraction_jobs_on_engine";

/** Every column the previous release's `document_extraction_jobs` had. */
export const PRE_ENGINE_EXTRACTION_JOB_COLUMNS = [
	"id",
	"user_id",
	"conversation_id",
	"source_artifact_id",
	"chat_generated_file_id",
	"normalized_artifact_id",
	"origin",
	"intake_route",
	"priority",
	"file_name",
	"mime_type",
	"size_bytes",
	"status",
	"attempt_count",
	"current_attempt_id",
	"remote_handle_json",
	"hints_json",
	"requested_by",
	"retryable",
	"error_code",
	"error_message",
	"next_attempt_at",
	"cancel_requested_at",
	"started_at",
	"completed_at",
	"created_at",
	"updated_at",
] as const;

/** The two columns the migration adds, and what an existing row holds in each. */
export const ENGINE_EXTRACTION_JOB_COLUMN_DEFAULTS = {
	phase: null,
	retry_state_json: null,
} as const;

/** Unix seconds the seeded rows are stamped with. */
export const SEED_EPOCH = 1_781_000_000;

/** The handle an `uploading`-to-`indexing` row carries. */
export const SEED_HANDLE_JSON = JSON.stringify({
	extractor: "mineru4",
	version: 1,
	remoteJobId: "remote-1",
	remoteFileId: null,
});

/** The worker id of a process that was running when the deploy landed. */
export const OLD_PROCESS_WORKER_ID =
	"extraction:alfy-box:4242:7c6f1c3e-0000-4000-8000-000000000000";

export type SeedValue = string | number | null;

export interface PreEngineExtractionDatabase {
	dbPath: string;
	sqlite: Database.Database;
	/** A user, a conversation and the source artifacts the jobs hang from. */
	seedWorld(): void;
	/** A job row written with the old column set and nothing else. */
	insertJob(values: Record<string, SeedValue>): void;
	/** An attempt row written the way the old ledger wrote it. */
	insertAttempt(values: Record<string, SeedValue>): void;
	/**
	 * One job in each of the 8 old statuses (`queued`, `uploading`, `parsing`,
	 * `downloading`, `indexing`, `succeeded`, `failed`, `canceled`), each with the
	 * attempt the old ledger would have left it with, and hints with and without
	 * the reserved `$outage` key.
	 */
	seedEveryOldWord(): void;
	/** Hints no one would write by hand: unreadable JSON, an array, a non-object `$outage`. */
	seedOddHints(): void;
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
export function createPreEngineExtractionDatabase(): PreEngineExtractionDatabase {
	const workDir = mkdtempSync(join(tmpdir(), "alfyai-extraction-pre-engine-"));
	const before = join(workDir, "drizzle-before");

	const journal = JSON.parse(
		readFileSync("./drizzle/meta/_journal.json", "utf8"),
	) as { entries: Array<{ tag: string }> };
	const cutoff = journal.entries.findIndex(
		(entry) => entry.tag === EXTRACTION_ENGINE_MIGRATION_TAG,
	);
	if (cutoff <= 0) {
		rmSync(workDir, { recursive: true, force: true });
		throw new Error(
			`The journal has no entry ${EXTRACTION_ENGINE_MIGRATION_TAG}: the pre-engine database cannot be built.`,
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

	const insertRow = (
		table: string,
		row: Record<string, SeedValue>,
		verb = "INSERT",
	): void => {
		const columns = Object.keys(row);
		sqlite
			.prepare(
				`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
			)
			.run(...columns.map((column) => row[column]));
	};

	/** The source artifact a job hangs from (and the normalized one a success points at). */
	const insertArtifact = (id: string, type: string): void => {
		insertRow(
			"artifacts",
			{
				id,
				user_id: "user-1",
				type,
				name: `${id}.pdf`,
				mime_type: "application/pdf",
				size_bytes: 1024,
				created_at: SEED_EPOCH,
				updated_at: SEED_EPOCH,
			},
			"INSERT OR IGNORE",
		);
	};

	const insertJob = (values: Record<string, SeedValue>): void => {
		const sourceArtifactId = String(
			values.source_artifact_id ?? `art-${values.id}`,
		);
		insertArtifact(sourceArtifactId, "source_document");
		insertRow("document_extraction_jobs", {
			user_id: "user-1",
			conversation_id: null,
			source_artifact_id: sourceArtifactId,
			origin: "upload",
			intake_route: "mineru",
			priority: 0,
			file_name: `${values.id}.pdf`,
			mime_type: "application/pdf",
			size_bytes: 1024,
			created_at: SEED_EPOCH,
			updated_at: SEED_EPOCH,
			...values,
		});
	};

	const insertAttempt = (values: Record<string, SeedValue>): void => {
		insertRow("document_extraction_job_attempts", {
			attempt_number: 1,
			status: "running",
			resumed: 0,
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
				"INSERT INTO users (id, email, password_hash) VALUES ('user-1', 'extraction@example.com', 'hash')",
			)
			.run();
		sqlite
			.prepare(
				"INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES ('conv-1', 'user-1', 'Uploads', ?, ?)",
			)
			.run(SEED_EPOCH, SEED_EPOCH);
	};

	return {
		dbPath,
		sqlite,
		insertJob,
		insertAttempt,
		seedWorld,
		seedEveryOldWord() {
			seedWorld();
			insertArtifact("norm-1", "normalized_document");

			// Waiting out an outage: queued behind a backoff gate, error kept so the
			// card can say it is retrying, hints carrying a caller key.
			insertJob({
				id: "job-queued",
				status: "queued",
				attempt_count: 2,
				hints_json: JSON.stringify({ tier: "basic" }),
				retryable: 1,
				error_code: "unavailable",
				error_message: "The document service could not be reached.",
				next_attempt_at: SEED_EPOCH + 600,
				started_at: SEED_EPOCH,
				updated_at: SEED_EPOCH + 5,
			});
			insertAttempt({
				id: "att-queued-1",
				job_id: "job-queued",
				attempt_number: 1,
				status: "failed",
				phase: "uploading",
				extractor: "mineru4",
				worker_id: OLD_PROCESS_WORKER_ID,
				finished_at: SEED_EPOCH + 5,
				error_code: "unavailable",
				error_message: "The document service could not be reached.",
				retryable: 1,
			});

			// The four active words. Each owns a `running` attempt of the process
			// that was running when the deploy landed, and a stored handle.
			for (const phase of [
				"uploading",
				"parsing",
				"downloading",
				"indexing",
			] as const) {
				insertJob({
					id: `job-${phase}`,
					status: phase,
					attempt_count: 1,
					current_attempt_id: `att-${phase}-1`,
					remote_handle_json: SEED_HANDLE_JSON,
					started_at: SEED_EPOCH,
					updated_at: SEED_EPOCH + 30,
				});
				insertAttempt({
					id: `att-${phase}-1`,
					job_id: `job-${phase}`,
					status: "running",
					phase,
					extractor: "mineru4",
					remote_handle_json: SEED_HANDLE_JSON,
					worker_id: OLD_PROCESS_WORKER_ID,
					heartbeat_at: SEED_EPOCH + 30,
				});
			}

			// Succeeded after waiting out an outage: `waits` is the only record that
			// two of its attempts were the backend's fault, and it is the ONLY key in
			// the hints, so the column is empty once it moves.
			insertJob({
				id: "job-succeeded",
				normalized_artifact_id: "norm-1",
				status: "succeeded",
				attempt_count: 3,
				hints_json: JSON.stringify({ $outage: { since: null, waits: 2 } }),
				started_at: SEED_EPOCH,
				completed_at: SEED_EPOCH + 90,
				updated_at: SEED_EPOCH + 90,
			});
			insertAttempt({
				id: "att-succeeded-3",
				job_id: "job-succeeded",
				attempt_number: 3,
				status: "succeeded",
				phase: "indexing",
				extractor: "mineru4",
				finished_at: SEED_EPOCH + 90,
				text_length: 4096,
				page_count: 7,
				diagnostics_json: '{"chunksTruncated":true}',
			});

			// Failed for good, with the outage window still open and a caller key.
			insertJob({
				id: "job-failed",
				status: "failed",
				attempt_count: 5,
				hints_json: JSON.stringify({
					tier: "advanced",
					$outage: { since: SEED_EPOCH * 1000, waits: 5 },
				}),
				retryable: 1,
				error_code: "unavailable",
				error_message: "The document service could not be reached.",
				started_at: SEED_EPOCH,
				completed_at: SEED_EPOCH + 120,
				updated_at: SEED_EPOCH + 120,
			});
			insertAttempt({
				id: "att-failed-5",
				job_id: "job-failed",
				attempt_number: 5,
				status: "failed",
				phase: "parsing",
				extractor: "mineru4",
				finished_at: SEED_EPOCH + 120,
				error_code: "unavailable",
				error_message: "The document service could not be reached.",
				retryable: 1,
			});

			// Cancelled by the user: the old spelling, on the job and on its attempt.
			insertJob({
				id: "job-canceled",
				status: "canceled",
				attempt_count: 1,
				cancel_requested_at: SEED_EPOCH + 40,
				started_at: SEED_EPOCH,
				completed_at: SEED_EPOCH + 40,
				updated_at: SEED_EPOCH + 40,
			});
			insertAttempt({
				id: "att-canceled-1",
				job_id: "job-canceled",
				status: "canceled",
				phase: "parsing",
				extractor: "mineru4",
				finished_at: SEED_EPOCH + 40,
				error_code: "canceled",
				error_message: "Canceled by the user.",
			});
		},
		seedOddHints() {
			insertJob({
				id: "job-unreadable",
				status: "failed",
				hints_json: '{"tier": "advanced", "$outage": {',
			});
			insertJob({
				id: "job-array",
				status: "failed",
				hints_json: "[1,2,3]",
			});
			insertJob({
				id: "job-scalar-outage",
				status: "failed",
				hints_json: '{"tier":"basic","$outage":5}',
			});
		},
		upgrade() {
			migrate(drizzle(sqlite), { migrationsFolder: "./drizzle" });
		},
		readJobs() {
			return sqlite
				.prepare("SELECT * FROM document_extraction_jobs ORDER BY id")
				.all() as Array<Record<string, unknown>>;
		},
		readAttempts() {
			return sqlite
				.prepare("SELECT * FROM document_extraction_job_attempts ORDER BY id")
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
