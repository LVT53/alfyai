// The engine taking an attempt back, and the scoped recovery a reader can run.
//
// A run that dies, hangs or is orphaned by a restart leaves a job `running`
// with nobody on it, holding a slot. Three things tell the engine so, and all
// three end in the same transition, through the kind's own `onFailure`:
//
//  - stale: the attempt's last beat is older than the lease allows;
//  - dead-worker: the attempt's worker id names this host and a pid that no
//    longer exists (a restart's orphans, found at boot instead of a stale window
//    later);
//  - state-lost: the job says `running` but its current attempt row is missing
//    or no longer running (every Atlas row at the cutover: Atlas had no attempts).
//
// Taking an attempt back closes it `failed` with the kind's own words for it
// (`lostAttempt`) and hands that failure to the policy, which decides: requeue,
// or settle. It is safe to run twice: the second finds the attempt already
// closed and writes nothing.

import { and, eq, isNull, lt, ne, or, type SQL } from "drizzle-orm";
import { db } from "$lib/server/db";
import type { JobShape } from "./columns";
import { internalsOf } from "./define";
import { emitSettled } from "./events";
import { applyFailure } from "./ledger";
import { abortRunningAttempt } from "./state";
import type {
	JobFailure,
	JobKind,
	JobTable,
	RecoverOptions,
	ShapeRow,
	TakeBackReason,
	Tx,
} from "./types";
import { belongsToDeadProcess, parseWorkerId } from "./worker-identity";

export interface TakeBackOptions {
	reason: TakeBackReason;
	now?: Date;
	/**
	 * stale: an attempt whose last beat is older than this is taken back, and so
	 * is one with no beat on record whose job nobody has touched since. Defaults
	 * to the lease: `now - staleAfterMs`.
	 */
	staleBefore?: Date;
	/**
	 * state-lost: only jobs last touched before this. Omit it AT BOOT, where
	 * nothing of this process is running yet and so nobody can be in the middle of
	 * claiming a row; everywhere else give it, so a row another writer has only
	 * just made (a seed, a claim in flight elsewhere) is left alone.
	 */
	updatedBefore?: Date;
	/** dead-worker: this process's own worker id. Its attempts are never taken. */
	selfWorkerId?: string;
	/** dead-worker: how a pid is known to be gone. Defaults to asking the OS. */
	isProcessAlive?: (pid: number) => boolean;
	/** Narrows every query to a scope. */
	where?: (jobs: JobShape) => SQL;
}

export interface TakeBackResult {
	/** Attempts (or lost jobs) taken back. */
	recovered: number;
	/** Of those, the ones the policy put back in the queue. */
	requeued: number;
}

interface TakenBack {
	jobId: string;
	attemptId: string | null;
	requeued: boolean;
}

function takeBackInTx(
	tx: Tx,
	kind: JobKind,
	options: TakeBackOptions,
	now: Date,
): TakenBack[] {
	const { jobs, attempts, definition } = internalsOf(kind);
	const lost = definition.lostAttempt(options.reason);
	// Every take-back is retryable: the work was not wrong, the worker was gone.
	// The policy may still decide not to try again.
	const failure: JobFailure = {
		code: lost.code,
		message: lost.message,
		retryable: true,
	};
	const taken: TakenBack[] = [];

	const take = (job: ShapeRow, attemptId: string | null): void => {
		const applied = applyFailure(tx, kind, job, { attemptId }, failure, now);
		if (applied) {
			taken.push({ jobId: job.id, attemptId, requeued: applied.requeued });
		}
	};

	if (options.reason === "state-lost") {
		const rows = tx
			.select({ job: jobs })
			.from(jobs)
			.leftJoin(attempts, eq(attempts.id, jobs.currentAttemptId))
			.where(
				and(
					eq(jobs.status, "running"),
					or(isNull(attempts.id), ne(attempts.status, "running")),
					options.updatedBefore
						? lt(jobs.updatedAt, options.updatedBefore)
						: undefined,
					options.where?.(jobs),
				),
			)
			.all();
		for (const { job } of rows) take(job, null);
		return taken;
	}

	const staleBefore =
		options.staleBefore ??
		new Date(now.getTime() - definition.lease().staleAfterMs);
	const self =
		options.reason === "dead-worker"
			? parseWorkerId(options.selfWorkerId)
			: null;
	if (options.reason === "dead-worker" && !self) return taken;

	const rows = tx
		.select({ job: jobs, attemptId: attempts.id, workerId: attempts.workerId })
		.from(attempts)
		.innerJoin(jobs, eq(jobs.id, attempts.jobId))
		.where(
			and(
				eq(jobs.status, "running"),
				eq(jobs.currentAttemptId, attempts.id),
				eq(attempts.status, "running"),
				options.reason === "stale"
					? or(
							lt(attempts.heartbeatAt, staleBefore),
							and(
								isNull(attempts.heartbeatAt),
								lt(jobs.updatedAt, staleBefore),
							),
						)
					: undefined,
				options.where?.(jobs),
			),
		)
		.all();

	for (const row of rows) {
		if (
			options.reason === "dead-worker" &&
			!belongsToDeadProcess(row.workerId, self, options.isProcessAlive)
		) {
			continue;
		}
		take(row.job, row.attemptId);
	}
	return taken;
}

/** What follows a take-back's commit: stop a run this process still has going, tell the waiters. */
function afterTakeBack(kindName: string, taken: TakenBack[]): void {
	for (const entry of taken) {
		if (entry.attemptId) abortRunningAttempt(entry.attemptId, "lease-lost");
		if (!entry.requeued) emitSettled(kindName, entry.jobId, "failed");
	}
}

/**
 * One take-back sweep of one reason. Run at boot, again `staleAfterMs` later
 * (the attempts the restart itself orphaned looked healthy at boot), on the idle
 * tick and between empty drains.
 */
export function takeBack(
	kind: JobKind,
	options: TakeBackOptions,
): TakeBackResult {
	const now = options.now ?? new Date();
	const taken = db.transaction((tx) => takeBackInTx(tx, kind, options, now));
	afterTakeBack(kind.name, taken);
	return {
		recovered: taken.length,
		requeued: taken.filter((entry) => entry.requeued).length,
	};
}

/**
 * Recovery inside a scope, for a reader that must not show stuck work (the
 * file-production fork snapshot). One transaction:
 *
 *  1. queued jobs last touched before `queuedOlderThan` fail, with the caller's
 *     code and message (default `worker_queue_timeout`). No attempt ran and
 *     nothing is left to decide: the caller asked for these jobs to be failed,
 *     so the policy is not asked.
 *  2. stale attempts are taken back, through the policy;
 *  3. running jobs with no live attempt that nobody has touched since
 *     `staleBefore` are taken back too, through the policy.
 */
export function recover<J extends JobTable>(
	kind: JobKind<J>,
	options: RecoverOptions<J>,
): { recovered: number } {
	const { jobs, definition } = internalsOf(kind);
	const now = options.now ?? new Date();
	const staleBefore =
		options.staleBefore ??
		new Date(now.getTime() - definition.lease().staleAfterMs);
	const where = options.where as ((jobs: JobShape) => SQL) | undefined;

	const outcome = db.transaction((tx) => {
		const queuedFailed: string[] = [];

		if (options.queuedOlderThan) {
			const failure = options.queuedFailure ?? {
				code: "worker_queue_timeout",
				message: "The job did not start before the queue timeout.",
			};
			const old = tx
				.select()
				.from(jobs)
				.where(
					and(
						eq(jobs.status, "queued"),
						lt(jobs.updatedAt, options.queuedOlderThan),
						where?.(jobs),
					),
				)
				.all();
			for (const job of old) {
				const settled = tx
					.update(jobs)
					.set({
						status: "failed",
						errorCode: failure.code,
						errorMessage: failure.message,
						retryable: failure.retryable ?? true,
						runAfter: null,
						checkpoint: null,
						completedAt: now,
						updatedAt: now,
					})
					.where(and(eq(jobs.id, job.id), eq(jobs.status, "queued")))
					.run();
				if (settled.changes === 0) continue;
				const row = tx.select().from(jobs).where(eq(jobs.id, job.id)).get();
				if (row) definition.onTransition?.(tx, row, "failed");
				queuedFailed.push(job.id);
			}
		}

		const stale = takeBackInTx(
			tx,
			kind,
			{ reason: "stale", staleBefore, where },
			now,
		);
		const lost = takeBackInTx(
			tx,
			kind,
			{ reason: "state-lost", updatedBefore: staleBefore, where },
			now,
		);
		return { queuedFailed, taken: [...stale, ...lost] };
	});

	for (const jobId of outcome.queuedFailed) {
		emitSettled(definition.name, jobId, "failed");
	}
	afterTakeBack(definition.name, outcome.taken);
	return { recovered: outcome.queuedFailed.length + outcome.taken.length };
}
