// Runs ONE claimed attempt: builds the handler's context, keeps the lease alive
// on a timer of its own, aborts the handler when the lease is gone, and turns
// the way the handler ended into a verdict.
//
// The heartbeat is the runner's and not the handler's. It used to be the
// handler's job to report progress, which made the lease measure how long a step
// took: a model call with no timeout, or a long render, looked exactly like a
// dead worker. A timer that beats while the handler is busy makes the lease
// measure what it is for, whether the PROCESS is alive. Cancel still reaches a
// run that is blocked on something that never answers, because `cancel` aborts
// the signal at once, from outside.

import type { JobShape } from "./columns";
import { internalsOf, loadHandler } from "./define";
import {
	beat,
	fail,
	type ProgressUpdate,
	progress,
	readJobRow,
	type SucceedOptions,
	succeed,
	write,
} from "./ledger";
import { jobsState } from "./state";
import type {
	Claimed,
	FailOutcome,
	JobAbortReason,
	JobFailure,
	JobKind,
	JobRunContext,
	OwnedAttempt,
	Tx,
} from "./types";

/** A beat faster than this is a waste of writes, whatever the kind asks for. */
const MIN_HEARTBEAT_MS = 250;

const NOT_APPLIED: FailOutcome = {
	applied: false,
	requeued: false,
	runAfter: null,
};

function messageOf(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	if (typeof error === "string" && error) return error;
	return "The job failed.";
}

export interface RunAttemptOptions {
	/** The worker id the claim was made under: the fencing token's second half. */
	workerId: string;
}

/**
 * Never rejects: a drain that dies on one job's bookkeeping would stop the whole
 * kind. Whatever goes wrong is logged, and a job left `running` by it is exactly
 * what the stale sweep exists for.
 */
export async function runAttempt(
	kind: JobKind,
	claimed: Claimed,
	options: RunAttemptOptions,
): Promise<void> {
	try {
		await run(kind, claimed, options);
	} catch (error) {
		console.error(`${kind.logPrefix} Attempt run failed`, {
			jobId: claimed.row.id,
			attemptId: claimed.attempt.id,
			error,
		});
	}
}

async function run(
	kind: JobKind,
	claimed: Claimed,
	options: RunAttemptOptions,
): Promise<void> {
	const internals = internalsOf(kind);
	const { definition } = internals;
	const prefix = definition.logPrefix;
	const owned: OwnedAttempt = {
		jobId: claimed.row.id,
		attemptId: claimed.attempt.id,
		workerId: options.workerId,
	};
	const identity = {
		jobId: owned.jobId,
		attemptId: owned.attemptId,
		attemptNumber: claimed.attempt.number,
	};
	const startedAtMs = Date.now();
	const controller = new AbortController();
	const { signal } = controller;

	/** The handler has written a verdict (a success, or a failure the policy decided). */
	let verdictWritten = false;
	/** The last time a beat, a progress report or a domain write reached the row. */
	let lastBeatOkAtMs = startedAtMs;

	const abort = (reason: JobAbortReason): void => {
		if (!signal.aborted) controller.abort(reason);
	};

	/**
	 * The run has nothing left to write: it was told to stop, or it has written its
	 * verdict. A handler may still be tidying up after `succeed()`; what it asks
	 * the context to do then is refused quietly, and it is not aborted for it.
	 */
	const finished = (): boolean => signal.aborted || verdictWritten;

	/** The claim is gone: say why. A cancel is not a lost lease, and a handler cares. */
	const abortBecauseClaimIsGone = (): void => {
		let reason: JobAbortReason = "lease-lost";
		try {
			if (readJobRow(kind, owned.jobId)?.status === "cancelled") {
				reason = "cancelled";
			}
		} catch {
			// The row cannot be read right now; the conservative answer is that the
			// lease is lost, which is also what a handler that cannot tell does.
		}
		abort(reason);
	};

	const lease = definition.lease();
	const heartbeat = setInterval(
		() => {
			// Once aborted the run is over for writes. A beat that came back to life
			// after the runner gave up on the lease would keep an abandoned attempt
			// looking alive and keep the sweep from ever taking it back. And once the
			// verdict is written there is no claim left to prove: a beat would find the
			// job settled and abort a handler that is only tidying up.
			if (finished()) return;
			try {
				if (beat(kind, owned)) {
					lastBeatOkAtMs = Date.now();
					return;
				}
				abortBecauseClaimIsGone();
			} catch (error) {
				// Nothing awaits this timer, so a throw here would be an unhandled
				// rejection, which Node 22 turns into a process exit: the whole
				// server taken down for a liveness ping. A write that fails (the
				// database busy) is survived until half the stale window has passed
				// without one succeeding; then the run stops itself, because after
				// the whole window the sweep takes the attempt anyway.
				console.warn(`${prefix} Heartbeat write failed`, {
					...identity,
					error,
				});
				if (Date.now() - lastBeatOkAtMs >= lease.staleAfterMs / 2) {
					abort("lease-lost");
				}
			}
		},
		Math.max(MIN_HEARTBEAT_MS, lease.heartbeatMs),
	);
	heartbeat.unref?.();

	jobsState().running.set(owned.attemptId, {
		kindName: kind.name,
		jobId: owned.jobId,
		controller,
	});

	/** One line per failed attempt, and a second when the failure was the end of the job. */
	const logFailure = (failure: JobFailure, outcome: FailOutcome): void => {
		try {
			console.warn(`${prefix} Attempt failed`, {
				...identity,
				errorCode: failure.code,
				retryable: failure.retryable,
				requeued: outcome.requeued,
				nextAttemptAt: outcome.runAfter?.toISOString() ?? null,
				durationMs: Date.now() - startedAtMs,
			});
			if (outcome.requeued) return;
			// Re-read rather than re-derive: the policy already decided inside the
			// transaction, and a copy of its arithmetic in a log helper is a copy that
			// can disagree with the row a person is looking at.
			const row = readJobRow(kind, owned.jobId);
			if (row?.errorCode === "max_attempts") {
				console.warn(`${prefix} Job reached max attempts`, {
					jobId: owned.jobId,
					attemptCount: row.attemptCount,
					retryable: row.retryable,
				});
			} else if (row && !row.retryable) {
				console.warn(`${prefix} Job will not be retried`, {
					jobId: owned.jobId,
					errorCode: row.errorCode,
				});
			}
		} catch {
			// A log line never decides anything.
		}
	};

	/** Writes a failure through the policy, and remembers that the run has its verdict. */
	const settleFailure = (
		failure: JobFailure,
		applyOptions?: { apply?: (tx: Tx) => void },
	): FailOutcome => {
		const outcome = fail(kind, owned, failure, applyOptions);
		if (!outcome.applied) {
			abortBecauseClaimIsGone();
			return outcome;
		}
		verdictWritten = true;
		logFailure(failure, outcome);
		return outcome;
	};

	/**
	 * A handler may fire and forget (`void ctx.progress(...)`), the way an
	 * extractor's synchronous progress callback has to. A write that fails (the
	 * database busy) would then be an unhandled rejection, which Node 22 turns into
	 * a process exit: the whole server taken down for a status line nobody waited
	 * on. Attaching a handler here marks the promise handled; a handler that does
	 * await it still sees the rejection.
	 */
	const observed = <Args extends unknown[], Result>(
		what: string,
		work: (...args: Args) => Promise<Result>,
	) => {
		return (...args: Args): Promise<Result> => {
			const promise = work(...args);
			promise.catch((error: unknown) => {
				console.warn(`${prefix} ${what} failed`, { ...identity, error });
			});
			return promise;
		};
	};

	const ctx: JobRunContext<JobShape> = {
		row: claimed.row,
		attempt: { id: claimed.attempt.id, number: claimed.attempt.number },
		signal,
		progress: observed("Progress write", async (update: ProgressUpdate) => {
			if (finished()) return false;
			const result = progress(kind, owned, update);
			if (result === "applied") {
				lastBeatOkAtMs = Date.now();
				return true;
			}
			if (result === "lost") abortBecauseClaimIsGone();
			return false;
		}),
		write: observed("Domain write", async (apply: (tx: Tx) => void) => {
			if (finished()) return false;
			if (write(kind, owned, apply)) {
				lastBeatOkAtMs = Date.now();
				return true;
			}
			abortBecauseClaimIsGone();
			return false;
		}),
		succeed: observed(
			"Success write",
			async (succeedOptions?: SucceedOptions) => {
				if (finished()) return false;
				if (succeed(kind, owned, succeedOptions)) {
					verdictWritten = true;
					return true;
				}
				abortBecauseClaimIsGone();
				return false;
			},
		),
		fail: observed(
			"Failure write",
			async (
				failure: JobFailure,
				failOptions?: { apply?: (tx: Tx) => void },
			) => {
				if (finished()) return NOT_APPLIED;
				return settleFailure(failure, failOptions);
			},
		),
	};

	try {
		const handler = await loadHandler(internals);
		await handler(ctx);
		if (!finished()) {
			// It returned and said nothing. The job must not stay `running` and hold a
			// slot for the length of the stale window, so it fails, through the policy.
			settleFailure({
				code: "no_verdict",
				message: "The job stopped without a result.",
				retryable: true,
			});
		}
	} catch (error) {
		// A throw after an abort is the abort's doing (a fetch cancelled, a stream
		// closed), not the job's: the verdict belongs to whoever holds the job now.
		// A throw after the verdict (a handler that failed the job and then threw) has
		// nothing left to say either.
		if (!finished()) {
			try {
				settleFailure({
					code: "job_failed",
					message: messageOf(error),
					retryable: true,
				});
			} catch (settleError) {
				console.error(`${prefix} Could not record a failed attempt`, {
					...identity,
					error: settleError,
				});
			}
		}
	} finally {
		clearInterval(heartbeat);
		jobsState().running.delete(owned.attemptId);
	}

	if (signal.aborted) {
		const durationMs = Date.now() - startedAtMs;
		if (signal.reason === "cancelled") {
			console.info(`${prefix} Cancel honoured`, { ...identity, durationMs });
		} else {
			// We stopped, and NOT because anyone asked for the job to stop: the claim
			// was taken from us, or the beats stopped landing. Writing "failed" here
			// would assert a verdict over whoever holds the claim now, and would fail
			// a job permanently over a busy database. The sweep requeues it.
			console.warn(`${prefix} Attempt released without a verdict`, {
				...identity,
				durationMs,
			});
		}
	}
}
