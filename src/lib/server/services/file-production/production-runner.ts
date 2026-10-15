// The file-production handler: one claimed attempt of a file-production job.
//
// The job engine (services/jobs) claims the job (one at a time, install-wide), keeps
// its lease alive on a timer of its own, decides what a failure means (never a
// requeue, ADR-0005: `production-job.ts`'s `onFailure`) and takes an attempt back
// when its worker is gone; this file is only the work: run the persisted request
// (a report renderer, the sandbox, or inline text), store what it made, write the
// verdict. It is loaded on the first claim, so a route that reads, retries or
// cancels a job never imports a renderer, the sandbox client or the chat-file store.
//
// Every write the run makes goes through the context and is fenced: a run that lost
// the job (cancelled, or taken back) gets `false` and writes nothing, and its signal
// is already aborted. The renderers and the sandbox take that signal, so a cancel
// reaches the work in flight at once. No engine transaction is held across an
// `await` on a renderer: the work runs between transactions, never inside one.

import type { fileProductionJobs } from "$lib/server/db/schema";
import { FILE_PRODUCTION_ATTEMPT_WARNINGS_KEY } from "$lib/server/services/file-production/types";
import type { JobRunContext } from "$lib/server/services/jobs";
import { executePersistedFileProductionRequest } from "./execution-adapter";
import { linkProducedFilesToJob } from "./job-links";
import {
	storeFileProductionOutputs,
	syncFileProductionOutputsToMemory,
} from "./storage-adapter";

/**
 * One attempt. Returns when the attempt has written its verdict (a success, or a
 * failure the policy decided) or when it was told to stop; a return with neither
 * is turned into a failure by the engine.
 */
export async function runFileProduction(
	ctx: JobRunContext<typeof fileProductionJobs>,
): Promise<void> {
	const job = ctx.row;

	const execution = await executePersistedFileProductionRequest({
		requestJson: job.requestJson,
		userId: job.userId,
		conversationId: job.conversationId,
		assistantMessageId: job.assistantMessageId,
		fileProductionJobId: job.id,
		title: job.title,
		documentIntent: job.documentIntent,
		// One controller per ATTEMPT: aborted the moment the claim is gone, which is
		// what a user cancel and a stale reclaim both look like from here. It reaches
		// every renderer, the inline_text writer and the sandbox container.
		signal: ctx.signal,
	});
	if (!execution.ok) {
		await ctx.fail({
			code: execution.errorCode,
			message: execution.errorMessage,
			retryable: execution.retryable,
		});
		return;
	}

	// The work can take minutes. Before anything is stored, ask whether the job is
	// still ours: a cancel that landed while it ran (in this process the signal is
	// already aborted; in another one this write is what finds out) must not leave a
	// file in a conversation whose card says "cancelled". A fenced beat with nothing
	// to say; false means the claim is gone.
	if (!(await ctx.progress({}))) return;

	const stored = await storeFileProductionOutputs({
		job,
		attemptId: ctx.attempt.id,
		request: execution.request,
		executionResult: execution.execution,
		sourceArtifact: execution.sourceArtifact,
		now: new Date(),
	});
	if (!stored.ok) {
		await ctx.fail({
			code: stored.errorCode,
			message: stored.errorMessage,
			retryable: stored.retryable,
			diagnostics: stored.diagnostics,
		});
		return;
	}

	const { producedFiles } = stored;
	const warnings = (execution.warnings ?? []).filter(
		(warning) => warning.trim().length > 0,
	);
	let assistantMessageId = job.assistantMessageId;
	const completed = await ctx.succeed({
		// What a SUCCESSFUL attempt wants the person and the model to know (a program
		// that crashed after writing a valid file). The read model surfaces it as the
		// job's `warnings`, through the attempt the job still names once it settles.
		diagnostics:
			warnings.length > 0
				? { [FILE_PRODUCTION_ATTEMPT_WARNINGS_KEY]: warnings }
				: undefined,
		apply: (tx) => {
			assistantMessageId = linkProducedFilesToJob(tx, {
				jobId: job.id,
				files: producedFiles.map((file, index) => ({
					chatGeneratedFileId: file.id,
					sortOrder: index,
				})),
				createdAt: new Date(),
			}).assistantMessageId;
		},
	});
	// Cancelled (or taken back) while the last stretch ran: nobody is told it
	// succeeded and nothing more is written.
	if (!completed) return;

	await syncFileProductionOutputsToMemory({
		job: {
			id: job.id,
			userId: job.userId,
			conversationId: job.conversationId,
			assistantMessageId,
			origin: job.origin,
		},
		producedFiles,
	});
}
