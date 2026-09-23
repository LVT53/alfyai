import { randomUUID } from "node:crypto";
import type { ModelId } from "$lib/model-types";
import { getConfig, isModelEnabled } from "$lib/server/config-store";
import { recordAtlasJobAnalytics } from "$lib/server/services/analytics";
import { notifyAtlasCompletion } from "$lib/server/services/browser-push";
import { AtlasV3PipelineError } from "../atlas-v3/types";
import { runAtlasV3PipelineForClaimedJob } from "../atlas-v3/worker-bindings";
import { buildAtlasLifecycleContext } from "./checkpoints";
import {
	DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT,
	DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	DEFAULT_ATLAS_WORKER_ENABLED,
} from "./config";
import type { ClaimedAtlasJob } from "./job-ledger";
import {
	applyAtlasGeneratedTitle,
	claimNextAtlasJob,
	completeAtlasJob,
	failAtlasJob,
	heartbeatAtlasJob,
	recoverStaleAtlasJobs,
} from "./job-ledger";
import { resolveAtlasKickoffMessage } from "./kickoff-message";

export interface ExecuteNextAtlasJobInput {
	workerId: string;
	now?: Date;
	globalActiveLimit?: number;
	perUserActiveLimit?: number;
	resolveJobQuery?: (
		job: ClaimedAtlasJob["job"],
	) => Promise<{ query: string | null; userMessageId: string | null }>;
}

export interface DrainAtlasWorkerInput
	extends Omit<ExecuteNextAtlasJobInput, "workerId"> {
	workerId?: string;
}

const DEFAULT_WORKER_ID = `atlas:${process.pid}:${randomUUID()}`;
let workerInitialized = false;
let drainPromise: Promise<void> | null = null;

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
 * `claimNextAtlasJob` already restamps every claimed row's `pipelineVersion`
 * to `ATLAS_CURRENT_PIPELINE_VERSION`, so dispatch here does not need to
 * branch on it — a queued v1/v2 row (a Continue child queued before the
 * deploy, or a job requeued by startup recovery) simply runs fresh on v3.
 */
export async function executeNextAtlasJob(
	input: ExecuteNextAtlasJobInput,
): Promise<boolean> {
	const now = input.now ?? new Date();
	const claimed = await claimNextAtlasJob({
		workerId: input.workerId,
		now,
		globalActiveLimit:
			input.globalActiveLimit ??
			getDefaultAtlasWorkerLimits().globalActiveLimit,
		perUserActiveLimit: input.perUserActiveLimit,
	});
	if (!claimed) return false;
	console.info("[ATLAS] Claimed job", {
		jobId: claimed.job.id,
		workerId: input.workerId,
	});

	try {
		const config = getConfig();
		const resolved = await (
			input.resolveJobQuery ?? resolveAtlasKickoffMessage
		)(claimed.job);
		const query = resolved.query?.trim() ?? "";
		if (!query) {
			throw new Error("Atlas kickoff message query could not be resolved.");
		}
		const lifecycle = await buildAtlasLifecycleContext({
			jobId: claimed.job.id,
			userId: claimed.userId,
			action: claimed.job.action,
			parentAtlasJobId: claimed.job.parentAtlasJobId,
		});
		const auditModel = resolveAuditModelSelection({
			synthesisModel: config.atlasSynthesisModel,
			auditModel: config.atlasAuditModel,
			config,
		});
		return await executeAtlasV3Job({
			claimed,
			workerId: input.workerId,
			now,
			query,
			kickoffUserMessageId: resolved.userMessageId,
			lifecycle,
			synthesisModel: config.atlasSynthesisModel,
			auditModel: auditModel.modelSelection,
		});
	} catch (error) {
		// ADR 0063 raises its own coded failures — an empty verdict is a
		// FAILED job on v3, not a report that silently ships without an
		// opening.
		const v3Error = error instanceof AtlasV3PipelineError ? error : null;
		await failAtlasJob({
			jobId: claimed.job.id,
			workerId: input.workerId,
			errorCode: v3Error?.code ?? "atlas_pipeline_failed",
			errorMessage:
				error instanceof Error ? error.message : "Atlas pipeline failed.",
			retryable: true,
			now: new Date(),
		});
		console.warn("[ATLAS] Job failed", {
			jobId: claimed.job.id,
			workerId: input.workerId,
			error,
		});
		return true;
	}
}

async function executeAtlasV3Job(input: {
	claimed: ClaimedAtlasJob;
	workerId: string;
	now: Date;
	query: string;
	kickoffUserMessageId: string | null;
	lifecycle: Awaited<ReturnType<typeof buildAtlasLifecycleContext>>;
	synthesisModel: ModelId;
	auditModel: ModelId;
}): Promise<boolean> {
	const { claimed } = input;
	const result = await runAtlasV3PipelineForClaimedJob({
		job: {
			id: claimed.job.id,
			userId: claimed.userId,
			conversationId: claimed.job.conversationId,
			assistantMessageId: claimed.job.assistantMessageId,
			action: claimed.job.action,
			parentAtlasJobId: claimed.job.parentAtlasJobId,
			profile: claimed.job.profile,
			title: claimed.job.title,
			query: input.query,
			lifecycle: input.lifecycle,
			kickoffUserMessageId: input.kickoffUserMessageId,
		},
		now: input.now,
		synthesisModel: input.synthesisModel,
		auditModel: input.auditModel,
		heartbeat: async ({ stage, progressPercent, progressDetails }) => {
			const alive = await heartbeatAtlasJob({
				jobId: claimed.job.id,
				workerId: input.workerId,
				stage,
				progressPercent,
				progressDetails: progressDetails as Parameters<
					typeof heartbeatAtlasJob
				>[0]["progressDetails"],
			});
			if (!alive) {
				throw new Error("Atlas job is no longer running.");
			}
		},
		applyGeneratedTitle: async ({ jobId, title }) => {
			const updated = await applyAtlasGeneratedTitle({
				jobId,
				workerId: input.workerId,
				title,
			});
			if (!updated) {
				throw new Error("Atlas job is no longer running.");
			}
		},
	});
	const completedJob = await completeAtlasJob({
		jobId: claimed.job.id,
		workerId: input.workerId,
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
		markdownChatGeneratedFileId: result.outputs.markdownChatGeneratedFileId,
		now: new Date(),
	});
	if (!completedJob) {
		console.info("[ATLAS v3] Skipped completion for inactive job", {
			jobId: claimed.job.id,
			workerId: input.workerId,
		});
		return true;
	}
	await recordAtlasJobAnalytics({
		userId: claimed.userId,
		conversationId: claimed.job.conversationId,
		atlasJobId: claimed.job.id,
		assistantMessageId: claimed.job.assistantMessageId,
		profile: claimed.job.profile,
		inputTokens: result.usage.inputTokens,
		outputTokens: result.usage.outputTokens,
		totalTokens: result.usage.totalTokens,
		costUsdMicros: result.usage.costUsdMicros,
	}).catch((error) => {
		console.warn("[ATLAS v3] Failed to record job analytics", {
			jobId: claimed.job.id,
			error,
		});
	});
	void notifyAtlasCompletion({
		userId: claimed.userId,
		conversationId: claimed.job.conversationId,
		jobId: claimed.job.id,
		title: completedJob.title,
	});
	console.info("[ATLAS v3] Completed job", {
		jobId: claimed.job.id,
		workerId: input.workerId,
		abstained: result.abstained,
		diagnostics: result.diagnostics,
	});
	return true;
}

export async function drainAtlasWorker(
	input: DrainAtlasWorkerInput = {},
): Promise<void> {
	for (;;) {
		const processed = await executeNextAtlasJob({
			...input,
			workerId: input.workerId ?? DEFAULT_WORKER_ID,
		});
		if (!processed) return;
	}
}

export function wakeAtlasWorker(): void {
	if (drainPromise) return;
	const config = getConfig();
	if (!(config.atlasWorkerEnabled ?? DEFAULT_ATLAS_WORKER_ENABLED)) return;
	drainPromise = Promise.resolve()
		.then(() => drainAtlasWorker())
		.catch((error) => {
			console.error("[ATLAS] Worker drain failed", { error });
		})
		.finally(() => {
			drainPromise = null;
		});
}

export async function ensureAtlasWorker(): Promise<void> {
	if (workerInitialized) return;
	workerInitialized = true;
	const config = getConfig();
	const enabled = config.atlasWorkerEnabled ?? DEFAULT_ATLAS_WORKER_ENABLED;
	if (!enabled) return;
	// On startup, recover ALL running jobs — the prior process is dead.
	const recovered = await recoverStaleAtlasJobs({
		staleBefore: new Date(),
	});
	if (recovered.recovered > 0) {
		console.info("[ATLAS] Recovered stale jobs", {
			recovered: recovered.recovered,
		});
	}
	wakeAtlasWorker();
}

export function getDefaultAtlasWorkerLimits(): {
	globalActiveLimit: number;
	perUserActiveLimit: number;
} {
	const config = getConfig();
	return {
		globalActiveLimit:
			config.atlasGlobalActiveLimit ?? DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT,
		perUserActiveLimit: DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	};
}
