// Poll an extraction job until it reaches a terminal state.
//
// A structural copy of `file-production/job-wait.ts`, not a shared generic:
// ADR-0005 scopes that module to file production, and the two terminal sets
// genuinely differ (`cancelled` there, `canceled` here). A generic over both
// would have to be parameterised by its own status vocabulary, which is all the
// file is.
//
// Deliberately dependency-free: the job lookup, the clock and the sleep are all
// injected, so this module imports no DB and tests drive it without real timers.

import type { DocumentExtractionJobDTO } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";

export type ExtractionJobLookup =
	() => Promise<DocumentExtractionJobDTO | null>;

export type ExtractionJobVerdict =
	| { settled: true; job: DocumentExtractionJobDTO }
	| { settled: false; job: DocumentExtractionJobDTO | null };

export interface WaitForExtractionJobVerdictInput {
	/** Reads the job's CURRENT ledger row. Called once immediately, then per poll. */
	getJob: ExtractionJobLookup;
	/** Upper bound on the whole wait, measured from the first poll. */
	timeoutMs: number;
	pollIntervalMs: number;
	/** Injectable clock/sleep so tests never wait on real time. */
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Aborting stops the wait and reports the last seen job as non-terminal. */
	signal?: AbortSignal;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/**
 * Resolves as soon as the job is succeeded / failed / canceled, or when the
 * bound elapses. Never throws for a still-running job — an unsettled verdict is
 * a legitimate outcome that callers must report honestly. A lookup that throws
 * is treated as "not known yet" and retried, so one flaky read does not turn a
 * running job into a reported failure.
 */
export async function waitForExtractionJobVerdict(
	input: WaitForExtractionJobVerdictInput,
): Promise<ExtractionJobVerdict> {
	const now = input.now ?? (() => Date.now());
	const sleep = input.sleep ?? defaultSleep;
	const deadline = now() + Math.max(0, input.timeoutMs);
	let latestJob: DocumentExtractionJobDTO | null = null;

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
		if (latestJob && isTerminalExtractionStatus(latestJob.status)) {
			return { settled: true, job: latestJob };
		}

		const remainingMs = deadline - now();
		if (remainingMs <= 0) {
			return { settled: false, job: latestJob };
		}
		await sleep(Math.min(Math.max(1, input.pollIntervalMs), remainingMs));
	}
}
