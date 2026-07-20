import type { AtlasStageUsage } from "./pipeline";
import type { AtlasPipelineStage } from "./types";

/**
 * Model stages are the subset of pipeline stages that call the synthesis model
 * (everything except the deterministic `search`, `audit`, and `render` stages).
 */
export type AtlasModelStage = Exclude<
	AtlasPipelineStage,
	"search" | "audit" | "render"
>;

export interface AtlasStageModelResult {
	text: string;
	finishReason?: string | null;
	usage: AtlasStageUsage;
}

/**
 * The per-scope context captured by {@link makeAtlasStageRunner}: the model +
 * heartbeat dependencies for the scope, plus a bound `stageSystem` resolver so
 * callers never re-thread `language` / `currentDate` / `profilePosture`.
 */
export interface AtlasStageRunnerContext {
	runModelStage: (input: {
		stage: AtlasModelStage;
		prompt: string;
		system: string;
	}) => Promise<AtlasStageModelResult>;
	heartbeat?: (input: {
		stage: AtlasPipelineStage;
		progressPercent: number;
	}) => Promise<void>;
	resolveStageSystem: (stage: AtlasModelStage) => string;
}

export interface RunAtlasStageOptions {
	/** Progress percent for the heartbeat emitted before the model call. */
	progress: number;
	/** Builds the model prompt; called after the heartbeat, mirroring the
	 * original inline `prompt: JSON.stringify({...})` evaluation order. */
	buildPrompt: () => string;
	/** Overrides the default `stageSystem(stage, ...)` binding. Used by the
	 * post-audit revise re-entry, which runs on the `assemble` model stage but
	 * with a bespoke revision system prompt. */
	system?: string;
}

export interface AtlasStageRunner {
	/**
	 * Emits the stage heartbeat, binds the stage system prompt, runs the model
	 * stage, folds the returned usage into the accumulator, and returns the
	 * model result.
	 */
	runStage: (
		stage: AtlasModelStage,
		options: RunAtlasStageOptions,
	) => Promise<AtlasStageModelResult>;
	/** Folds non-model-stage usage (research rounds, audit) into the same
	 * accumulator so `usage` remains the single scope total. */
	foldUsage: (usage: AtlasStageUsage | null | undefined) => void;
	/** The running total of all usage folded into this runner. */
	readonly usage: AtlasStageUsage;
}

function addUsage(
	total: AtlasStageUsage,
	next: AtlasStageUsage,
): AtlasStageUsage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		costUsdMicros: total.costUsdMicros + next.costUsdMicros,
	};
}

/**
 * Creates a stage runner bound to one usage-accumulator scope. Create one per
 * scope (research round vs. pipeline) to mirror the existing accumulator
 * boundaries exactly.
 */
export function makeAtlasStageRunner(
	context: AtlasStageRunnerContext,
): AtlasStageRunner {
	let usage: AtlasStageUsage = {
		inputTokens: 0,
		outputTokens: 0,
		totalTokens: 0,
		costUsdMicros: 0,
	};
	return {
		async runStage(stage, options) {
			await context.heartbeat?.({
				stage,
				progressPercent: options.progress,
			});
			const result = await context.runModelStage({
				stage,
				system: options.system ?? context.resolveStageSystem(stage),
				prompt: options.buildPrompt(),
			});
			usage = addUsage(usage, result.usage);
			return result;
		},
		foldUsage(next) {
			if (next) {
				usage = addUsage(usage, next);
			}
		},
		get usage() {
			return usage;
		},
	};
}
