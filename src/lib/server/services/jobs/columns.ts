// The lifecycle shape every kind's tables share.
//
// A kind keeps its own jobs table and its own attempts table (design: "Storage"),
// and builds both from the functions here, so the engine can be written once
// over any pair of tables that carry these properties. The TypeScript property
// names are fixed; the SQL names are the engine's defaults unless a kind passes
// a legacy one, so no existing column is ever renamed.
//
// This file imports nothing from the app. `schema.ts` imports IT (a kind's
// tables are declared there), so an import back the other way would be a cycle:
// the one thing the builders need from `schema.ts`, `users.id`, is handed in.

import { sql } from "drizzle-orm";
import {
	type AnySQLiteColumn,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** The 18 properties of a jobs table the engine reads and writes. */
export const JOB_LIFECYCLE_PROPERTIES = [
	"id",
	"userId",
	"status",
	"phase",
	"priority",
	"runAfter",
	"attemptCount",
	"currentAttemptId",
	"retryable",
	"errorCode",
	"errorMessage",
	"checkpoint",
	"retryState",
	"cancelRequestedAt",
	"startedAt",
	"completedAt",
	"createdAt",
	"updatedAt",
] as const;

export type JobLifecycleProperty = (typeof JOB_LIFECYCLE_PROPERTIES)[number];

/** The 16 properties of an attempts table. A kind may add columns of its own. */
export const JOB_ATTEMPT_PROPERTIES = [
	"id",
	"jobId",
	"attemptNumber",
	"status",
	"phase",
	"workerId",
	"claimedAt",
	"heartbeatAt",
	"startedAt",
	"finishedAt",
	"errorCode",
	"errorMessage",
	"retryable",
	"diagnosticsJson",
	"createdAt",
	"updatedAt",
] as const;

export type JobAttemptProperty = (typeof JOB_ATTEMPT_PROPERTIES)[number];

export interface JobColumnOptions {
	/**
	 * A legacy SQL name, by property. Every property not named keeps the
	 * default: Atlas `retryable` is `error_retryable`, extraction `runAfter` is
	 * `next_attempt_at` and `checkpoint` is `remote_handle_json`, file
	 * production `phase` is `stage`.
	 */
	sqlNames?: Partial<Record<JobLifecycleProperty, string>>;
	/** What a row with no status is. `queued`, except file production's legacy `succeeded`. */
	statusDefault?: string;
	/**
	 * `users.id`, for the foreign key (cascade). Handed in rather than imported
	 * so that `schema.ts` can import this file. A kind's table passes it.
	 */
	userId?: () => AnySQLiteColumn;
}

export interface JobAttemptColumnOptions {
	/** The kind's jobs table `id`: an attempt belongs to its job and goes with it. */
	jobId: () => AnySQLiteColumn;
	/** File production keeps `stage`. */
	sqlNames?: Partial<Record<"phase", string>>;
}

/**
 * The columns of a kind's jobs table, to be spread into `sqliteTable` beside the
 * kind's own domain columns.
 *
 * | property | meaning |
 * |---|---|
 * | `status` | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
 * | `phase` | progress phase while running; left as it was when the job settles |
 * | `priority` | lower runs sooner |
 * | `runAfter` | not claimable before this (backoff) |
 * | `attemptCount` | attempts so far |
 * | `currentAttemptId` | the latest attempt; still set after the job settles |
 * | `checkpoint` | resumable state (JSON): survives requeues, cleared on settle |
 * | `retryState` | the retry policy's own memory (JSON) |
 *
 * Timestamps are unix seconds (`mode: "timestamp"`), like every other table.
 */
export function jobColumns(options: JobColumnOptions = {}) {
	const name = (property: JobLifecycleProperty, fallback: string): string =>
		options.sqlNames?.[property] ?? fallback;
	const userId = text(name("userId", "user_id")).notNull();

	return {
		id: text(name("id", "id")).primaryKey(),
		userId: options.userId
			? userId.references(options.userId, { onDelete: "cascade" })
			: userId,
		status: text(name("status", "status"))
			.notNull()
			.default(options.statusDefault ?? "queued"),
		phase: text(name("phase", "phase")),
		priority: integer(name("priority", "priority")).notNull().default(0),
		runAfter: integer(name("runAfter", "run_after"), { mode: "timestamp" }),
		attemptCount: integer(name("attemptCount", "attempt_count"))
			.notNull()
			.default(0),
		currentAttemptId: text(name("currentAttemptId", "current_attempt_id")),
		retryable: integer(name("retryable", "retryable"), { mode: "boolean" })
			.notNull()
			.default(false),
		errorCode: text(name("errorCode", "error_code")),
		errorMessage: text(name("errorMessage", "error_message")),
		checkpoint: text(name("checkpoint", "checkpoint_json")),
		retryState: text(name("retryState", "retry_state_json")),
		cancelRequestedAt: integer(
			name("cancelRequestedAt", "cancel_requested_at"),
			{ mode: "timestamp" },
		),
		startedAt: integer(name("startedAt", "started_at"), {
			mode: "timestamp",
		}),
		completedAt: integer(name("completedAt", "completed_at"), {
			mode: "timestamp",
		}),
		createdAt: integer(name("createdAt", "created_at"), { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer(name("updatedAt", "updated_at"), { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	};
}

/**
 * The columns of a kind's attempts table. An attempt is one claim: the fencing
 * token (`id` plus `workerId`) every write the run makes must still match.
 */
export function jobAttemptColumns(options: JobAttemptColumnOptions) {
	return {
		id: text("id").primaryKey(),
		jobId: text("job_id")
			.notNull()
			.references(options.jobId, { onDelete: "cascade" }),
		attemptNumber: integer("attempt_number").notNull(),
		status: text("status").notNull().default("running"),
		phase: text(options.sqlNames?.phase ?? "phase"),
		workerId: text("worker_id"),
		claimedAt: integer("claimed_at", { mode: "timestamp" }),
		heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }),
		startedAt: integer("started_at", { mode: "timestamp" }),
		finishedAt: integer("finished_at", { mode: "timestamp" }),
		errorCode: text("error_code"),
		errorMessage: text("error_message"),
		retryable: integer("retryable", { mode: "boolean" })
			.notNull()
			.default(false),
		diagnosticsJson: text("diagnostics_json"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		updatedAt: integer("updated_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
	};
}

/** The jobs-table columns the live index is built over. */
interface LiveClaimIndexColumns {
	status: AnySQLiteColumn;
	priority: AnySQLiteColumn;
	createdAt: AnySQLiteColumn;
}

/**
 * The index the claim and the idle tick read: `(status, priority, created_at)`
 * over the live rows only.
 *
 * Partial, so it holds the handful of rows that are queued or running and not a
 * ledger of mostly settled ones. Written as two `=` terms joined by `or` rather
 * than an `in (…)` list on purpose: SQLite only uses a partial index when it can
 * see the index's own WHERE terms in the query's, and it proves `status =
 * 'running'` implies `status = 'queued' or status = 'running'` while it does NOT
 * prove it implies `status in ('queued','running')`. The engine's queries use
 * the same `or` spelling for the same reason (measured on file production's
 * ledger: 704 µs scanning, 4.7 µs through the index).
 *
 * `priority` second and `createdAt` third so the claim's `order by priority,
 * created_at` is served by the index order instead of a temp b-tree.
 */
export function liveClaimIndex(name: string, table: LiveClaimIndexColumns) {
	return index(name)
		.on(table.status, table.priority, table.createdAt)
		.where(sql`${table.status} = 'queued' or ${table.status} = 'running'`);
}

/** The attempts-table columns the three indexes are built over. */
interface AttemptIndexColumns {
	jobId: AnySQLiteColumn;
	attemptNumber: AnySQLiteColumn;
	createdAt: AnySQLiteColumn;
	workerId: AnySQLiteColumn;
	status: AnySQLiteColumn;
	heartbeatAt: AnySQLiteColumn;
}

/**
 * The attempts table's indexes, named `<prefix>_job_number_unique_idx`,
 * `<prefix>_job_idx` and `<prefix>_worker_idx` like the ones the existing
 * ledgers carry. The unique one is the engine's last defence for attempt
 * numbers: a count the old process left behind can never collide with it.
 */
export function jobAttemptIndexes(prefix: string, table: AttemptIndexColumns) {
	return {
		jobNumberUniqueIdx: uniqueIndex(`${prefix}_job_number_unique_idx`).on(
			table.jobId,
			table.attemptNumber,
		),
		jobIdx: index(`${prefix}_job_idx`).on(table.jobId, table.createdAt),
		workerIdx: index(`${prefix}_worker_idx`).on(
			table.workerId,
			table.status,
			table.heartbeatAt,
		),
	};
}

// The shape tables. They are never queried: they exist so the engine has ONE
// static type for every kind's tables (a kind's real table has more columns and
// a different name, so no real table is assignable to another). `defineJobKind`
// casts a kind's tables to these in exactly one place, and from then on every
// engine query is an ordinary Drizzle query with no per-query cast. Drizzle
// renders SQL from the runtime column objects, so the kind's own SQL names
// (`error_retryable`, `next_attempt_at`, `stage`) are what reaches SQLite.
const jobShapeTable = sqliteTable("job_shape", jobColumns());
const attemptShapeTable = sqliteTable(
	"job_attempt_shape",
	jobAttemptColumns({ jobId: () => jobShapeTable.id }),
);

export type JobShape = typeof jobShapeTable;
export type AttemptShape = typeof attemptShapeTable;
export type JobColumns = ReturnType<typeof jobColumns>;
export type JobAttemptColumns = ReturnType<typeof jobAttemptColumns>;
