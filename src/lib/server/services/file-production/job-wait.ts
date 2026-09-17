// Poll a file-production job until it reaches a terminal state.
//
// The ledger is the only place a job's verdict exists: the worker runs
// detached from whoever submitted the intake, and a failed attempt is a pure
// DB write (job-ledger.ts `failFileProductionJobAttempt`) with no stream part
// and no callback. Both callers that need a verdict rather than a receipt —
// Atlas's output-file step and the chat tool's `produce_file` — therefore have
// to watch the ledger, so the loop lives here once instead of twice.
//
// Deliberately dependency-free: the job lookup, the clock and the sleep are
// all injected, so this module imports no DB and tests can drive it without
// real timers.

import type { FileProductionJob, FileProductionJobStatus } from "./types";

export type FileProductionJobLookup = () => Promise<FileProductionJob | null>;

export interface WaitForFileProductionJobVerdictInput {
	/** Reads the job's CURRENT ledger row. Called once immediately, then per poll. */
	getJob: FileProductionJobLookup;
	/** Upper bound on the whole wait, measured from the first poll. */
	timeoutMs: number;
	pollIntervalMs: number;
	/** Injectable clock/sleep so tests never wait on real time. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Aborting stops the wait and reports the last seen job as non-terminal. */
	signal?: AbortSignal;
}

export type FileProductionJobVerdict =
	| { settled: true; job: FileProductionJob }
	| { settled: false; job: FileProductionJob | null };

export function isTerminalFileProductionJobStatus(
	status: FileProductionJobStatus,
): boolean {
	return (
		status === "succeeded" || status === "failed" || status === "cancelled"
	);
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Resolves as soon as the job is succeeded / failed / cancelled, or when the
 * bound elapses. Never throws for a still-running job — an unsettled verdict is
 * a legitimate outcome that callers must report honestly. A lookup that throws
 * is treated as "not known yet" and retried, so one flaky read does not turn a
 * running job into a reported failure.
 */
export async function waitForFileProductionJobVerdict(
	input: WaitForFileProductionJobVerdictInput,
): Promise<FileProductionJobVerdict> {
	const now = input.now ?? (() => Date.now());
	const sleep = input.sleep ?? defaultSleep;
	const deadline = now() + Math.max(0, input.timeoutMs);
	let latestJob: FileProductionJob | null = null;

	for (;;) {
		if (input.signal?.aborted) {
			return { settled: false, job: latestJob };
		}
		try {
			latestJob = await input.getJob();
		} catch {
			// Keep the previous observation; a transient read failure must not be
			// reported to the caller as a verdict.
		}
		if (latestJob && isTerminalFileProductionJobStatus(latestJob.status)) {
			return { settled: true, job: latestJob };
		}

		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			return { settled: false, job: latestJob };
		}
		await sleep(Math.min(Math.max(1, input.pollIntervalMs), remainingMs));
	}
}
