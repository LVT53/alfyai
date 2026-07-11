import { sweepDirtyConversations } from "../memory-judge/runner";
import type { ConsolidationAction } from "./steps";
import { runExpireAndRenew, runReconcileAndMerge } from "./steps";
import { generateAndStorePersonaSummary } from "./summary";

/**
 * The whole night shift, readable in one place.
 *
 * `runUserMemoryConsolidation` used to inline the ordered pipeline — sweep dirty
 * conversations, expire/renew, reconcile/merge, regenerate the persona summary —
 * with its `ConsolidationAction` accounting threaded through by hand. That made
 * the shape of the night shift something you had to reconstruct by reading the
 * runner. This spine names each step and lists them in order, so the pipeline is
 * enumerable (see spine.test.ts) without changing what any step does: each step
 * here is a thin wrapper that calls the exact same underlying function the runner
 * called before, in the same order.
 */
export type NightShiftContext = { userId: string };

export type NightShiftStepResult = {
	/** Structural actions produced by this step, accumulated for the report. */
	actions?: ConsolidationAction[];
	/** True when this step (re)generated the persona summary. */
	summaryRefreshed?: boolean;
};

export type NightShiftStep = {
	name: string;
	run: (ctx: NightShiftContext) => Promise<NightShiftStepResult>;
};

export const NIGHT_SHIFT_SPINE: readonly NightShiftStep[] = [
	{
		name: "sweep_dirty_conversations",
		run: async ({ userId }) => {
			await sweepDirtyConversations(userId);
			return {};
		},
	},
	{
		name: "expire_and_renew",
		run: async ({ userId }) => ({
			actions: await runExpireAndRenew({ userId }),
		}),
	},
	{
		name: "reconcile_and_merge",
		run: async ({ userId }) => ({
			actions: await runReconcileAndMerge({ userId }),
		}),
	},
	{
		name: "persona_summary",
		run: async ({ userId }) => {
			const summary = await generateAndStorePersonaSummary({ userId });
			return { summaryRefreshed: summary !== null };
		},
	},
];
