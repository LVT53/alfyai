// A stand-in for the façade's `waitForFileProductionJobVerdict`, for the tests of
// the callers that WAIT for a verdict (the chat tool's `produce_file`, Atlas's
// output step) and mock the job lookup instead of running the job engine.
//
// The real wait listens to the engine's settle event and reads the row once a
// second (`services/jobs/wait.ts`, tested there). The callers' tests are about what
// they do with a verdict, so they hand the mocked module this: it looks the job up
// through the mock the test controls, again and again a millisecond apart, until the
// job is terminal or the bound passes. Nothing here is the engine's, and nothing in
// the app imports it.

import type {
	FileProductionJobVerdict,
	WaitForFileProductionJobVerdictInput,
} from "../production-job";
import type { FileProductionJob } from "../types";

type LookUpJob = (input: {
	userId: string;
	conversationId: string;
	jobId: string;
}) => Promise<FileProductionJob | null>;

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

export function pollingVerdictWait(lookUp: LookUpJob) {
	return async (
		input: WaitForFileProductionJobVerdictInput,
	): Promise<FileProductionJobVerdict> => {
		const deadline = Date.now() + Math.max(0, input.timeoutMs);
		let latest: FileProductionJob | null = null;
		for (;;) {
			if (input.signal?.aborted) return { settled: false, job: latest };
			try {
				latest = await lookUp({
					userId: input.userId,
					conversationId: input.conversationId,
					jobId: input.jobId,
				});
			} catch {
				// One failed read is "not known yet", never a verdict.
			}
			if (latest && TERMINAL.has(latest.status)) {
				return { settled: true, job: latest };
			}
			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) return { settled: false, job: latest };
			await new Promise((resolve) =>
				setTimeout(resolve, Math.min(1, remainingMs)),
			);
		}
	};
}
