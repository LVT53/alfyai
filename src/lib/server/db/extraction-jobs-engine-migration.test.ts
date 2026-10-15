import { readFileSync } from "node:fs";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPreEngineExtractionDatabase,
	ENGINE_EXTRACTION_JOB_COLUMN_DEFAULTS,
	OLD_PROCESS_WORKER_ID,
	PRE_ENGINE_EXTRACTION_JOB_COLUMNS,
	type PreEngineExtractionDatabase,
	SEED_EPOCH,
	SEED_HANDLE_JSON,
} from "../services/extraction/testing/pre-engine-database";
import * as schema from "./schema";

// `compat.ts` opens the app's database when it is imported. The shim takes the
// connection it works on as an argument, so this test hands it the helper's own
// and the module's singleton is never touched.
vi.mock("./index", () => ({ sqlite: undefined }));

/**
 * Document extraction moves onto the job engine (docs/plans/jobs-merge, slice
 * S3) with ONE migration, and it is the one data rewrite of the whole run: the
 * engine speaks five status words and the ledger spoke eight. Active rows
 * (`uploading`, `parsing`, `downloading`, `indexing`) become `running` with the
 * old word in the new `phase` column, `canceled` becomes `cancelled` on jobs
 * and attempts, and the outage counter that rode inside `hints_json` as the
 * reserved `$outage` key moves to `retry_state_json`. Everything else is
 * expand-only (two columns and an index), because a deploy runs `db:prepare`
 * while the previous release keeps serving and claiming for up to two minutes.
 *
 * The database that matters is not a fresh one but the one the previous release
 * has been using: rows in every old word, attempts that are `running` under a
 * worker id of a process that will be gone, and `$outage` counters with and
 * without a caller's own hints beside them.
 */

let database: PreEngineExtractionDatabase | null = null;

function openPreEngine(): PreEngineExtractionDatabase {
	database = createPreEngineExtractionDatabase();
	return database;
}

afterEach(() => {
	database?.cleanup();
	database = null;
});

const ACTIVE_WORDS = ["uploading", "parsing", "downloading", "indexing"];

function byId<T extends Record<string, unknown>>(rows: T[]): Map<string, T> {
	return new Map(rows.map((row) => [String(row.id), row]));
}

function parseJson(value: unknown): unknown {
	return typeof value === "string" ? JSON.parse(value) : value;
}

async function shim() {
	const compat = await import("./compat");
	return compat.normalizeExtractionLifecycleWords;
}

describe("extraction jobs on the engine migration", () => {
	it("rewrites rows in every old word, and nothing else about them", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		const before = byId(old.readJobs());
		const attemptsBefore = byId(old.readAttempts());
		expect([...before.values()].map((row) => row.status).sort()).toEqual(
			[
				"canceled",
				"downloading",
				"failed",
				"indexing",
				"parsing",
				"queued",
				"succeeded",
				"uploading",
			].sort(),
		);
		// The precondition the whole test rests on: this database really is the
		// old release's, without the engine's columns.
		expect(Object.keys([...before.values()][0] ?? {}).sort()).toEqual(
			[...PRE_ENGINE_EXTRACTION_JOB_COLUMNS].sort(),
		);

		old.upgrade();

		const after = byId(old.readJobs());
		expect(after.size).toBe(8);
		for (const [id, row] of after) {
			const previous = before.get(id) ?? {};
			// Every column the old release wrote is still there, byte for byte,
			// except the three the migration rewrites.
			for (const column of PRE_ENGINE_EXTRACTION_JOB_COLUMNS) {
				if (column === "status" || column === "hints_json") continue;
				expect(row[column], `${id}.${column}`).toEqual(previous[column]);
			}
		}

		// The four active words become `running`, the word moves to `phase`.
		for (const word of ACTIVE_WORDS) {
			expect(after.get(`job-${word}`), word).toMatchObject({
				status: "running",
				phase: word,
				// The stored handle is the engine's checkpoint (same column).
				remote_handle_json: SEED_HANDLE_JSON,
				current_attempt_id: `att-${word}-1`,
			});
		}
		// Every other row has no phase, and the other words are untouched except
		// the one-l spelling.
		expect(after.get("job-queued")).toMatchObject({
			status: "queued",
			phase: null,
			next_attempt_at: SEED_EPOCH + 600,
		});
		expect(after.get("job-succeeded")).toMatchObject({
			status: "succeeded",
			phase: null,
		});
		expect(after.get("job-failed")).toMatchObject({
			status: "failed",
			phase: null,
		});
		expect(after.get("job-canceled")).toMatchObject({
			status: "cancelled",
			phase: null,
			cancel_requested_at: SEED_EPOCH + 40,
		});

		// The attempts keep every value, and the one cancelled attempt takes the
		// engine's spelling. Their `phase` already used the same four words.
		const attemptsAfter = byId(old.readAttempts());
		expect(attemptsAfter.size).toBe(attemptsBefore.size);
		for (const [id, row] of attemptsAfter) {
			const previous = attemptsBefore.get(id) ?? {};
			for (const [column, value] of Object.entries(previous)) {
				if (column === "status") continue;
				expect(row[column], `${id}.${column}`).toEqual(value);
			}
			expect(row.status, id).toBe(
				previous.status === "canceled" ? "cancelled" : previous.status,
			);
		}
		expect(attemptsAfter.get("att-canceled-1")).toMatchObject({
			status: "cancelled",
			// A historical string: nothing reads it, and the engine writes its own.
			error_code: "canceled",
		});
		// Nothing else about the rows the old words covered is missing.
		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM document_extraction_jobs WHERE status IN ('uploading','parsing','downloading','indexing','canceled')",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM document_extraction_job_attempts WHERE status = 'canceled'",
				)
				.get(),
		).toEqual({ n: 0 });
	});

	it("moves the reserved $outage key out of hints_json into retry_state_json", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		const after = byId(old.readJobs());

		// The only key in the hints: the column is empty once it moves.
		expect(after.get("job-succeeded")?.hints_json).toBeNull();
		expect(parseJson(after.get("job-succeeded")?.retry_state_json)).toEqual({
			since: null,
			waits: 2,
		});

		// A caller's own key stays, and only that.
		expect(parseJson(after.get("job-failed")?.hints_json)).toEqual({
			tier: "advanced",
		});
		expect(parseJson(after.get("job-failed")?.retry_state_json)).toEqual({
			since: SEED_EPOCH * 1000,
			waits: 5,
		});

		// A row without the reserved key is not touched at all.
		expect(after.get("job-queued")?.hints_json).toBe('{"tier":"basic"}');
		expect(after.get("job-queued")?.retry_state_json).toBeNull();
		for (const [column, expected] of Object.entries(
			ENGINE_EXTRACTION_JOB_COLUMN_DEFAULTS,
		)) {
			expect(after.get("job-canceled")?.[column], column).toBe(expected);
		}
	});

	it("leaves hints it cannot read as they are", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.seedOddHints();
		old.upgrade();
		const after = byId(old.readJobs());

		// Unreadable JSON, an array, and a `$outage` that is not an object: the
		// old reader treated all three as "no outage state", and so does the
		// rewrite (it moves what it can read and leaves the rest alone).
		expect(after.get("job-unreadable")).toMatchObject({
			hints_json: '{"tier": "advanced", "$outage": {',
			retry_state_json: null,
		});
		expect(after.get("job-array")).toMatchObject({
			hints_json: "[1,2,3]",
			retry_state_json: null,
		});
		expect(after.get("job-scalar-outage")).toMatchObject({
			hints_json: '{"tier":"basic","$outage":5}',
			retry_state_json: null,
		});
	});

	it("reads the migrated rows through the engine's table, with the legacy SQL names", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();

		const rows = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.documentExtractionJobs)
			.all();
		const queued = rows.find((row) => row.id === "job-queued");
		// `runAfter` is the engine's name for `next_attempt_at`.
		expect(queued).toMatchObject({
			status: "queued",
			retryable: true,
			errorCode: "unavailable",
			attemptCount: 2,
			priority: 0,
			phase: null,
			retryState: null,
		});
		expect(queued?.runAfter).toEqual(new Date((SEED_EPOCH + 600) * 1000));
		// `checkpoint` is the engine's name for `remote_handle_json`.
		expect(rows.find((row) => row.id === "job-parsing")).toMatchObject({
			status: "running",
			phase: "parsing",
			checkpoint: SEED_HANDLE_JSON,
		});
		expect(rows.find((row) => row.id === "job-canceled")?.status).toBe(
			"cancelled",
		);
		const attempts = drizzle(old.sqlite, { schema })
			.select()
			.from(schema.documentExtractionJobAttempts)
			.all();
		// The kind's own attempt columns are still there and still typed.
		expect(attempts.find((row) => row.id === "att-succeeded-3")).toMatchObject({
			status: "succeeded",
			extractor: "mineru4",
			resumed: false,
			textLength: 4096,
			pageCount: 7,
		});
	});

	it("builds the live partial index, and the claim's status filter uses it", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();

		const index = old.sqlite
			.prepare(
				"SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'document_extraction_jobs_live_claim_idx'",
			)
			.get() as { sql: string } | undefined;
		expect(index?.sql).toMatch(/\(`status`,`priority`,`created_at`\)/);
		expect(index?.sql).toMatch(
			/WHERE .*status.* = 'queued' or .*status.* = 'running'/i,
		);
		// The previous release's index stays until the cleanup: its claim reads it.
		expect(
			old.sqlite
				.prepare(
					"SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'document_extraction_jobs_claim_idx'",
				)
				.get(),
		).toEqual({ present: 1 });

		// Both indexes can serve the engine's status filter, and the planner is
		// free to pick the older, larger one until the cleanup drops it. What must
		// hold is that the live one CAN: `INDEXED BY` fails the statement outright
		// when SQLite cannot prove the query's terms imply the index's own.
		const plan = old.sqlite
			.prepare(
				"EXPLAIN QUERY PLAN SELECT id FROM document_extraction_jobs INDEXED BY document_extraction_jobs_live_claim_idx WHERE status = 'running'",
			)
			.all() as Array<{ detail: string }>;
		expect(plan.map((step) => step.detail).join("\n")).toContain(
			"document_extraction_jobs_live_claim_idx",
		);
	});

	it("declares the same columns in the SQL and in schema.ts", () => {
		const old = openPreEngine();
		old.upgrade();

		for (const [table, name] of [
			[schema.documentExtractionJobs, "document_extraction_jobs"],
			[
				schema.documentExtractionJobAttempts,
				"document_extraction_job_attempts",
			],
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

	it("runs the previous release's statements against the migrated tables (the two-minute window)", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();

		// The old process keeps serving and claiming after `db:prepare`. Each
		// statement below is the shape its ledger ran, naming only the columns it
		// knew: a column the migration added without a default would fail the
		// insert, and one it renamed would fail every update.
		old.insertJob({
			id: "job-from-old-process",
			status: "queued",
		});
		const changes = (sql: string, ...params: Array<string | number | null>) =>
			old.sqlite.prepare(sql).run(...params).changes;
		const at = (seconds: number) => SEED_EPOCH + seconds;

		// The claim.
		expect(
			changes(
				"UPDATE document_extraction_jobs SET status = 'uploading', current_attempt_id = ?, attempt_count = ?, started_at = ?, retryable = 0, error_code = NULL, error_message = NULL, next_attempt_at = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
				"att-late-1",
				1,
				at(100),
				at(100),
				"job-from-old-process",
			),
		).toBe(1);
		expect(
			changes(
				"INSERT INTO document_extraction_job_attempts (id, job_id, attempt_number, status, phase, extractor, resumed, remote_handle_json, worker_id, claimed_at, heartbeat_at, started_at, finished_at, error_code, error_message, retryable, text_length, page_count, diagnostics_json, created_at, updated_at) VALUES (?, ?, 1, 'running', 'uploading', NULL, 0, NULL, ?, ?, ?, ?, NULL, NULL, NULL, 0, NULL, NULL, NULL, ?, ?)",
				"att-late-1",
				"job-from-old-process",
				OLD_PROCESS_WORKER_ID,
				at(100),
				at(100),
				at(100),
				at(100),
				at(100),
			),
		).toBe(1);
		// A progress report.
		expect(
			changes(
				"UPDATE document_extraction_jobs SET status = 'parsing', remote_handle_json = ?, updated_at = ? WHERE id = ? AND status = 'uploading' AND current_attempt_id = ?",
				SEED_HANDLE_JSON,
				at(110),
				"job-from-old-process",
				"att-late-1",
			),
		).toBe(1);
		// The user cancels a job the engine's migration made `running`.
		expect(
			changes(
				"UPDATE document_extraction_jobs SET status = 'canceled', cancel_requested_at = ?, completed_at = ?, current_attempt_id = NULL, retryable = 0, next_attempt_at = NULL, remote_handle_json = NULL, updated_at = ? WHERE id = ? AND status = ?",
				at(120),
				at(120),
				at(120),
				"job-indexing",
				"running",
			),
		).toBe(1);
		expect(
			changes(
				"UPDATE document_extraction_job_attempts SET status = 'canceled', finished_at = ?, error_code = 'canceled', error_message = 'Canceled by the user.', retryable = 0, updated_at = ? WHERE id = ? AND status = 'running'",
				at(120),
				at(120),
				"att-indexing-1",
			),
		).toBe(1);
		// A failure that waits out an outage, rewriting the whole hints column.
		expect(
			changes(
				"UPDATE document_extraction_jobs SET status = 'queued', current_attempt_id = NULL, error_code = 'unavailable', error_message = 'The document service could not be reached.', retryable = 1, next_attempt_at = ?, completed_at = NULL, hints_json = ?, updated_at = ? WHERE id = ? AND current_attempt_id = ?",
				at(900),
				JSON.stringify({
					tier: "basic",
					$outage: { since: at(130) * 1000, waits: 1 },
				}),
				at(130),
				"job-parsing",
				"att-parsing-1",
			),
		).toBe(1);

		// What the old process wrote reads back, in its words, until the shim runs.
		const rows = byId(old.readJobs());
		expect(rows.get("job-from-old-process")?.status).toBe("parsing");
		expect(rows.get("job-indexing")?.status).toBe("canceled");
	});

	it("the shim rewrites the words the old process wrote after the migration (the deploy window)", async () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		const normalize = await shim();

		// The old process in its last two minutes: it claims a job, moves it
		// through two phases, cancels another job and the attempt it had, and puts
		// a third behind a backoff after an outage, rewriting its hints.
		const run = (sql: string, ...params: Array<string | number | null>) =>
			old.sqlite.prepare(sql).run(...params);
		old.insertJob({ id: "job-from-old-process", status: "queued" });
		run(
			"UPDATE document_extraction_jobs SET status = 'downloading', current_attempt_id = 'att-late-1', attempt_count = 1 WHERE id = 'job-from-old-process'",
		);
		run(
			"UPDATE document_extraction_jobs SET status = 'canceled', current_attempt_id = NULL WHERE id = 'job-indexing'",
		);
		run(
			"UPDATE document_extraction_job_attempts SET status = 'canceled' WHERE id = 'att-indexing-1'",
		);
		run(
			"UPDATE document_extraction_jobs SET status = 'queued', hints_json = ? WHERE id = 'job-parsing'",
			JSON.stringify({
				tier: "basic",
				$outage: { since: (SEED_EPOCH + 130) * 1000, waits: 1 },
			}),
		);

		normalize(old.sqlite);

		const rows = byId(old.readJobs());
		expect(rows.get("job-from-old-process")).toMatchObject({
			status: "running",
			phase: "downloading",
		});
		expect(rows.get("job-indexing")?.status).toBe("cancelled");
		expect(byId(old.readAttempts()).get("att-indexing-1")?.status).toBe(
			"cancelled",
		);
		expect(parseJson(rows.get("job-parsing")?.hints_json)).toEqual({
			tier: "basic",
		});
		expect(parseJson(rows.get("job-parsing")?.retry_state_json)).toEqual({
			since: (SEED_EPOCH + 130) * 1000,
			waits: 1,
		});
		// And no old word is left anywhere.
		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM document_extraction_jobs WHERE status IN ('uploading','parsing','downloading','indexing','canceled')",
				)
				.get(),
		).toEqual({ n: 0 });
	});

	it("the shim adds the old process's outage waits to the ones the migration moved", async () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		const normalize = await shim();
		// After the migration `job-failed` holds { since: T0, waits: 5 } in
		// retry_state_json and a hints column with no $outage. The old process does
		// not know that column: it starts a count of its own from the hints it
		// reads, and writes it back as the reserved key.
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET hints_json = ? WHERE id = 'job-failed'",
			)
			.run(
				JSON.stringify({
					tier: "advanced",
					$outage: { since: (SEED_EPOCH + 500) * 1000, waits: 2 },
				}),
			);

		normalize(old.sqlite);

		const failed = byId(old.readJobs()).get("job-failed");
		expect(parseJson(failed?.hints_json)).toEqual({ tier: "advanced" });
		// The window the run began with stays (it is the earlier), the waits add up.
		expect(parseJson(failed?.retry_state_json)).toEqual({
			since: SEED_EPOCH * 1000,
			waits: 7,
		});
	});

	it("the shim is idempotent, and does nothing on a database the migration has not reached", async () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		const normalize = await shim();

		normalize(old.sqlite);
		const once = JSON.stringify([old.readJobs(), old.readAttempts()]);
		normalize(old.sqlite);
		normalize(old.sqlite);
		expect(JSON.stringify([old.readJobs(), old.readAttempts()])).toBe(once);
		// ...and it left the migration's own result as it was.
		expect(byId(old.readJobs()).get("job-parsing")).toMatchObject({
			status: "running",
			phase: "parsing",
		});

		// A database the migration has not reached has no `phase` column to write.
		const unmigrated = createPreEngineExtractionDatabase();
		try {
			unmigrated.seedEveryOldWord();
			const before = JSON.stringify(unmigrated.readJobs());
			expect(() => normalize(unmigrated.sqlite)).not.toThrow();
			expect(JSON.stringify(unmigrated.readJobs())).toBe(before);
		} finally {
			unmigrated.cleanup();
		}
	});

	it("the reverse SQL restores the old words and $outage, applying the rollback file to the migrated rows", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.seedOddHints();
		const jobsBefore = byId(old.readJobs());
		const attemptsBefore = byId(old.readAttempts());
		old.upgrade();

		// What the engine itself leaves behind, before the code is rolled back: a
		// settled job that still names its last attempt, a `cancelled` attempt of
		// its own spelling, and a running job with a phase and a checkpoint.
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET current_attempt_id = 'att-failed-5' WHERE id = 'job-failed'",
			)
			.run();

		old.sqlite.exec(
			readFileSync("docs/plans/jobs-merge/rollback-extraction.sql", "utf8"),
		);

		const jobsAfter = byId(old.readJobs());
		expect(jobsAfter.size).toBe(jobsBefore.size);
		for (const [id, row] of jobsAfter) {
			const previous = jobsBefore.get(id) ?? {};
			for (const column of PRE_ENGINE_EXTRACTION_JOB_COLUMNS) {
				if (column === "hints_json") {
					// Compared as JSON where it is JSON: key order is not a promise.
					expect(parseJsonOrText(row[column]), `${id}.${column}`).toEqual(
						parseJsonOrText(previous[column]),
					);
					continue;
				}
				expect(row[column], `${id}.${column}`).toEqual(previous[column]);
			}
			// The engine's own columns are gone from the old code's view of the row.
			expect(row.retry_state_json, id).toBeNull();
		}
		const attemptsAfter = byId(old.readAttempts());
		for (const [id, row] of attemptsAfter) {
			const previous = attemptsBefore.get(id) ?? {};
			for (const [column, value] of Object.entries(previous)) {
				expect(row[column], `${id}.${column}`).toEqual(value);
			}
		}
		// No new word is left anywhere.
		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM document_extraction_jobs WHERE status IN ('running','cancelled')",
				)
				.get(),
		).toEqual({ n: 0 });
		expect(
			old.sqlite
				.prepare(
					"SELECT COUNT(*) AS n FROM document_extraction_job_attempts WHERE status = 'cancelled'",
				)
				.get(),
		).toEqual({ n: 0 });
	});

	it("the reverse SQL adds the outage waits the previous release wrote while it served on the new words", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		// The engine put `job-queued` behind an outage wait: three waits so far, the
		// window open since the seed. Then the deploy's health check failed and the
		// script restarted the previous release on these rows before anyone ran the
		// reverse SQL (rollback-extraction.md, "When to run it"). That release does not
		// know `retry_state_json`: it claimed the job, found no `$outage` in the hints,
		// started a count of its own, failed it on the same outage and wrote that count
		// back as the reserved key.
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET retry_state_json = ?, hints_json = ?, status = 'queued' WHERE id = 'job-queued'",
			)
			.run(
				JSON.stringify({ since: SEED_EPOCH * 1000, waits: 3 }),
				JSON.stringify({
					tier: "basic",
					$outage: { since: (SEED_EPOCH + 700) * 1000, waits: 1 },
				}),
			);

		old.sqlite.exec(
			readFileSync("docs/plans/jobs-merge/rollback-extraction.sql", "utf8"),
		);

		const row = byId(old.readJobs()).get("job-queued");
		// Both counts are the backend's fault, so both stay off the document's
		// budget; the window is the one the run began with, as the shim keeps it.
		expect(parseJson(row?.hints_json)).toEqual({
			tier: "basic",
			$outage: { since: SEED_EPOCH * 1000, waits: 4 },
		});
		expect(row?.retry_state_json).toBeNull();
	});

	it("the reverse SQL is safe on rows the engine made: a running job with no phase, a requeue with a retry state", () => {
		const old = openPreEngine();
		old.seedEveryOldWord();
		old.upgrade();
		// A running row without a phase cannot be produced by the engine's claim
		// (it sets the first phase), but a row that somehow has none must still
		// come out as a word the old code can run.
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET status = 'running', phase = NULL WHERE id = 'job-queued'",
			)
			.run();
		old.sqlite
			.prepare(
				"UPDATE document_extraction_jobs SET retry_state_json = ?, hints_json = NULL, status = 'queued' WHERE id = 'job-canceled'",
			)
			.run(JSON.stringify({ since: 1, waits: 4 }));
		old.sqlite
			.prepare(
				"UPDATE document_extraction_job_attempts SET status = 'cancelled' WHERE id = 'att-failed-5'",
			)
			.run();

		old.sqlite.exec(
			readFileSync("docs/plans/jobs-merge/rollback-extraction.sql", "utf8"),
		);

		const rows = byId(old.readJobs());
		expect(rows.get("job-queued")?.status).toBe("uploading");
		expect(parseJson(rows.get("job-canceled")?.hints_json)).toEqual({
			$outage: { since: 1, waits: 4 },
		});
		expect(rows.get("job-canceled")?.retry_state_json).toBeNull();
		expect(byId(old.readAttempts()).get("att-failed-5")?.status).toBe(
			"canceled",
		);
	});
});

function parseJsonOrText(value: unknown): unknown {
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}
