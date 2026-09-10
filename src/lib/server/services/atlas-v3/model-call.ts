// The one model seam every Atlas v3 stage goes through (ADR 0063).
//
// Kept in its own module so the stage modules can be unit-tested with a plain
// fake and so `worker-bindings.ts` is the only place that knows about
// `runAtlasModelStage`, provider resolution or pricing.

import type { ThinkingMode } from "$lib/reasoning-depth-types";
import type { AtlasV3ModelTask } from "./config";
import type { AtlasV3Usage } from "./types";

export type AtlasV3ModelCall = (input: {
	/** Free-form stage label; reaches the boundary's system-prompt suffix. */
	stage: string;
	system: string;
	prompt: string;
	/**
	 * Provider reasoning switch. Every v3 stage asks for structured JSON, so
	 * every v3 stage passes `"off"`: reasoning ahead of the object is output
	 * budget spent on text the parser throws away, and on the local model it
	 * breaks the parse outright.
	 */
	thinkingMode?: ThinkingMode;
	maxOutputTokens?: number;
}) => Promise<{
	text: string;
	finishReason?: string | null;
	usage: AtlasV3Usage;
}>;

/** One model call per task, resolved by `resolveAtlasV3TaskModel`. */
export type AtlasV3ModelCalls = Record<AtlasV3ModelTask, AtlasV3ModelCall>;

export const ATLAS_V3_ZERO_USAGE: AtlasV3Usage = {
	inputTokens: 0,
	outputTokens: 0,
	totalTokens: 0,
	costUsdMicros: 0,
};

export function addAtlasV3Usage(
	total: AtlasV3Usage,
	next: AtlasV3Usage,
): AtlasV3Usage {
	return {
		inputTokens: total.inputTokens + next.inputTokens,
		outputTokens: total.outputTokens + next.outputTokens,
		totalTokens: total.totalTokens + next.totalTokens,
		costUsdMicros: total.costUsdMicros + next.costUsdMicros,
	};
}

/**
 * A budget block, rendered into every researcher prompt.
 *
 * Showing the model what it has left is worth about 40% fewer searches at equal
 * accuracy in the published ablations, and it is free: the numbers are already
 * in the caller's hands.
 */
export interface AtlasV3BudgetBlock {
	searchesLeft: number;
	pageReadsLeft: number;
	roundsLeft: number;
}

export function renderAtlasV3Budget(
	budget: AtlasV3BudgetBlock,
): Record<string, number> {
	return {
		searchesLeft: Math.max(0, budget.searchesLeft),
		pageReadsLeft: Math.max(0, budget.pageReadsLeft),
		roundsLeft: Math.max(0, budget.roundsLeft),
	};
}
