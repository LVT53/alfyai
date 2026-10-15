// The job engine: the only import path for every caller.
//
// A kind is defined once, in its own folder (`atlas/`, `extraction/`,
// `file-production/`), with `defineJobKind`; its tables are built with
// `jobColumns` and `jobAttemptColumns`. Everything that changes a job's
// lifecycle or decides when it runs is below this file and nowhere else. This
// file imports no kind and no handler: a kind's definition loads its handler
// lazily, on the first claim.

import type { SQL } from "drizzle-orm";
import * as ledger from "./ledger";
import * as recovery from "./recovery";
import { wake } from "./scheduler";
import type {
	EnqueueInput,
	JobKind,
	JobTable,
	RecoverOptions,
	ReopenInput,
	Row,
	ShapeRow,
} from "./types";

export {
	jobAttemptColumns,
	jobAttemptIndexes,
	jobColumns,
	liveClaimIndex,
} from "./columns";
export { defineJobKind } from "./define";
export { describeJob } from "./ledger";
export {
	drain,
	inspectJobsForTests,
	resetJobsForTests,
	runInline,
	startJobs,
	stopJobs,
	wake,
} from "./scheduler";
export type * from "./types";

/**
 * Creates a job, or finds the one this request repeats, and wakes the kind.
 * A job born settled wakes nothing.
 */
export async function enqueue<J extends JobTable>(
	kind: JobKind<J>,
	input: EnqueueInput<J>,
): Promise<{ row: Row<J>; reused: boolean }> {
	const result = ledger.enqueueJob(kind, input);
	if ((result.row as unknown as ShapeRow).status === "queued") wake(kind);
	return result;
}

/**
 * The user's Cancel. Null for another user's job and for a job that has
 * settled. A run this process has going is told at once.
 */
export async function cancel<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	scope: { userId: string },
): Promise<Row<J> | null> {
	return ledger.cancel(kind, jobId, scope);
}

/**
 * Cancel over all of a user's queued and running jobs, optionally narrowed by a
 * domain condition. Returns how many it cancelled.
 */
export async function cancelAll<J extends JobTable>(
	kind: JobKind<J>,
	scope: { userId: string; where?: (jobs: J) => SQL },
): Promise<number> {
	return ledger.cancelAll(kind, scope);
}

/** The user's Retry, by the kind's `userRetry` rule. Wakes the kind. */
export async function retry<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	scope: { userId: string },
): Promise<Row<J> | null> {
	const row = ledger.retry(kind, jobId, scope);
	if (row) wake(kind);
	return row;
}

/**
 * Recovery inside a scope, for a reader that must not show stuck work (the
 * file-production fork snapshot): old queued jobs fail, stale and lost attempts
 * are taken back through the kind's policy. Wakes the kind if it did anything,
 * since a take-back can put work back in the queue.
 */
export async function recover<J extends JobTable>(
	kind: JobKind<J>,
	options: RecoverOptions<J>,
): Promise<{ recovered: number }> {
	const result = recovery.recover(kind, options);
	if (result.recovered > 0) wake(kind);
	return result;
}

/** A reopening by the kind's own rule (Regenerate, Re-extract). Wakes the kind. */
export async function reopen<J extends JobTable>(
	kind: JobKind<J>,
	jobId: string,
	input: ReopenInput<J>,
): Promise<Row<J> | null> {
	const row = ledger.reopen(kind, jobId, input);
	if (row) wake(kind);
	return row;
}
