// Waiting for a job's verdict.
//
// A caller that has to know how a job ended (a chat turn that needs a document's
// text, an upload that wants to answer "ready") used to poll the row every
// 100 ms in a loop of its own, one copy per kind. Here it listens for the
// engine's settle event, which this process announces right after the commit
// that settles a job, so a verdict written by the same process arrives at once;
// and it polls the row once a second as the fallback for a verdict written by
// another connection or another process, which no event reaches.
//
// A requeue is not a verdict: the job is `queued` again, and the wait goes on.

import { onSettled } from "./events";
import { readJobRow } from "./ledger";
import {
	isTerminalJobStatus,
	type JobKind,
	type JobStatus,
	type VerdictResult,
} from "./types";

/** How often the row is read when no event arrives. */
const POLL_MS = 1_000;

export function waitForVerdict(
	kind: JobKind,
	jobId: string,
	options: { timeoutMs: number; signal?: AbortSignal },
): Promise<VerdictResult> {
	let lastStatus: JobStatus | null = null;

	/** Reads the row. Null when it cannot be read right now: the next poll tries again. */
	const look = (): { status: JobStatus | null; known: boolean } => {
		try {
			const row = readJobRow(kind, jobId);
			lastStatus = row ? (row.status as JobStatus) : null;
			return { status: lastStatus, known: true };
		} catch {
			return { status: lastStatus, known: false };
		}
	};

	const first = look();
	if (first.status === null && first.known) {
		return Promise.resolve({ settled: false, status: null });
	}
	if (first.status !== null && isTerminalJobStatus(first.status)) {
		return Promise.resolve({ settled: true, status: first.status });
	}
	if (options.timeoutMs <= 0 || options.signal?.aborted) {
		return Promise.resolve({ settled: false, status: lastStatus });
	}

	return new Promise<VerdictResult>((resolve) => {
		let done = false;
		const cleanups: Array<() => void> = [];

		const finish = (result: VerdictResult): void => {
			if (done) return;
			done = true;
			for (const cleanup of cleanups) cleanup();
			resolve(result);
		};

		// By event: the verdict is on the row by the time anyone hears of it.
		cleanups.push(
			onSettled(kind.name, jobId, (event) => {
				lastStatus = event.status;
				finish({ settled: true, status: event.status });
			}),
		);

		// By poll: a verdict nobody announced to this process.
		let poll: ReturnType<typeof setTimeout> | null = null;
		const schedulePoll = (): void => {
			poll = setTimeout(() => {
				const seen = look();
				if (seen.status !== null && isTerminalJobStatus(seen.status)) {
					finish({ settled: true, status: seen.status });
					return;
				}
				schedulePoll();
			}, POLL_MS);
			poll.unref?.();
		};
		schedulePoll();
		cleanups.push(() => {
			if (poll) clearTimeout(poll);
		});

		// Out of time, or told to stop: one more look, then say what was seen last.
		const concludeUnsettled = (): void => {
			const seen = look();
			if (seen.status !== null && isTerminalJobStatus(seen.status)) {
				finish({ settled: true, status: seen.status });
				return;
			}
			finish({ settled: false, status: lastStatus });
		};

		// By the clock.
		const timeout = setTimeout(concludeUnsettled, options.timeoutMs);
		timeout.unref?.();
		cleanups.push(() => clearTimeout(timeout));

		// By the caller's signal.
		const signal = options.signal;
		if (signal) {
			signal.addEventListener("abort", concludeUnsettled, { once: true });
			cleanups.push(() =>
				signal.removeEventListener("abort", concludeUnsettled),
			);
		}
	});
}
