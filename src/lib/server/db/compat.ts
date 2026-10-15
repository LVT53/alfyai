import type Database from "better-sqlite3";
import { sqlite } from "./index";

type TableInfoRow = {
	name: string;
};

let ensureRuntimeSchemaCompatibilityPromise: Promise<void> | null = null;
let runtimeSchemaCompatibilityEnsured = false;

function hasTable(database: Database.Database, tableName: string): boolean {
	return Boolean(
		database
			.prepare(
				"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
			)
			.get(tableName),
	);
}

function hasColumn(
	database: Database.Database,
	tableName: string,
	columnName: string,
): boolean {
	return database
		.prepare(`PRAGMA table_info(${JSON.stringify(tableName)})`)
		.all()
		.some((row) => String((row as TableInfoRow).name) === columnName);
}

function ensureUsersUiLanguageColumn(): void {
	if (!hasTable(sqlite, "users") || hasColumn(sqlite, "users", "ui_language")) {
		return;
	}

	sqlite.exec(
		"ALTER TABLE users ADD COLUMN ui_language text DEFAULT 'en' NOT NULL",
	);
	console.warn("[DB_COMPAT] Added missing users.ui_language column at runtime");
}

/**
 * The extraction ledger's vocabulary, as the job engine speaks it.
 *
 * Migration `1777140000115_extraction_jobs_on_engine` rewrote the ledger's
 * stored words once (docs/plans/jobs-merge, slice S3): the four active statuses
 * became `running` with the old word in `phase`, `canceled` became `cancelled`
 * on jobs and on attempts, and the outage counter moved out of `hints_json`
 * (`$outage`) into `retry_state_json`. `db:prepare` runs that migration while the
 * PREVIOUS release keeps serving and claiming for up to two minutes, and that
 * release writes the old words: it claims a job into `uploading`, cancels one into
 * `canceled`, and writes `$outage` back into the hints. This re-applies the same
 * statements, once, at every start and before the engine starts, so no process
 * ever claims, retries or reports on a row in a word the engine does not know.
 *
 * It is idempotent (a second run finds nothing to change), runs in one
 * transaction, and does nothing on a database the migration has not reached.
 * It also covers a rollback followed by a roll-forward: the rollback SQL puts the
 * old words back, and the first start of the new release rewrites them again.
 *
 * Differences from the migration, both about rows the old process touched after
 * it: when a row already has a retry state AND the old process wrote `$outage`
 * into its hints again (it starts a count of its own from the hints it reads, and
 * after the migration those held none), the two are added together, with the
 * earlier window kept, rather than the migrated state being overwritten.
 *
 * Returns how many rows it changed, for the log. Goes in the cleanup after
 * production has run this release (README: "Deployment").
 */
export function normalizeExtractionLifecycleWords(
	database: Database.Database = sqlite,
): number {
	if (
		!hasTable(database, "document_extraction_jobs") ||
		!hasColumn(database, "document_extraction_jobs", "phase") ||
		!hasColumn(database, "document_extraction_jobs", "retry_state_json")
	) {
		return 0;
	}

	const rewrite = database.transaction((): number => {
		let changed = 0;
		const run = (sql: string): void => {
			changed += database.prepare(sql).run().changes;
		};

		// The four active words become `running`; the word is the phase. Every
		// right-hand side is read before an assignment is made, so `phase` gets the
		// word the status had.
		run(
			"UPDATE document_extraction_jobs SET phase = status, status = 'running' WHERE status IN ('uploading', 'parsing', 'downloading', 'indexing')",
		);
		run(
			"UPDATE document_extraction_jobs SET status = 'cancelled' WHERE status = 'canceled'",
		);
		if (hasTable(database, "document_extraction_job_attempts")) {
			run(
				"UPDATE document_extraction_job_attempts SET status = 'cancelled' WHERE status = 'canceled'",
			);
		}
		// `$outage` leaves the hints. The guard is a CASE so that `json_type` is
		// never asked of text that is not JSON; hints that are not an object holding
		// an object under the key are left as they are (the old reader treated them
		// as "no outage state" too).
		run(`UPDATE document_extraction_jobs
			SET retry_state_json = CASE
					WHEN retry_state_json IS NOT NULL AND json_valid(retry_state_json)
						THEN json_object(
							'since', COALESCE(json_extract(retry_state_json, '$.since'), json_extract(hints_json, '$."$outage".since')),
							'waits', COALESCE(json_extract(retry_state_json, '$.waits'), 0) + COALESCE(json_extract(hints_json, '$."$outage".waits'), 0)
						)
					ELSE json_extract(hints_json, '$."$outage"')
				END,
				hints_json = CASE
					WHEN json_remove(hints_json, '$."$outage"') = '{}' THEN NULL
					ELSE json_remove(hints_json, '$."$outage"')
				END
			WHERE CASE
					WHEN hints_json IS NOT NULL AND json_valid(hints_json)
						THEN json_type(hints_json, '$."$outage"')
					ELSE NULL
				END = 'object'`);
		return changed;
	});

	const changed = rewrite();
	if (changed > 0) {
		console.warn(
			"[DB_COMPAT] Rewrote document extraction rows to the job engine's status words",
			{ rows: changed },
		);
	}
	return changed;
}

export async function ensureRuntimeSchemaCompatibility(): Promise<void> {
	if (runtimeSchemaCompatibilityEnsured) {
		return;
	}

	if (!ensureRuntimeSchemaCompatibilityPromise) {
		ensureRuntimeSchemaCompatibilityPromise = Promise.resolve().then(() => {
			ensureUsersUiLanguageColumn();
			normalizeExtractionLifecycleWords();
			runtimeSchemaCompatibilityEnsured = true;
		});
	}

	try {
		await ensureRuntimeSchemaCompatibilityPromise;
	} catch (error) {
		ensureRuntimeSchemaCompatibilityPromise = null;
		throw error;
	}
}
