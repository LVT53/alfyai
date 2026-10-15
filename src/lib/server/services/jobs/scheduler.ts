// Scheduling: who runs what, and when. (Task 2: the minimal drain only.)

import { internalsOf, loadHandler } from "./define";
import { claimNext, type SucceedOptions, succeed } from "./ledger";
import { jobsState, kindScheduler } from "./state";
import type { JobKind, JobRunContext, JobTable } from "./types";
import { createWorkerId } from "./worker-identity";

const workerIds = new Map<string, string>();

/** This process's worker id for a kind: `<kind>:<host>:<pid>:<boot-nonce>`. */
export function workerIdFor(kindName: string): string {
	let id = workerIds.get(kindName);
	if (!id) {
		id = createWorkerId(kindName);
		workerIds.set(kindName, id);
	}
	return id;
}

/**
 * Says there is work. Counts the request; a kind this process has not started
 * only counts, so a script that enqueues never becomes a second worker.
 */
export function wake(kind: JobKind): void {
	kindScheduler(kind.name).wakeRequests += 1;
}

/**
 * Runs every claimable job of the kind now, one at a time, in the caller's async
 * context. For tests and scripts; the scheduler drains on its own.
 */
export async function drain(kind: JobKind): Promise<void> {
	const internals = internalsOf(kind);
	const { definition } = internals;
	const workerId = workerIdFor(kind.name);
	const state = kindScheduler(kind.name);
	state.drainRuns += 1;

	for (;;) {
		if (!definition.enabled()) return;
		const claimed = claimNext(kind, { workerId });
		if (!claimed) return;

		const handler = await loadHandler(internals);
		const owned = {
			jobId: claimed.row.id,
			attemptId: claimed.attempt.id,
			workerId,
		};
		const ctx = {
			row: claimed.row,
			attempt: claimed.attempt,
			signal: new AbortController().signal,
			succeed: async (options?: SucceedOptions) =>
				succeed(kind, owned, options),
		} as unknown as JobRunContext<JobTable>;
		await handler(ctx as never);
	}
}

export interface KindInspection {
	running: boolean;
	wakeRequests: number;
	drainRuns: number;
}

/** Test helper: what the scheduler has done and has armed, per kind. */
export function inspectJobsForTests(): Record<string, KindInspection> {
	return Object.fromEntries(
		[...jobsState().kinds].map(([name, state]) => [
			name,
			{
				running: state.running,
				wakeRequests: state.wakeRequests,
				drainRuns: state.drainRuns,
			},
		]),
	);
}

/** Test helper: forgets every kind's state. */
export function resetJobsForTests(): void {
	jobsState().kinds.clear();
	workerIds.clear();
}
