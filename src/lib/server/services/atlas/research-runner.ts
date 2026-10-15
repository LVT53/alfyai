// The Atlas handler: one claimed attempt of an Atlas research job.
//
// The job engine (services/jobs) claims the job, keeps its lease alive on a timer
// of its own, and decides what a failure means; this file is only the work. It is
// loaded on the first claim (`research-job.ts`), so a route that reads or cancels
// Atlas jobs never imports the v3 pipeline.
//
// Every write the run makes goes through the context and is fenced: a run that
// lost the job (cancelled, or taken back) gets `false` and writes nothing. The
// pipeline does not take the engine's signal (threading it through `atlas-v3/` is
// a separate job), so a cancel reaches it at its next progress report, which is
// refused here and stops the run, as it always did.

import { eq } from "drizzle-orm";
import type { ModelId } from "$lib/model-types";
import { getConfig, isModelEnabled } from "$lib/server/config-store";
import { atlasJobs } from "$lib/server/db/schema";
import { recordAtlasJobAnalytics } from "$lib/server/services/analytics";
import { notifyAtlasCompletion } from "$lib/server/services/browser-push";
import type { JobRunContext } from "$lib/server/services/jobs";
import { noteAtlasProgressSources } from "$lib/server/services/url-provenance";
import { AtlasV3PipelineError } from "../atlas-v3/types";
import { runAtlasV3PipelineForClaimedJob } from "../atlas-v3/worker-bindings";
import { buildAtlasLifecycleContext } from "./checkpoints";
import { resolveAtlasKickoffMessage } from "./kickoff-message";
import {
	mapAtlasJobRowToCard,
	sanitizeAtlasJobProgressDetails,
} from "./read-model";

export function resolveAuditModelSelection(input: {
	synthesisModel: ModelId;
	auditModel: ModelId;
	config: ReturnType<typeof getConfig>;
}): { modelSelection: ModelId; warning: string | null } {
	if (input.auditModel !== input.synthesisModel) {
		return { modelSelection: input.auditModel, warning: null };
	}
	if (input.synthesisModel !== "model1" && input.synthesisModel !== "model2") {
		return { modelSelection: input.auditModel, warning: null };
	}
	const fallbackModel = input.synthesisModel === "model1" ? "model2" : "model1";
	if (isModelEnabled(fallbackModel, input.config)) {
		return { modelSelection: fallbackModel, warning: null };
	}
	return {
		modelSelection: input.synthesisModel,
		warning:
			"Atlas audit used the synthesis model because no distinct audit model is enabled.",
	};
}

/**
 * Atlas runs pipeline v3 exclusively (Phase B of the v3-only consolidation).
 * The engine's claim restamps every claimed row's `pipelineVersion` to
 * `ATLAS_CURRENT_PIPELINE_VERSION` (the kind's `onTransition`), so dispatch here
 * does not need to branch on it: a queued v1/v2 row (a Continue child queued
 * before the deploy, or a job the engine put back in the queue) simply runs fresh
 * on v3.
 */
export async function runAtlasResearch(
	ctx: JobRunContext<typeof atlasJobs>,
): Promise<void> {
	const identity = {
		jobId: ctx.row.id,
		attemptId: ctx.attempt.id,
		attempt: ctx.attempt.number,
	};
	console.info("[ATLAS] Claimed job", identity);

	try {
		await runAtlasV3Attempt(ctx);
	} catch (error) {
		// ADR 0063 raises its own coded failures: an empty verdict is a FAILED job
		// on v3, not a report that silently ships without an opening.
		const v3Error = error instanceof AtlasV3PipelineError ? error : null;
		await ctx.fail({
			code: v3Error?.code ?? "atlas_pipeline_failed",
			message:
				error instanceof Error ? error.message : "Atlas pipeline failed.",
			retryable: true,
		});
		// A run that was told to stop (cancelled, or taken back) fails by design
		// at its next write; the engine says so, and a second line here would only
		// repeat it.
		if (!ctx.signal.aborted) {
			console.warn("[ATLAS] Job failed", { ...identity, error });
		}
	}
}

async function runAtlasV3Attempt(
	ctx: JobRunContext<typeof atlasJobs>,
): Promise<void> {
	const { row } = ctx;
	const job = mapAtlasJobRowToCard(row);
	const identity = { jobId: job.id, attemptId: ctx.attempt.id };
	const config = getConfig();

	const resolved = await resolveAtlasKickoffMessage(job);
	const query = resolved.query?.trim() ?? "";
	if (!query) {
		throw new Error("Atlas kickoff message query could not be resolved.");
	}
	const lifecycle = await buildAtlasLifecycleContext({
		jobId: job.id,
		userId: row.userId,
		action: job.action,
		parentAtlasJobId: job.parentAtlasJobId,
	});
	const auditModel = resolveAuditModelSelection({
		synthesisModel: config.atlasSynthesisModel,
		auditModel: config.atlasAuditModel,
		config,
	});

	// The title the notification carries is the one now stored: the claimed row's,
	// or the model's, once the pipeline has applied it.
	let title = job.title;

	const result = await runAtlasV3PipelineForClaimedJob({
		job: {
			id: job.id,
			userId: row.userId,
			conversationId: job.conversationId,
			assistantMessageId: job.assistantMessageId,
			action: job.action,
			parentAtlasJobId: job.parentAtlasJobId,
			profile: job.profile,
			title: job.title,
			query,
			lifecycle,
			kickoffUserMessageId: resolved.userMessageId,
		},
		now: new Date(),
		synthesisModel: config.atlasSynthesisModel,
		auditModel: auditModel.modelSelection,
		heartbeat: async ({ stage, progressPercent, progressDetails }) => {
			const alive = await ctx.write((tx) => {
				tx.update(atlasJobs)
					.set({
						stage,
						progressPercent,
						...(progressDetails !== undefined
							? {
									progressDetailsJson: JSON.stringify(
										sanitizeAtlasJobProgressDetails(progressDetails),
									),
								}
							: {}),
					})
					.where(eq(atlasJobs.id, row.id))
					.run();
			});
			if (!alive) {
				throw new Error("Atlas job is no longer running.");
			}
			// The card draws each web source's icon through the favicon proxy, which
			// answers only for a host a tool returned to this user: the sources this
			// report carries are results of the run's own searches, so they are noted
			// as the report is stored (docs/plans/exfil-channels).
			noteAtlasProgressSources(row.userId, progressDetails);
		},
		applyGeneratedTitle: async ({ title: generated }) => {
			const cleaned = generated.replace(/\s+/g, " ").trim();
			if (!cleaned) return;
			const applied = await ctx.write((tx) => {
				tx.update(atlasJobs)
					.set({ title: cleaned })
					.where(eq(atlasJobs.id, row.id))
					.run();
			});
			if (!applied) {
				throw new Error("Atlas job is no longer running.");
			}
			title = cleaned;
		},
	});

	const completed = await ctx.succeed({
		apply: (tx) => {
			tx.update(atlasJobs)
				.set({
					stage: result.stage,
					progressPercent: 100,
					inputTokens: result.usage.inputTokens,
					outputTokens: result.usage.outputTokens,
					totalTokens: result.usage.totalTokens,
					costUsdMicros: result.usage.costUsdMicros,
					localSourceCount: result.sourceCounts.local,
					webSourceCount: result.sourceCounts.web,
					acceptedSourceCount: result.sourceCounts.accepted,
					rejectedSourceCount: result.sourceCounts.rejected,
					fileProductionJobId: result.outputs.fileProductionJobId,
					htmlChatGeneratedFileId: result.outputs.htmlChatGeneratedFileId,
					pdfChatGeneratedFileId: result.outputs.pdfChatGeneratedFileId,
					markdownChatGeneratedFileId:
						result.outputs.markdownChatGeneratedFileId,
				})
				.where(eq(atlasJobs.id, row.id))
				.run();
		},
	});
	if (!completed) {
		// Cancelled (or taken back) while the last stretch ran: the report is not
		// written over the new verdict, and nobody is told it is ready.
		console.info("[ATLAS v3] Skipped completion for inactive job", identity);
		return;
	}

	await recordAtlasJobAnalytics({
		userId: row.userId,
		conversationId: job.conversationId,
		atlasJobId: job.id,
		assistantMessageId: job.assistantMessageId,
		profile: job.profile,
		inputTokens: result.usage.inputTokens,
		outputTokens: result.usage.outputTokens,
		totalTokens: result.usage.totalTokens,
		costUsdMicros: result.usage.costUsdMicros,
	}).catch((error) => {
		console.warn("[ATLAS v3] Failed to record job analytics", {
			jobId: job.id,
			error,
		});
	});
	void notifyAtlasCompletion({
		userId: row.userId,
		conversationId: job.conversationId,
		jobId: job.id,
		title,
	});
	console.info("[ATLAS v3] Completed job", {
		...identity,
		abstained: result.abstained,
		diagnostics: result.diagnostics,
	});
}
