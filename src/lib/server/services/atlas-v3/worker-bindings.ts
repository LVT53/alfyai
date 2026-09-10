// Composition root for Atlas v3's dependencies (ADR 0063). The worker calls
// `runAtlasV3PipelineForClaimedJob`; everything model-, DB- or Parallel-shaped
// is bound here so `pipeline.ts` stays testable with plain fakes.

import { eq } from "drizzle-orm";
import type { ModelId } from "$lib/model-types";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import {
	listAtlasRoundCheckpoints,
	writeAtlasRoundCheckpoint,
} from "../atlas/checkpoints";
import { runAtlasModelStage } from "../atlas/model-stage";
import { renderAtlasOutputs } from "../atlas/renderer-output";
import type { AtlasPipelineJobContext } from "../atlas/types";
import {
	ATLAS_V3_MODEL_TASKS,
	type AtlasV3ModelTask,
	resolveAtlasV3TaskModel,
} from "./config";
import type { AtlasV3ModelCall, AtlasV3ModelCalls } from "./model-call";
import { runAtlasV3Pipeline } from "./pipeline";
import { createAtlasV3ResearchWeb } from "./research-web-adapter";
import type { AtlasV3PipelineResult } from "./types";

export interface RunAtlasV3PipelineForClaimedJobInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	synthesisModel: ModelId;
	auditModel: ModelId;
	heartbeat: (input: {
		stage: string;
		progressPercent: number;
		progressDetails?: unknown;
	}) => Promise<void>;
	applyGeneratedTitle?: (input: {
		jobId: string;
		title: string;
	}) => Promise<void>;
}

/**
 * v3's model stages reuse v1's model boundary (`runAtlasModelStage`), exactly as
 * v2 does, so pricing, usage normalisation and provider resolution are
 * identical across all three pipelines. ADR 0063's per-task model keys resolve
 * to a `ModelId` and then go through that same boundary — nothing about the
 * selection path is v3-specific.
 */
function makeModelCall(input: {
	modelSelection: ModelId;
	profile: AtlasPipelineJobContext["profile"];
}): AtlasV3ModelCall {
	return async ({ stage, system, prompt, thinkingMode, maxOutputTokens }) => {
		const result = await runAtlasModelStage({
			// v1's stage union does not include v3's stage names; the value only
			// ever reaches the system-prompt suffix, so it is passed as-is.
			stage: stage as never,
			profile: input.profile,
			modelSelection: input.modelSelection,
			system,
			prompt,
			...(thinkingMode ? { thinkingMode } : {}),
			...(maxOutputTokens ? { maxOutputTokens } : {}),
		});
		return {
			text: result.text,
			finishReason: result.finishReason,
			usage: result.usage,
		};
	};
}

/** One resolved model per task, with the inherited fallback applied. */
export function buildAtlasV3ModelCalls(input: {
	profile: AtlasPipelineJobContext["profile"];
	synthesisModel: ModelId;
	auditModel: ModelId;
	taskModels?: Partial<Record<AtlasV3ModelTask, ModelId | null>>;
	/** Test seam; production builds a real call per task. */
	makeCall?: (input: {
		modelSelection: ModelId;
		profile: AtlasPipelineJobContext["profile"];
	}) => AtlasV3ModelCall;
}): {
	calls: AtlasV3ModelCalls;
	selections: Record<AtlasV3ModelTask, ModelId>;
} {
	const make = input.makeCall ?? makeModelCall;
	const calls = {} as AtlasV3ModelCalls;
	const selections = {} as Record<AtlasV3ModelTask, ModelId>;
	for (const task of ATLAS_V3_MODEL_TASKS) {
		const selection = resolveAtlasV3TaskModel({
			task,
			synthesisModel: input.synthesisModel,
			auditModel: input.auditModel,
			taskModels: input.taskModels,
		});
		selections[task] = selection.model;
		calls[task] = make({
			modelSelection: selection.model,
			profile: input.profile,
		});
	}
	return { calls, selections };
}

/**
 * Arithmetic through the same sandbox `run_python` uses. Returns
 * `{ ok: false }` whenever the sandbox is unavailable or the expression does
 * not evaluate, which leaves the derived figure `null` and forbids the writer
 * from quoting it.
 */
async function runAtlasV3Calculation(input: {
	expression: string;
}): Promise<{ ok: boolean; value: string | null }> {
	try {
		const { executeCode } = await import(
			"$lib/server/services/sandbox-execution"
		);
		const execution = await executeCode(
			`print(${input.expression})`,
			"python",
			{ collectFiles: false },
		);
		if (execution.error || (execution.exitCode ?? 0) !== 0) {
			return { ok: false, value: null };
		}
		const text = execution.stdout.trim();
		return text ? { ok: true, value: text } : { ok: false, value: null };
	} catch {
		return { ok: false, value: null };
	}
}

export async function runAtlasV3PipelineForClaimedJob(
	input: RunAtlasV3PipelineForClaimedJobInput,
): Promise<AtlasV3PipelineResult> {
	const config = getConfig();
	const { calls, selections } = buildAtlasV3ModelCalls({
		profile: input.job.profile,
		synthesisModel: input.synthesisModel,
		auditModel: input.auditModel,
	});
	console.info("[ATLAS v3] Model per task", {
		jobId: input.job.id,
		...selections,
	});
	return runAtlasV3Pipeline({
		job: input.job,
		now: input.now,
		dependencies: {
			researchWeb: createAtlasV3ResearchWeb({
				conversationId: input.job.conversationId,
				sessionId: input.job.id,
				recordUsage: (tool) => {
					void import("$lib/server/services/analytics")
						.then(({ recordParallelUsage }) =>
							recordParallelUsage({
								userId: input.job.userId,
								conversationId: input.job.conversationId,
								tool,
							}),
						)
						.catch(() => {});
				},
			}),
			models: calls,
			runPython: runAtlasV3Calculation,
			heartbeat: input.heartbeat,
			applyGeneratedTitle: input.applyGeneratedTitle,
			writeCheckpoint: (checkpoint) => writeAtlasRoundCheckpoint(checkpoint),
			loadCheckpoints: async (jobId) => {
				const checkpoints = await listAtlasRoundCheckpoints(jobId);
				return checkpoints.map((entry) => ({
					roundNumber: entry.roundNumber,
					checkpoint: entry.checkpoint,
				}));
			},
			renderOutputs: (source) =>
				renderAtlasOutputs({
					userId: input.job.userId,
					conversationId: input.job.conversationId,
					assistantMessageId: input.job.assistantMessageId,
					jobId: input.job.id,
					source,
				}),
			setAssistantMessageContent: async ({ messageId, content }) => {
				await db
					.update(messages)
					.set({ content })
					.where(eq(messages.id, messageId));
			},
			researcherConcurrency: config.atlasV3ResearcherConcurrency,
			criticRounds: config.atlasV3CriticRounds,
			hungarianStandardEnabled: config.atlasV3LanguageStandardHu,
		},
	});
}
