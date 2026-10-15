// Every state change of a job and of its attempts, and nothing else.
//
// No file system, no HTTP, no handler: those live behind the kind's definition,
// which is what lets a route import the engine without dragging a renderer or an
// extractor into a request that only reads rows.
//
// Every transition is one `db.transaction`. A transition an attempt makes is
// FENCED: the job must still be `running`, still point at this attempt, and the
// attempt must still be `running` under this worker id. A run that lost its
// lease to a take-back therefore cannot write over whoever holds the job now:
// its write matches nothing and the function says so, which the runner treats as
// "stop, write nothing".
//
// No transaction here wraps an `await`. better-sqlite3 transactions are
// synchronous, `db/write-lock.ts` makes every one of them take the write lock
// when it begins, and a handler runs BETWEEN transactions, never inside one.
// Anything a caller hands in to run inside one (`apply`, `find`, `patch`) is
// synchronous for the same reason, and one that returns a promise is refused.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import type { EngineDefinition } from "./define";
import { internalsOf } from "./define";
import { emitSettled } from "./events";
import { abortRunningAttempt } from "./state";
import {
	type Claimed,
	type DomainInsert,
	type EnqueueInput,
	type FailOutcome,
	type FailureDecision,
	type FailureHistory,
	isTerminalJobStatus,
	type JobDescription,
	type JobFailure,
	type JobKind,
	type JobStatus,
	type JobTable,
	type OwnedAttempt,
	type ReopenInput,
	type Row,
	type ShapeRow,
	type Tx,
} from "./types";

/**
 * How many per-user HEADS a claim looks at before giving up for this call.
 *
 * It used to be 32 rows chosen by `ORDER BY priority, created_at` over the whole
 * queue, which is the starvation bug: one user who queues a folder of 100
 * documents fills the entire window with their own rows, and the per-user cap
 * then rejects all 32 of them. Another user's single upload, queued a second
 * later, is not in the window at all. The window holds at most ONE row per user,
 * so it is 32 DISTINCT users deep; the order across users is unchanged
 * (priority first, then age), so a fair claim is still a prioritised one.
 */
const CLAIM_CANDIDATE_LIMIT = 32;

function isUniqueConstraintError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const code =
		"code" in error && typeof error.code === "string" ? error.code : null;
	return (
		code === "SQLITE_CONSTRAINT_UNIQUE" ||
		error.message.includes("UNIQUE constraint failed")
	);
}

/**
 * Runs a caller's callback inside a transaction. A callback that returns a
 * promise is a bug that would commit before the promise settled, so it is
 * refused loudly instead of being allowed to half-work.
 */
function runInTransaction<T>(
	callback: ((tx: Tx) => T) | undefined,
	tx: Tx,
	what: string,
): T | undefined {
	if (!callback) return undefined;
	const result = callback(tx);
	if (
		result !== null &&
		typeof result === "object" &&
		typeof (result as { then?: unknown }).then === "function"
	) {
		throw new Error(
			`${what} ran inside a transaction and returned a promise: transactions are synchronous, so it must not await anything.`,
		);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export function readJobRow(kind: JobKind, jobId: string): ShapeRow | null {
	const { jobs } = internalsOf(kind);
	return (
		db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1).get() ?? null
	);
}

/** Whether Retry may reopen this row. One rule, read by `retry` and `describeJob` alike. */
export function retryAllowed(
	definition: EngineDefinition,
	row: ShapeRow,
): boolean {
	const rule = definition.userRetry;
	if (!rule) return false;
	if (!(rule.from as readonly string[]).includes(row.status)) return false;
	if (rule.requireRetryable && !row.retryable) return false;
	return rule.allow ? rule.allow(row) : true;
}

/** Pure facts for read models: terminal, may cancel, may retry. */
export function describeJob<J extends JobTable>(
	kind: JobKind<J>,
	row: Row<J>,
): JobDescription {
	const { definition } = internalsOf(kind);
	const shaped = row as unknown as ShapeRow;
	const terminal = isTerminalJobStatus(shaped.status);
	return {
		terminal,
		canCancel: !terminal,
		canRetry: retryAllowed(definition, shaped),
	};
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Creates a job, or finds the one this request repeats.
 *
 * Idempotency is race-safe because it is all one transaction: the kind's `find`
 * and the insert cannot be separated by another writer. A unique violation that
 * still happens (a key the kind's `find` does not cover, or a connection that
 * does not take the write lock at BEGIN) rolls that transaction back; the
 * loser then asks `find` again, outside it, and reuses the winner's row.
 */
export function enqueueJob<J extends JobTable>(
	kind: JobKind<J>,
	input: EnqueueInput<J>,
): { row: Row<J>; reused: boolean } {
	const { jobs, definition } = internalsOf(kind);
	const values = input.values as unknown as Record<string, unknown>;
	if (typeof values.userId !== "string" || values.userId.length === 0) {
		throw new Error(`${definition.name}: enqueue needs values.userId.`);
	}

	const now = input.now ?? new Date();
	const born = input.born;
	const status: JobStatus = born ? born.status : "queued";
	const idempotency = input.idempotency as
		| {
				find(tx: Tx): ShapeRow | null;
				onExisting(tx: Tx, existing: ShapeRow): "reuse" | "replace" | "insert";
		  }
		| undefined;

	const insertOnce = (): { row: ShapeRow; reused: boolean } =>
		db.transaction((tx) => {
			if (idempotency) {
				const existing = idempotency.find(tx);
				if (existing) {
					const verdict = idempotency.onExisting(tx, existing);
					if (verdict === "reuse") return { row: existing, reused: true };
					if (verdict === "replace") {
						// The attempts go with it (the foreign key cascades).
						tx.delete(jobs).where(eq(jobs.id, existing.id)).run();
					}
				}
			}

			const id = randomUUID();
			tx.insert(jobs)
				.values({
					...values,
					id,
					status,
					priority: input.priority ?? 0,
					runAfter: born ? null : (input.runAfter ?? null),
					attemptCount: 0,
					currentAttemptId: null,
					phase: null,
					retryable: born?.status === "failed" ? born.retryable : false,
					errorCode: born?.status === "failed" ? born.code : null,
					errorMessage: born?.status === "failed" ? born.message : null,
					checkpoint: null,
					retryState: null,
					cancelRequestedAt: null,
					startedAt: born ? now : null,
					completedAt: born ? now : null,
					createdAt: now,
					updatedAt: now,
				} as typeof jobs.$inferInsert)
				.run();
			const row = tx.select().from(jobs).where(eq(jobs.id, id)).get();
			if (!row)
				throw new Error(`Enqueued ${definition.name} job ${id} disappeared.`);
			definition.onTransition?.(tx, row, status);
			return { row, reused: false };
		});

	let result: { row: ShapeRow; reused: boolean };
	try {
		result = insertOnce();
	} catch (error) {
		if (!idempotency || !isUniqueConstraintError(error)) throw error;
		const winner = db.transaction((tx) => idempotency.find(tx));
		if (!winner) throw error;
		result = { row: winner, reused: true };
	}

	if (!result.reused && result.row.status !== "queued") {
		emitSettled(definition.name, result.row.id, result.row.status as JobStatus);
	}
	return result as unknown as { row: Row<J>; reused: boolean };
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

export interface ClaimOptions {
	workerId: string;
	/** Restricts the claim to this job. The inline path uses it. */
	jobId?: string;
	/** true = past the global and per-user caps (an inline run). */
	ignoreCaps?: boolean;
	now?: Date;
}

/**
 * Takes the next claimable job and opens an attempt on it, or returns null.
 *
 * The whole body is one transaction, so the count that enforces the caps and the
 * compare-and-set that takes the row cannot be separated by another writer, in
 * this process or any other. The `UPDATE … WHERE status = 'queued'` is the CAS:
 * a second claimer that read the same candidate first sees no change and moves
 * to the next one, which is why a second process would be correct and not merely
 * unlikely to collide.
 *
 * The caps are COUNTED OVER ROWS (`status = 'running'`, whoever owns them), so
 * they hold across processes: a second worker, a script and the deploy overlap
 * all spend the same budget.
 */
export function claimNext(
	kind: JobKind,
	options: ClaimOptions,
): Claimed | null {
	const { jobs, attempts, definition } = internalsOf(kind);
	const now = options.now ?? new Date();

	return db.transaction((tx) => {
		const limits = definition.limits();
		const ignoreCaps = options.ignoreCaps === true;

		if (!ignoreCaps) {
			const [running] = tx
				.select({ count: sql<number>`count(*)` })
				.from(jobs)
				.where(eq(jobs.status, "running"))
				.all();
			if (Number(running?.count ?? 0) >= limits.global) return null;
		}

		const gate = and(
			eq(jobs.status, "queued"),
			or(isNull(jobs.runAfter), lte(jobs.runAfter, now)),
			definition.claimable?.(jobs),
			options.jobId ? eq(jobs.id, options.jobId) : undefined,
		);

		// One row PER USER, that user's first claimable job, and only then ordered
		// by priority and age. See CLAIM_CANDIDATE_LIMIT.
		//
		// `rowid` is the tie-break, NOT `id`. `created_at` has one-second
		// resolution, so a burst of jobs ties on it routinely, and `id` is a random
		// UUID: ordering by it would shuffle jobs queued in the same second into an
		// arbitrary order. `rowid` is insertion order, which is what "oldest" means
		// once the timestamp has run out of resolution.
		const headIds = tx
			.all<{ id: string }>(
				sql`
					select id from (
						select
							${jobs.id} as id,
							${jobs.priority} as priority,
							${jobs.createdAt} as created_at,
							rowid as seq,
							row_number() over (
								partition by ${jobs.userId}
								order by ${jobs.priority} asc, ${jobs.createdAt} asc, rowid asc
							) as user_rank
						from ${jobs}
						where ${gate}
					)
					where user_rank = 1
					order by priority asc, created_at asc, seq asc
					limit ${CLAIM_CANDIDATE_LIMIT}
				`,
			)
			.map((row) => row.id);
		if (headIds.length === 0) return null;

		const byId = new Map(
			tx
				.select()
				.from(jobs)
				.where(inArray(jobs.id, headIds))
				.all()
				.map((row) => [row.id, row] as const),
		);

		for (const id of headIds) {
			const candidate = byId.get(id);
			if (!candidate) continue;

			if (!ignoreCaps && limits.perUser !== undefined) {
				const [mine] = tx
					.select({ count: sql<number>`count(*)` })
					.from(jobs)
					.where(
						and(eq(jobs.userId, candidate.userId), eq(jobs.status, "running")),
					)
					.all();
				if (Number(mine?.count ?? 0) >= limits.perUser) continue;
			}

			// One more than the highest number the attempts table holds, and never
			// less than the count: the unique (job, number) index is the last line of
			// defence, not the thing that finds out the old process left a count
			// behind.
			const [numbers] = tx
				.select({
					highest: sql<number>`coalesce(max(${attempts.attemptNumber}), 0)`,
				})
				.from(attempts)
				.where(eq(attempts.jobId, candidate.id))
				.all();
			const attemptNumber =
				Math.max(candidate.attemptCount, Number(numbers?.highest ?? 0)) + 1;
			const attemptId = randomUUID();
			const phase = definition.phases?.[0] ?? null;

			const taken = tx
				.update(jobs)
				.set({
					status: "running",
					currentAttemptId: attemptId,
					attemptCount: attemptNumber,
					startedAt: candidate.startedAt ?? now,
					phase,
					runAfter: null,
					retryable: false,
					errorCode: null,
					errorMessage: null,
					updatedAt: now,
				})
				.where(and(eq(jobs.id, candidate.id), eq(jobs.status, "queued")))
				.run();
			if (taken.changes === 0) continue;

			tx.insert(attempts)
				.values({
					id: attemptId,
					jobId: candidate.id,
					attemptNumber,
					status: "running",
					phase,
					workerId: options.workerId,
					claimedAt: now,
					heartbeatAt: now,
					startedAt: now,
					finishedAt: null,
					errorCode: null,
					errorMessage: null,
					retryable: false,
					diagnosticsJson: null,
					createdAt: now,
					updatedAt: now,
				})
				.run();

			const row = tx.select().from(jobs).where(eq(jobs.id, candidate.id)).get();
			if (!row || row.currentAttemptId !== attemptId) return null;
			definition.onTransition?.(tx, row, "running");
			return { row, attempt: { id: attemptId, number: attemptNumber } };
		}

		return null;
	});
}

// ---------------------------------------------------------------------------
// The fence, and the attempt's own writes
// ---------------------------------------------------------------------------

/**
 * The ownership predicate every attempt-owned write shares: the job is still
 * `running`, still points at this attempt, and the attempt is still `running`
 * under this worker id. Returns the job row, or null when the claim is gone.
 */
export function ownedJob(
	tx: Tx,
	kind: JobKind,
	owned: OwnedAttempt,
): ShapeRow | null {
	const { jobs, attempts } = internalsOf(kind);
	const job = tx
		.select()
		.from(jobs)
		.where(
			and(
				eq(jobs.id, owned.jobId),
				eq(jobs.status, "running"),
				eq(jobs.currentAttemptId, owned.attemptId),
			),
		)
		.limit(1)
		.get();
	if (!job) return null;

	const attempt = tx
		.select({ id: attempts.id })
		.from(attempts)
		.where(
			and(
				eq(attempts.id, owned.attemptId),
				eq(attempts.jobId, owned.jobId),
				eq(attempts.workerId, owned.workerId),
				eq(attempts.status, "running"),
			),
		)
		.limit(1)
		.get();
	return attempt ? job : null;
}

export interface SucceedOptions {
	/** Facts about a successful attempt worth keeping (stored as JSON on the attempt). */
	diagnostics?: unknown;
	/** Runs in the same transaction, after the engine's own writes. Synchronous. */
	apply?: (tx: Tx) => void;
	now?: Date;
}

/**
 * Settles the job `succeeded`. Returns false, having written nothing, when the
 * attempt no longer owns the job.
 *
 * The error and the checkpoint are cleared (the work is done and the cursor is
 * moot); the retry policy's memory is kept, because a counter that says how
 * many attempts did not count against the user must survive the success.
 * `currentAttemptId` stays: a succeeded job still names the attempt that
 * produced it, and read models look its diagnostics up through it.
 */
export function succeed(
	kind: JobKind,
	owned: OwnedAttempt,
	options: SucceedOptions = {},
): boolean {
	const { jobs, attempts, definition } = internalsOf(kind);
	const now = options.now ?? new Date();

	const settled = db.transaction((tx) => {
		if (!ownedJob(tx, kind, owned)) return false;

		const updated = tx
			.update(jobs)
			.set({
				status: "succeeded",
				retryable: false,
				errorCode: null,
				errorMessage: null,
				checkpoint: null,
				runAfter: null,
				completedAt: now,
				updatedAt: now,
			})
			.where(
				and(
					eq(jobs.id, owned.jobId),
					eq(jobs.status, "running"),
					eq(jobs.currentAttemptId, owned.attemptId),
				),
			)
			.run();
		if (updated.changes === 0) return false;

		tx.update(attempts)
			.set({
				status: "succeeded",
				finishedAt: now,
				diagnosticsJson:
					options.diagnostics === undefined
						? null
						: JSON.stringify(options.diagnostics),
				updatedAt: now,
			})
			.where(
				and(
					eq(attempts.id, owned.attemptId),
					eq(attempts.jobId, owned.jobId),
					eq(attempts.workerId, owned.workerId),
					eq(attempts.status, "running"),
				),
			)
			.run();

		const row = tx.select().from(jobs).where(eq(jobs.id, owned.jobId)).get();
		if (row) definition.onTransition?.(tx, row, "succeeded");
		runInTransaction(options.apply, tx, "succeed's apply");
		return true;
	});

	if (settled) emitSettled(definition.name, owned.jobId, "succeeded");
	return settled;
}

// ---------------------------------------------------------------------------
// Beats, progress and domain writes
// ---------------------------------------------------------------------------

/** The attempt row's own fence, for the writes that touch it. */
function attemptFence(
	attempts: ReturnType<typeof internalsOf>["attempts"],
	owned: OwnedAttempt,
) {
	return and(
		eq(attempts.id, owned.attemptId),
		eq(attempts.jobId, owned.jobId),
		eq(attempts.workerId, owned.workerId),
		eq(attempts.status, "running"),
	);
}

/**
 * Proves the attempt is alive. Touches the attempt row and nothing on the job:
 * a beat is not a change anyone should see, and a list ordered by `updated_at`
 * must not reshuffle every few seconds.
 */
export function beat(
	kind: JobKind,
	owned: OwnedAttempt,
	now: Date = new Date(),
): boolean {
	const { attempts } = internalsOf(kind);
	return db.transaction((tx) => {
		if (!ownedJob(tx, kind, owned)) return false;
		const touched = tx
			.update(attempts)
			.set({ heartbeatAt: now, updatedAt: now })
			.where(attemptFence(attempts, owned))
			.run();
		return touched.changes > 0;
	});
}

export interface ProgressUpdate {
	phase?: string;
	checkpoint?: unknown;
}

/**
 * "applied": written, and a beat. "lost": the attempt no longer owns the job,
 * nothing was written. "refused": the attempt still owns the job but the phase
 * would move backwards or is not one the kind lists, so nothing was written
 * and nobody should abort: the handler asked for something it may not have.
 */
export type ProgressResult = "applied" | "lost" | "refused";

/**
 * Moves the phase and/or replaces the checkpoint. A phase may repeat or move
 * forward, never back: a requeued job starts again at the first phase (the
 * claim resets it), so "back" only ever means a handler reporting out of order.
 * Reporting the SAME phase again is legal and is a pure beat: a handler that
 * polls a remote every two seconds should not have to remember whether it has
 * already announced `parsing`.
 */
export function progress(
	kind: JobKind,
	owned: OwnedAttempt,
	update: ProgressUpdate,
	now: Date = new Date(),
): ProgressResult {
	const { jobs, attempts, definition } = internalsOf(kind);
	return db.transaction((tx) => {
		const job = ownedJob(tx, kind, owned);
		if (!job) return "lost";

		const phases = definition.phases;
		if (update.phase !== undefined && phases) {
			const next = phases.indexOf(update.phase);
			if (next === -1) return "refused";
			const current = job.phase === null ? -1 : phases.indexOf(job.phase);
			if (next < current) return "refused";
		}

		const jobSet: Partial<typeof jobs.$inferInsert> = {};
		if (update.phase !== undefined && update.phase !== job.phase) {
			jobSet.phase = update.phase;
		}
		if (update.checkpoint !== undefined) {
			jobSet.checkpoint =
				update.checkpoint === null ? null : JSON.stringify(update.checkpoint);
		}
		if (Object.keys(jobSet).length > 0) {
			tx.update(jobs)
				.set({ ...jobSet, updatedAt: now })
				.where(
					and(
						eq(jobs.id, owned.jobId),
						eq(jobs.status, "running"),
						eq(jobs.currentAttemptId, owned.attemptId),
					),
				)
				.run();
		}

		tx.update(attempts)
			.set({
				heartbeatAt: now,
				updatedAt: now,
				...(update.phase === undefined ? {} : { phase: update.phase }),
			})
			.where(attemptFence(attempts, owned))
			.run();
		return "applied";
	});
}

/**
 * A fenced domain write in mid-run (Atlas: stage, progress, title). `apply` runs
 * inside the fenced transaction, so a late write by a run that lost its lease
 * never happens, and it may write the kind's own extra attempt columns too. It
 * counts as a beat.
 */
export function write(
	kind: JobKind,
	owned: OwnedAttempt,
	apply: (tx: Tx) => void,
	now: Date = new Date(),
): boolean {
	const { jobs, attempts } = internalsOf(kind);
	return db.transaction((tx) => {
		if (!ownedJob(tx, kind, owned)) return false;
		runInTransaction(apply, tx, "write's apply");
		tx.update(jobs)
			.set({ updatedAt: now })
			.where(and(eq(jobs.id, owned.jobId), eq(jobs.status, "running")))
			.run();
		tx.update(attempts)
			.set({ heartbeatAt: now, updatedAt: now })
			.where(attemptFence(attempts, owned))
			.run();
		return true;
	});
}

// ---------------------------------------------------------------------------
// Failures: the one path
// ---------------------------------------------------------------------------

function parseJson(text: string | null): unknown {
	if (text === null || text === "") return null;
	try {
		return JSON.parse(text);
	} catch {
		// A policy memory we cannot read is a memory we do not use: the policy
		// starts from nothing, which is the conservative reading.
		return null;
	}
}

/**
 * Asks the kind's policy. A policy that throws is a bug, and a job must not stay
 * `running` and hold a slot because of one: it settles failed and retryable, so
 * the person can press Retry, and the bug is logged.
 */
function decide(
	definition: EngineDefinition,
	failure: JobFailure,
	history: FailureHistory,
): FailureDecision {
	try {
		return definition.onFailure(failure, history);
	} catch (error) {
		console.error(
			`${definition.logPrefix} onFailure threw; settling the job as failed`,
			{ code: failure.code, error },
		);
		return { requeue: false, retryable: true };
	}
}

export interface FailureTarget {
	/** The attempt to close as failed. null = there is none (a job whose attempt row is gone). */
	attemptId: string | null;
	/** Also required of the attempt, when the failure comes from the attempt's own run. */
	workerId?: string;
}

/**
 * The only path from `running` to `queued` or `failed`. A handler's `fail`, a
 * handler that threw, and the three take-backs all arrive here, so the kind's
 * policy sees every failure and a requeue can never bypass it.
 *
 * Returns null, having written nothing, when the attempt was no longer the
 * running one: a take-back that finds it already closed is a no-op, which is
 * what makes taking an attempt back safe to run twice.
 *
 * A requeue KEEPS the job's error on purpose: between the failure and the next
 * claim the card has to be able to say it is retrying and why, rather than show
 * a reassuring blank. The claim clears it.
 */
export function applyFailure(
	tx: Tx,
	kind: JobKind,
	job: ShapeRow,
	target: FailureTarget,
	failure: JobFailure,
	now: Date,
): { requeued: boolean; runAfter: Date | null } | null {
	const { jobs, attempts, definition } = internalsOf(kind);

	if (target.attemptId !== null) {
		const closed = tx
			.update(attempts)
			.set({
				status: "failed",
				finishedAt: now,
				errorCode: failure.code,
				errorMessage: failure.message,
				retryable: failure.retryable,
				diagnosticsJson:
					failure.diagnostics === undefined
						? null
						: JSON.stringify(failure.diagnostics),
				updatedAt: now,
			})
			.where(
				and(
					eq(attempts.id, target.attemptId),
					eq(attempts.jobId, job.id),
					eq(attempts.status, "running"),
					target.workerId === undefined
						? undefined
						: eq(attempts.workerId, target.workerId),
				),
			)
			.run();
		if (closed.changes === 0) return null;
	}

	const decision = decide(definition, failure, {
		attempts: job.attemptCount,
		state: parseJson(job.retryState),
		nowMs: now.getTime(),
	});

	const requeue = decision.requeue;
	// A delay a Date cannot hold (NaN, infinity) is a policy bug, and an invalid
	// date in `run_after` would be worse than running at once; a negative is none.
	const delayMs = decision.requeue
		? Number.isFinite(decision.delayMs)
			? Math.max(0, decision.delayMs)
			: 0
		: 0;
	const runAfter = decision.requeue ? new Date(now.getTime() + delayMs) : null;
	const set: Partial<typeof jobs.$inferInsert> = {
		status: requeue ? "queued" : "failed",
		errorCode: decision.code ?? failure.code,
		errorMessage: failure.message,
		retryable: decision.requeue
			? (decision.retryable ?? failure.retryable)
			: decision.retryable,
		runAfter,
		completedAt: requeue ? null : now,
		updatedAt: now,
	};
	// The checkpoint is what the next attempt resumes from, so a requeue keeps
	// it; a job that is done with has no next attempt, and a failure that says the
	// checkpoint points at something that no longer exists drops it either way.
	if (failure.discardCheckpoint || !requeue) set.checkpoint = null;
	if (decision.state !== undefined) {
		set.retryState =
			decision.state === null ? null : JSON.stringify(decision.state);
	}

	const updated = tx
		.update(jobs)
		.set(set)
		.where(
			and(
				eq(jobs.id, job.id),
				eq(jobs.status, "running"),
				job.currentAttemptId === null
					? isNull(jobs.currentAttemptId)
					: eq(jobs.currentAttemptId, job.currentAttemptId),
			),
		)
		.run();
	if (updated.changes === 0) return null;

	const row = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
	if (row) definition.onTransition?.(tx, row, requeue ? "queued" : "failed");
	return { requeued: requeue, runAfter };
}

export interface FailOptions {
	apply?: (tx: Tx) => void;
	now?: Date;
}

const NOT_APPLIED: FailOutcome = {
	applied: false,
	requeued: false,
	runAfter: null,
};

/**
 * A run's own failure: the handler said so, or threw. Fenced like every write an
 * attempt makes; `applied: false` means the claim was already gone and nothing
 * was written, which is not the same as `requeued: false` (a verdict WAS written
 * and it was final). A caller that conflates the two reports a job as failed on
 * the strength of a write it did not make.
 */
export function fail(
	kind: JobKind,
	owned: OwnedAttempt,
	failure: JobFailure,
	options: FailOptions = {},
): FailOutcome {
	const { definition } = internalsOf(kind);
	const now = options.now ?? new Date();

	const outcome = db.transaction((tx): FailOutcome => {
		const job = ownedJob(tx, kind, owned);
		if (!job) return NOT_APPLIED;
		const applied = applyFailure(
			tx,
			kind,
			job,
			{ attemptId: owned.attemptId, workerId: owned.workerId },
			failure,
			now,
		);
		if (!applied) return NOT_APPLIED;
		runInTransaction(options.apply, tx, "fail's apply");
		return { applied: true, ...applied };
	});

	if (outcome.applied && !outcome.requeued) {
		emitSettled(definition.name, owned.jobId, "failed");
	}
	return outcome;
}

// ---------------------------------------------------------------------------
// Cancel
// ---------------------------------------------------------------------------

/**
 * Settles one queued or running job `cancelled`, inside the caller's
 * transaction. Returns what the caller has to do after the commit.
 *
 * The attempt is closed `cancelled`; the error, the checkpoint and the run time
 * are cleared. `currentAttemptId` stays, like on every settled job. A user who
 * pressed Cancel is owed a cancelled job, not one that stays running because a
 * backend would not answer: the handler is told by its signal, after the commit.
 */
function cancelInTx(
	tx: Tx,
	kind: JobKind,
	job: ShapeRow,
	now: Date,
): { row: ShapeRow; abortAttemptId: string | null } | null {
	const { jobs, attempts, definition } = internalsOf(kind);
	const wasRunning = job.status === "running";

	const settled = tx
		.update(jobs)
		.set({
			status: "cancelled",
			cancelRequestedAt: job.cancelRequestedAt ?? now,
			completedAt: now,
			runAfter: null,
			checkpoint: null,
			errorCode: null,
			errorMessage: null,
			retryable: false,
			updatedAt: now,
		})
		.where(and(eq(jobs.id, job.id), eq(jobs.status, job.status)))
		.run();
	if (settled.changes === 0) return null;

	if (wasRunning && job.currentAttemptId) {
		tx.update(attempts)
			.set({
				status: "cancelled",
				finishedAt: now,
				errorCode: "cancelled",
				errorMessage: "Cancelled by the user.",
				retryable: false,
				updatedAt: now,
			})
			.where(
				and(
					eq(attempts.id, job.currentAttemptId),
					eq(attempts.status, "running"),
				),
			)
			.run();
	}

	const row = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
	if (!row) return null;
	definition.onTransition?.(tx, row, "cancelled");
	return {
		row,
		abortAttemptId: wasRunning ? job.currentAttemptId : null,
	};
}

/** What follows a cancel's commit: stop the run in this process, tell the waiters. */
function afterCancel(
	kindName: string,
	cancelled: Array<{ row: ShapeRow; abortAttemptId: string | null }>,
): void {
	for (const { row, abortAttemptId } of cancelled) {
		if (abortAttemptId) abortRunningAttempt(abortAttemptId, "cancelled");
		emitSettled(kindName, row.id, "cancelled");
	}
}

/**
 * The user's Cancel. Legal from `queued` and from `running`; null for another
 * user's job, a job that does not exist and a job that has settled.
 *
 * If this process is running the attempt, its signal is aborted at once, with
 * the reason `"cancelled"`: a handler blocked on a network call stops now, not
 * at its next heartbeat. A run in another process finds out at its next beat.
 */
export function cancel<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	scope: { userId: string },
	now: Date = new Date(),
): Row<J> | null {
	const { jobs, definition } = internalsOf(kind);
	const cancelled = db.transaction((tx) => {
		const job = tx
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.userId, scope.userId)))
			.limit(1)
			.get();
		if (!job || isTerminalJobStatus(job.status)) return null;
		return cancelInTx(tx, kind, job, now);
	});
	if (!cancelled) return null;
	afterCancel(definition.name, [cancelled]);
	return cancelled.row as unknown as Row<J>;
}

/**
 * Cancel over all of a user's queued and running jobs, optionally narrowed by a
 * domain condition (Atlas: one conversation). Account erasure's quiesce and a
 * conversation's cleanup use it, so a job in flight stops at once instead of
 * finding its rows gone.
 */
export function cancelAll<J extends JobTable>(
	kind: JobKind<J>,
	scope: { userId: string; where?: (jobs: J) => SQL },
	now: Date = new Date(),
): number {
	const { jobs, definition } = internalsOf(kind);
	const cancelled = db.transaction((tx) => {
		const live = tx
			.select()
			.from(jobs)
			.where(
				and(
					eq(jobs.userId, scope.userId),
					or(eq(jobs.status, "queued"), eq(jobs.status, "running")),
					scope.where?.(jobs as unknown as J),
				),
			)
			.all();
		return live.flatMap((job) => {
			const one = cancelInTx(tx, kind, job, now);
			return one ? [one] : [];
		});
	});
	afterCancel(definition.name, cancelled);
	return cancelled.length;
}

// ---------------------------------------------------------------------------
// Retry and reopen
// ---------------------------------------------------------------------------

/** Puts a settled job back in the queue: the fields every reopening resets. */
function queuedAgain(now: Date) {
	return {
		status: "queued" as const,
		errorCode: null,
		errorMessage: null,
		retryable: false,
		runAfter: null,
		cancelRequestedAt: null,
		completedAt: null,
		updatedAt: now,
	};
}

/**
 * The user's Retry, by the kind's `userRetry` rule. Null for another user's job
 * and for a job the rule does not allow, including a second press: the first one
 * already moved the job out of the status the rule names.
 *
 * `attemptCount` is deliberately NOT reset: attempt numbers stay unique per job,
 * which is what makes the attempts table readable after the fact. The next claim
 * numbers the new attempt one past the highest.
 */
export function retry<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	scope: { userId: string },
	now: Date = new Date(),
): Row<J> | null {
	const { jobs, definition } = internalsOf(kind);
	const reopened = db.transaction((tx) => {
		const job = tx
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.userId, scope.userId)))
			.limit(1)
			.get();
		if (!job || !retryAllowed(definition, job)) return null;

		const updated = tx
			.update(jobs)
			.set(queuedAgain(now))
			.where(and(eq(jobs.id, jobId), eq(jobs.status, job.status)))
			.run();
		if (updated.changes === 0) return null;

		const row = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
		if (row) definition.onTransition?.(tx, row, "queued");
		return row ?? null;
	});
	return reopened as unknown as Row<J> | null;
}

/**
 * A reopening that is not a Retry: file production's Regenerate (a succeeded job
 * whose file is gone) and extraction's Re-extract (a settled job, with new
 * hints). The kind says which statuses, whether this job may, what to write on
 * the domain row and what happens to the checkpoint and the retry policy's
 * memory. Only a SETTLED job can be reopened: a queued one has nothing to
 * reopen and a running one is owned by an attempt, whatever `from` says.
 */
export function reopen<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	input: ReopenInput<J>,
	now: Date = new Date(),
): Row<J> | null {
	const { jobs, definition } = internalsOf(kind);
	const reopened = db.transaction((tx) => {
		const job = tx
			.select()
			.from(jobs)
			.where(and(eq(jobs.id, jobId), eq(jobs.userId, input.userId)))
			.limit(1)
			.get();
		if (!job) return null;
		if (!isTerminalJobStatus(job.status)) return null;
		if (!(input.from as readonly string[]).includes(job.status)) return null;
		if (input.allow && !input.allow(tx, job as unknown as Row<J>)) return null;

		const patch: Partial<DomainInsert<J>> =
			input.patch?.(job as unknown as Row<J>) ?? {};
		const set: Record<string, unknown> = {
			...patch,
			...queuedAgain(now),
		};
		if (!input.keepCheckpoint) set.checkpoint = null;
		if (input.retryState) {
			const next = input.retryState(parseJson(job.retryState));
			set.retryState =
				next === undefined || next === null ? null : JSON.stringify(next);
		}

		const updated = tx
			.update(jobs)
			.set(set as Partial<typeof jobs.$inferInsert>)
			.where(and(eq(jobs.id, jobId), eq(jobs.status, job.status)))
			.run();
		if (updated.changes === 0) return null;

		const row = tx.select().from(jobs).where(eq(jobs.id, jobId)).get();
		if (row) definition.onTransition?.(tx, row, "queued");
		return row ?? null;
	});
	return reopened as unknown as Row<J> | null;
}
