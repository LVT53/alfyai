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
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import type { EngineDefinition } from "./define";
import { internalsOf } from "./define";
import { emitSettled } from "./events";
import {
	type Claimed,
	type EnqueueInput,
	isTerminalJobStatus,
	type JobDescription,
	type JobKind,
	type JobStatus,
	type JobTable,
	type OwnedAttempt,
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
