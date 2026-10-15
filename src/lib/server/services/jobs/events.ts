// In-process settle events.
//
// A transition that settles a job (`succeed`, `fail` without a requeue,
// `cancel`, a take-back, a job born settled) announces it here, after the commit,
// so a caller waiting for the verdict hears about it at once instead of on its
// next poll. The announcement is a convenience and never the truth: the row is,
// and `waitForVerdict` polls it as a fallback for a verdict written by another
// connection or another process.

import { jobsState, type SettleEventListener } from "./state";
import type { JobStatus } from "./types";

function key(kindName: string, jobId: string): string {
	return `${kindName}:${jobId}`;
}

/** Listens for a job's verdict. Returns the function that stops listening. */
export function onSettled(
	kindName: string,
	jobId: string,
	listener: SettleEventListener,
): () => void {
	const { settleListeners } = jobsState();
	const id = key(kindName, jobId);
	let listeners = settleListeners.get(id);
	if (!listeners) {
		listeners = new Set();
		settleListeners.set(id, listeners);
	}
	listeners.add(listener);

	return () => {
		const current = settleListeners.get(id);
		if (!current) return;
		current.delete(listener);
		if (current.size === 0) settleListeners.delete(id);
	};
}

/**
 * Says a job settled. Call it AFTER the transaction that settled it committed:
 * a listener that read the row on hearing this must find the verdict there.
 * A listener that throws is its own problem and never reaches the transition.
 */
export function emitSettled(
	kindName: string,
	jobId: string,
	status: JobStatus,
): void {
	const listeners = jobsState().settleListeners.get(key(kindName, jobId));
	if (!listeners) return;
	for (const listener of [...listeners]) {
		try {
			listener({ kind: kindName, jobId, status });
		} catch (error) {
			console.error("[JOBS] Settle listener failed", {
				kindName,
				jobId,
				error,
			});
		}
	}
}
