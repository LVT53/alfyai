import { randomUUID } from "node:crypto";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { getConfig, isModelEnabled } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { recordAtlasJobAnalytics } from "$lib/server/services/analytics";
import { notifyAtlasCompletion } from "$lib/server/services/browser-push";
import type { ModelId } from "$lib/types";
import {
	buildAtlasLifecycleContext,
	writeAtlasRoundCheckpoint,
} from "./checkpoints";
import {
	DEFAULT_ATLAS_GLOBAL_ACTIVE_LIMIT,
	DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT,
	DEFAULT_ATLAS_STALE_WORKER_MS,
	DEFAULT_ATLAS_WORKER_ENABLED,
	getAtlasProfileRuntimeConfig,
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
import { runAtlasAuditStage, runAtlasModelStage } from "./model-stage";
import { AtlasPipelineQualityError, runAtlasPipeline } from "./pipeline";
import { auditAtlasBasis } from "./quality-gates";
import { renderAtlasOutputs } from "./renderer-output";
import { runAtlasImageSearchStage, runAtlasSearchStage } from "./search";
import { resolveAtlasSourcesForJob } from "./sources";

export interface ExecuteNextAtlasJobInput {
	workerId: string;
	now?: Date;
	globalActiveLimit?: number;
	perUserActiveLimit?: number;
	resolveJobQuery?: (job: ClaimedAtlasJob["job"]) => Promise<string | null>;
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
		const query =
			(
				await (input.resolveJobQuery ?? resolveAtlasJobQuery)(claimed.job)
			)?.trim() ?? "";
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
		const profileConfig = getAtlasProfileRuntimeConfig(claimed.job.profile);
		const result = await runAtlasPipeline({
			job: {
				id: claimed.job.id,
				userId: claimed.userId,
				conversationId: claimed.job.conversationId,
				assistantMessageId: claimed.job.assistantMessageId,
				action: claimed.job.action,
				parentAtlasJobId: claimed.job.parentAtlasJobId,
				profile: claimed.job.profile,
				title: claimed.job.title,
				query,
				lifecycle,
			},
			now,
			dependencies: {
				resolveSources: () =>
					resolveAtlasSourcesForJob({
						userId: claimed.userId,
						conversationId: claimed.job.conversationId,
						assistantMessageId: claimed.job.assistantMessageId,
						lifecycleSeed: lifecycle.seed,
					}),
				searchWeb: (queries) =>
					runAtlasSearchStage({
						queries,
						config: {
							searxngBaseUrl: config.searxngBaseUrl,
							concurrency: config.atlasSearchConcurrency,
							interBatchDelayMs: config.atlasSearchBatchDelayMs,
							maxAcceptedSources: profileConfig.maxAcceptedWebSources,
							webResearchExtractorMode: config.webResearchExtractorMode,
							webResearchExtractTimeoutMs: config.webResearchExtractTimeoutMs,
							webResearchExtractCacheTtlHours:
								config.webResearchExtractCacheTtlHours,
						},
					}),
				searchImages: (queries, timeRange) =>
					runAtlasImageSearchStage({
						queries,
						config: {
							searxngBaseUrl: config.searxngBaseUrl,
							concurrency: config.atlasSearchConcurrency,
							interBatchDelayMs: config.atlasSearchBatchDelayMs,
							maxImageCandidates: profileConfig.maxImageCandidates,
						},
						timeRange,
					}),
				runModelStage: ({ stage, prompt, system }) =>
					runAtlasModelStage({
						stage,
						profile: claimed.job.profile,
						modelSelection: config.atlasSynthesisModel,
						prompt,
						system,
					}),
				auditBasis: (auditInput) =>
					auditAtlasBasis({
						...auditInput,
						auditModelWarning: auditModel.warning,
						runAuditModel: (prompt) =>
							runAtlasAuditStage({
								profile: claimed.job.profile,
								modelSelection: auditModel.modelSelection,
								prompt,
							}),
					}),
				heartbeat: async ({ stage, progressPercent, progressDetails }) => {
					const alive = await heartbeatAtlasJob({
						jobId: claimed.job.id,
						workerId: input.workerId,
						stage,
						progressPercent,
						progressDetails,
					});
					if (!alive) {
						throw new Error("Atlas job is no longer running.");
					}
				},
				writeCheckpoint: writeAtlasRoundCheckpoint,
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
				renderOutputs: (source) =>
					renderAtlasOutputs({
						userId: claimed.userId,
						conversationId: claimed.job.conversationId,
						assistantMessageId: claimed.job.assistantMessageId,
						jobId: claimed.job.id,
						source,
					}),
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
			console.info("[ATLAS] Skipped completion for inactive job", {
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
			console.warn("[ATLAS] Failed to record job analytics", {
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
		console.info("[ATLAS] Completed job", {
			jobId: claimed.job.id,
			workerId: input.workerId,
		});
		return true;
	} catch (error) {
		const qualityError =
			error instanceof AtlasPipelineQualityError ? error : null;
		await failAtlasJob({
			jobId: claimed.job.id,
			workerId: input.workerId,
			errorCode: qualityError?.code ?? "atlas_pipeline_failed",
			errorMessage:
				error instanceof Error ? error.message : "Atlas pipeline failed.",
			retryable: true,
			failureMetadata: qualityError
				? {
						honestyMarkers: qualityError.markers,
						failureContext: qualityError.failureContext,
					}
				: undefined,
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

async function resolveAtlasJobQuery(job: {
	conversationId: string;
	assistantMessageId: string | null;
}): Promise<string | null> {
	if (!job.assistantMessageId) return null;
	const [assistantMessage] = await db
		.select()
		.from(messages)
		.where(eq(messages.id, job.assistantMessageId))
		.limit(1);
	if (!assistantMessage) return null;

	const sequence = assistantMessage.messageSequence;
	const [userMessage] = await db
		.select()
		.from(messages)
		.where(
			and(
				eq(messages.conversationId, job.conversationId),
				eq(messages.role, "user"),
				sequence === null
					? sql`${messages.createdAt} <= ${assistantMessage.createdAt}`
					: lt(messages.messageSequence, sequence),
			),
		)
		.orderBy(desc(messages.messageSequence), desc(messages.createdAt))
		.limit(1);

	return userMessage?.content ?? null;
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
	const recovered = await recoverStaleAtlasJobs({
		staleBefore: new Date(Date.now() - DEFAULT_ATLAS_STALE_WORKER_MS),
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
