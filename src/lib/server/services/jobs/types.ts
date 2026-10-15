// Every type of the engine's interface, and the few constants that belong with
// them. Type imports only from the app: the one runtime import below would be
// `import type`, so this file costs nothing to load.

import type { SQL } from "drizzle-orm";
import type { AnySQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { db } from "$lib/server/db";
import type {
	AttemptShape,
	JobAttemptProperty,
	JobLifecycleProperty,
	JobShape,
} from "./columns";

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

export const JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"cancelled",
] as const;

/** A job's status. Every kind spells it these five ways and no other. */
export type JobStatus = (typeof JOB_STATUSES)[number];

/** An attempt's status: it is only ever `queued`'s opposite, so `queued` is absent. */
export type JobAttemptStatus = "running" | "succeeded" | "failed" | "cancelled";

/** The statuses a job can no longer leave on its own. */
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = [
	"succeeded",
	"failed",
	"cancelled",
];

export function isTerminalJobStatus(status: string): boolean {
	return (TERMINAL_JOB_STATUSES as readonly string[]).includes(status);
}

// ---------------------------------------------------------------------------
// Tables and rows
// ---------------------------------------------------------------------------

/** A transaction handle, as `db.transaction` hands it out. Synchronous. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Any table with the engine's lifecycle properties, whatever else it carries.
 * A kind's table satisfies it by being built with `jobColumns()`.
 */
export type JobTable = SQLiteTable & {
	[K in JobLifecycleProperty]: AnySQLiteColumn;
};

/** Any table with the engine's attempt properties. Built with `jobAttemptColumns()`. */
export type JobAttemptTable = SQLiteTable & {
	[K in JobAttemptProperty]: AnySQLiteColumn;
};

/** A row of a kind's jobs table, domain columns included. */
export type Row<J extends JobTable> = J["$inferSelect"];

/**
 * What a caller supplies to create a job: the domain columns, `userId`
 * included. The lifecycle columns are the engine's.
 */
export type DomainInsert<J extends JobTable> = Omit<
	J["$inferInsert"],
	Exclude<JobLifecycleProperty, "userId">
>;

/** A job row as the engine itself sees it: lifecycle columns only. */
export type ShapeRow = JobShape["$inferSelect"];
export type AttemptShapeRow = AttemptShape["$inferSelect"];

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export interface JobFailure {
	code: string;
	message: string;
	retryable: boolean;
	retryAfterMs?: number;
	diagnostics?: unknown;
	/** The checkpoint points at something that no longer exists (extraction: handleUnknown). */
	discardCheckpoint?: boolean;
}

/** What the kind's policy knows when it decides: the job's own history. */
export interface FailureHistory {
	/** The job's `attemptCount`: attempts so far, the failing one included. */
	attempts: number;
	/** The job's `retryState`, parsed. `null` when it has none. */
	state: unknown;
	nowMs: number;
}

/**
 * What a failure does to the job.
 *
 * `code` and `retryable` are what the JOB row records (the attempt always
 * records the failure as it came); `state` replaces the job's `retryState` when
 * present. A requeue keeps the error on the row so the card can say it is
 * retrying.
 */
export type FailureDecision =
	| {
			requeue: true;
			delayMs: number;
			code?: string;
			retryable?: boolean;
			state?: unknown;
	  }
	| { requeue: false; retryable: boolean; code?: string; state?: unknown };

export interface FailOutcome {
	/** false: the attempt no longer owned the job and nothing was written. */
	applied: boolean;
	requeued: boolean;
	runAfter: Date | null;
}

/** Why the engine takes an attempt back. */
export type TakeBackReason = "stale" | "dead-worker" | "state-lost";

// ---------------------------------------------------------------------------
// Running a job
// ---------------------------------------------------------------------------

/** Why a run's signal was aborted. */
export type JobAbortReason = "cancelled" | "lease-lost";

export type JobHandler<J extends JobTable> = (
	ctx: JobRunContext<J>,
) => Promise<void>;

export interface JobRunContext<J extends JobTable> {
	/** The row as claimed. */
	row: Row<J>;
	attempt: { id: string; number: number };
	/**
	 * Aborted at once when this process cancels the job, and at the next beat
	 * when the lease is gone. `signal.reason` is `"cancelled"` or `"lease-lost"`.
	 * After an abort the handler stops; anything it still writes is refused.
	 */
	signal: AbortSignal;
	/**
	 * Fenced. Moves the phase and/or replaces the checkpoint; counts as a beat.
	 * false = nothing was written. When the attempt no longer owns the job,
	 * `signal` is aborted before this resolves; a phase that would move backwards
	 * is refused without aborting.
	 */
	progress(update: { phase?: string; checkpoint?: unknown }): Promise<boolean>;
	/**
	 * Fenced domain write mid-run (Atlas: stage, progress, title). Counts as a
	 * beat. `apply` runs inside the fenced transaction, and may write the kind's
	 * own extra attempt columns for `ctx.attempt.id`. false = this attempt no
	 * longer owns the job and `apply` did not run.
	 *
	 * Rejects when `apply` throws (the transaction is rolled back) or the database
	 * cannot be written. The promise is observed by the engine either way, so a
	 * handler that fires and forgets it (`void ctx.write(...)`) cannot crash the
	 * process; a handler that awaits it sees the rejection.
	 */
	write(apply: (tx: Tx) => void): Promise<boolean>;
	/** Fenced. Settles the job succeeded and runs `apply` in the same transaction. */
	succeed(options?: {
		diagnostics?: unknown;
		apply?: (tx: Tx) => void;
	}): Promise<boolean>;
	/**
	 * Fenced. Runs the kind's `onFailure` and writes its decision, with `apply`
	 * in the same transaction.
	 */
	fail(
		failure: JobFailure,
		options?: { apply?: (tx: Tx) => void },
	): Promise<FailOutcome>;
}

/** The three words that name one attempt's claim: the fencing token. */
export interface OwnedAttempt {
	jobId: string;
	attemptId: string;
	workerId: string;
}

/** What a claim hands the runner. */
export interface Claimed {
	row: ShapeRow;
	attempt: { id: string; number: number };
}

// ---------------------------------------------------------------------------
// The kind
// ---------------------------------------------------------------------------

export interface JobKindDefinition<
	J extends JobTable,
	A extends JobAttemptTable,
> {
	/** "atlas" | "extraction" | "file-production": worker ids, logs, tests. Stored nowhere. */
	name: string;
	/** Kept from today: "[ATLAS]", "[EXTRACTION]", "[FILE_PRODUCTION]". */
	logPrefix: string;
	/** The kind's two tables, built with jobColumns() and jobAttemptColumns(). */
	tables: { jobs: J; attempts: A };
	/** Re-read before every claim and on every tick. false = take no new work. */
	enabled(): boolean;
	/** Counted over rows, so they hold across processes. */
	limits(): { global: number; perUser?: number };
	/**
	 * heartbeatMs: how often a running attempt proves it is alive.
	 * staleAfterMs: how long without a beat before the attempt is reclaimed.
	 */
	lease(): { heartbeatMs: number; staleAfterMs: number };
	/** An extra claim condition. Atlas: the reply message is linked. */
	claimable?(jobs: J): SQL;
	/** Progress phases in order. A report may repeat a phase or move forward, never back. */
	phases?: readonly string[];
	/** The failure an attempt gets when the engine takes it back. */
	lostAttempt(reason: TakeBackReason): { code: string; message: string };
	/**
	 * Pure: what a failure does to the job. Called for every failure, whatever
	 * its source: the handler's own, a throw, and the three take-backs.
	 */
	onFailure(failure: JobFailure, history: FailureHistory): FailureDecision;
	/** Which settled jobs the user's Retry may reopen, and whether this one may. */
	userRetry?: {
		from: ReadonlyArray<"failed" | "cancelled">;
		requireRetryable?: boolean;
		allow?(row: Row<J>): boolean;
	};
	/** Domain columns kept in step with a transition, in the same transaction (Atlas: stage). */
	onTransition?(tx: Tx, row: Row<J>, to: JobStatus): void;
	/** The work. Loaded on first claim, so a read path never imports a renderer or the sandbox. */
	handler(): Promise<JobHandler<J>>;
	/** Extraction's direct-text runs: a job that may run inside the request that made it. */
	inline?: { eligible(row: Row<J>): boolean };
}

declare const rowBrand: unique symbol;

/**
 * What `defineJobKind` returns: an opaque handle every function of the
 * interface takes. The row type rides along as a phantom, which is what types
 * `enqueue`'s `values` and every returned row; it never exists at runtime.
 */
export interface JobKind<J extends JobTable = JobTable> {
	readonly name: string;
	readonly logPrefix: string;
	readonly [rowBrand]?: J;
}

// ---------------------------------------------------------------------------
// Callers
// ---------------------------------------------------------------------------

export interface EnqueueInput<J extends JobTable> {
	/** The domain columns, userId included. Lifecycle columns are the engine's. */
	values: DomainInsert<J>;
	priority?: number;
	runAfter?: Date;
	/** Born settled: a request that failed validation, or a dedupe hit that is already done. */
	born?:
		| { status: "failed"; code: string; message: string; retryable: boolean }
		| { status: "succeeded" };
	/**
	 * Race-safe idempotency, all in one transaction: find the job this request
	 * repeats and say what to do with it. "insert" lets the kind release a key
	 * first (file production's `#superseded:` rename) by writing in tx before it
	 * answers.
	 */
	idempotency?: {
		find(tx: Tx): Row<J> | null;
		onExisting(tx: Tx, existing: Row<J>): "reuse" | "replace" | "insert";
	};
	/** The clock the row is stamped with. A test seam; production passes nothing. */
	now?: Date;
}

export interface ReopenInput<J extends JobTable> {
	userId: string;
	from: readonly JobStatus[];
	/** Checked in the transaction (file production: no file left and a request kept). */
	allow?(tx: Tx, row: Row<J>): boolean;
	/** Domain columns written in the same transaction (extraction: new hints). */
	patch?(row: Row<J>): Partial<DomainInsert<J>>;
	/** Cleared by default; extraction's re-extract and file production's regenerate both clear it. */
	keepCheckpoint?: boolean;
	/** The retry policy's memory, rewritten (extraction carries `waits` and clears `since`). */
	retryState?(state: unknown): unknown;
}

export interface RecoverOptions<J extends JobTable> {
	/** Narrows every query below to a scope (file production: one conversation). */
	where?: (jobs: J) => SQL;
	/** Queued jobs last touched before this are failed with `queuedFailure`. */
	queuedOlderThan?: Date;
	/** What such a job fails with. Defaults to `worker_queue_timeout`. */
	queuedFailure?: { code: string; message: string; retryable?: boolean };
	/**
	 * An attempt whose last beat is older than this is taken back, and so is a
	 * running job with no live attempt that was last touched before it. Defaults
	 * to the lease: `now - staleAfterMs`.
	 */
	staleBefore?: Date;
	now?: Date;
}

export interface JobDescription {
	terminal: boolean;
	canCancel: boolean;
	canRetry: boolean;
}

export interface VerdictResult {
	settled: boolean;
	/** The last status seen; null when the job does not exist. */
	status: JobStatus | null;
}
