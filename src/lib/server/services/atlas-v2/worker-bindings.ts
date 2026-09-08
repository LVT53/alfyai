// Composition root for Atlas v2's dependencies (ADR 0062). The worker calls
// `runAtlasV2PipelineForClaimedJob`; everything model-, DB- or Parallel-shaped
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
import type { AtlasV2ModelCall } from "./pipeline";
import { runAtlasV2Pipeline } from "./pipeline";
import { createAtlasV2ResearchWebRunner } from "./research-web-adapter";
import type { AtlasV2PipelineResult } from "./types";

export interface RunAtlasV2PipelineForClaimedJobInput {
	job: AtlasPipelineJobContext;
	now?: Date;
	synthesisModel: ModelId;
	auditModel: ModelId;
	heartbeat: (input: {
		stage: string;
		progressPercent: number;
		progressDetails?: unknown;
	}) => Promise<void>;
}

/**
 * The v2 model stages reuse v1's model boundary (`runAtlasModelStage`) so
 * pricing, usage normalisation and the provider resolution path are identical
 * for both pipelines. `variant: "audit"` is only about which system prompt the
 * boundary applies, so v2 passes its own system prompt as a normal stage.
 */
function makeModelCall(input: {
	modelSelection: ModelId;
	profile: AtlasPipelineJobContext["profile"];
}): AtlasV2ModelCall {
	return async ({ stage, system, prompt }) => {
		const result = await runAtlasModelStage({
			// v1's stage union does not include v2's stage names; the value only
			// ever reaches the system-prompt suffix, so it is passed as-is.
			stage: stage as never,
			profile: input.profile,
			modelSelection: input.modelSelection,
			system,
			prompt,
		});
		return {
			text: result.text,
			finishReason: result.finishReason,
			usage: result.usage,
		};
	};
}

/**
 * Arithmetic through the same sandbox `run_python` uses. Returns
 * `{ ok: false }` whenever the sandbox is unavailable or the expression does
 * not evaluate, which makes the citing sentence `inferred` rather than letting
 * an unchecked figure through.
 */
async function runAtlasV2Calculation(input: {
	expression: string;
}): Promise<{ ok: boolean; value: string | null }> {
	// Only a single arithmetic expression is ever evaluated, and it is built
	// from figures the writer already cited, so the program is a one-liner.
	// `collectFiles: false` is the same posture run_python takes: stdout only.
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

export async function runAtlasV2PipelineForClaimedJob(
	input: RunAtlasV2PipelineForClaimedJobInput,
): Promise<AtlasV2PipelineResult> {
	const config = getConfig();
	return runAtlasV2Pipeline({
		job: input.job,
		now: input.now,
		dependencies: {
			researchWeb: createAtlasV2ResearchWebRunner({
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
			runControlModel: makeModelCall({
				modelSelection: input.auditModel,
				profile: input.job.profile,
			}),
			runWriterModel: makeModelCall({
				modelSelection: input.synthesisModel,
				profile: input.job.profile,
			}),
			runAuditModel: makeModelCall({
				modelSelection: input.auditModel,
				profile: input.job.profile,
			}),
			runPython: runAtlasV2Calculation,
			heartbeat: input.heartbeat,
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
			searchConcurrency: config.atlasSearchConcurrency,
		},
	});
}
