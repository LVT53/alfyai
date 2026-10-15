// The job engine: the only import path for every caller.
//
// A kind is defined once, in its own folder (`atlas/`, `extraction/`,
// `file-production/`), with `defineJobKind`; its tables are built with
// `jobColumns` and `jobAttemptColumns`. Everything that changes a job's
// lifecycle or decides when it runs is below this file and nowhere else. This
// file imports no kind and no handler: a kind's definition loads its handler
// lazily, on the first claim.

import { describeJob as describe, enqueueJob } from "./ledger";
import { wake } from "./scheduler";
import type { EnqueueInput, JobKind, JobTable, Row, ShapeRow } from "./types";

export {
	jobAttemptColumns,
	jobAttemptIndexes,
	jobColumns,
	liveClaimIndex,
} from "./columns";
export { defineJobKind } from "./define";
export {
	drain,
	inspectJobsForTests,
	resetJobsForTests,
	wake,
} from "./scheduler";
export type * from "./types";

export const describeJob = describe;

/**
 * Creates a job, or finds the one this request repeats, and wakes the kind.
 * A job born settled wakes nothing.
 */
export async function enqueue<J extends JobTable>(
	kind: JobKind<J>,
	input: EnqueueInput<J>,
): Promise<{ row: Row<J>; reused: boolean }> {
	const result = enqueueJob(kind, input);
	if ((result.row as unknown as ShapeRow).status === "queued") wake(kind);
	return result;
}
