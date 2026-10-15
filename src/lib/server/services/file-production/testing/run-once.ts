// Runs the file-production kind over a test's database and says what came of it.
//
// The worker this replaced had `executeNextFileProductionJob`, which took its
// sandbox, its chat-file store and its limits as arguments and answered the job it
// had made and the files, or null when nothing was made; and
// `drainFileProductionWorker`, which ran everything claimable. The job engine runs
// every claimable job (`drain`) and answers nothing, so a test that wants the old
// shape asks here: the seams are laid over the real modules for the length of the
// run (`runner-seams.ts`), and the job that ran is the one whose attempt count grew.
//
// Everything below imports the app AFTER the test reset the module registry (a
// dynamic `import()` inside the function), so it finds the database the test made.

import type { FileProductionJob } from "../types";
import { installSeams, type RunnerSeams, seams } from "./runner-seams";

export interface RunOptions {
	executeCode?: NonNullable<RunnerSeams["executeCode"]>;
	storeGeneratedFile?: NonNullable<RunnerSeams["storeGeneratedFile"]>;
	syncGeneratedFilesToMemory?: NonNullable<
		RunnerSeams["syncGeneratedFilesToMemory"]
	>;
	limits?: NonNullable<RunnerSeams["limits"]>;
}

export interface RunNextResult {
	job: FileProductionJob;
	files: FileProductionJob["files"];
}

async function drainWith(options: RunOptions): Promise<void> {
	await installSeams();
	const saved = {
		executeCode: seams.executeCode,
		storeGeneratedFile: seams.storeGeneratedFile,
		syncGeneratedFilesToMemory: seams.syncGeneratedFilesToMemory,
		limits: seams.limits,
	};
	if (options.executeCode) seams.executeCode = options.executeCode;
	if (options.storeGeneratedFile) {
		seams.storeGeneratedFile = options.storeGeneratedFile;
	}
	if (options.syncGeneratedFilesToMemory) {
		seams.syncGeneratedFilesToMemory = options.syncGeneratedFilesToMemory;
	}
	if (options.limits) seams.limits = options.limits;
	seams.producedFiles = null;
	try {
		const { drain } = await import("$lib/server/services/jobs");
		const { fileProductionJob } = await import("../production-job");
		await drain(fileProductionJob);
	} finally {
		seams.executeCode = saved.executeCode;
		seams.storeGeneratedFile = saved.storeGeneratedFile;
		seams.syncGeneratedFilesToMemory = saved.syncGeneratedFilesToMemory;
		seams.limits = saved.limits;
	}
}

/** Runs every claimable job, one at a time, with the test's fakes laid over the real modules. */
export async function drainFileProductionJobs(
	options: RunOptions = {},
): Promise<void> {
	await drainWith(options);
}

/**
 * Runs the one claimable job and answers it as the worker did: the job's card and
 * the files it made when it succeeded, null when it failed, was cancelled or there
 * was nothing to run. More than one job running where a test expected one is the
 * test's mistake, and says so.
 */
export async function runNextFileProductionJob(
	options: RunOptions = {},
): Promise<RunNextResult | null> {
	const { db } = await import("$lib/server/db");
	const { fileProductionJobs } = await import("$lib/server/db/schema");
	const { getConversationFileProductionJob } = await import("../read-model");
	const counts = () =>
		new Map(
			db
				.select({
					id: fileProductionJobs.id,
					userId: fileProductionJobs.userId,
					conversationId: fileProductionJobs.conversationId,
					status: fileProductionJobs.status,
					attemptCount: fileProductionJobs.attemptCount,
				})
				.from(fileProductionJobs)
				.all()
				.map((row) => [row.id, row] as const),
		);
	const before = counts();

	await drainWith(options);

	const ran = [...counts().values()].filter(
		(row) => row.attemptCount > (before.get(row.id)?.attemptCount ?? 0),
	);
	if (ran.length === 0) return null;
	if (ran.length > 1) {
		throw new Error(
			`runNextFileProductionJob: ${ran.length} jobs ran where the test expected one.`,
		);
	}
	const [only] = ran;
	if (only.status !== "succeeded") return null;
	const job = await getConversationFileProductionJob({
		userId: only.userId,
		conversationId: only.conversationId,
		jobId: only.id,
	});
	if (!job) return null;
	return { job, files: seams.producedFiles ?? job.files };
}
