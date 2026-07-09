import {
	CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS,
	type ContextPreparationTimelineScope,
	classifyContextPreparationSlowStageTimings,
	RESPONSE_ACTIVITY_IDS,
	type StreamTimelineContextPreparationSlowStageDiagnostic,
} from "$lib/services/stream-timeline";
import type {
	NormalChatContextPreparationActivityClass,
	ResponseActivityEntry,
} from "$lib/types";

export type { NormalChatContextPreparationActivityClass } from "$lib/types";

const NORMAL_CHAT_CONTEXT_PREPARATION_STAGE_IDS = [
	"plan",
	"constructed_context",
	"attachment_trace",
	"base_prompt",
	"system_prompt",
	"automatic_compression",
	"forced_web_prefetch",
	"proactive_connector_context",
	"prompt_budget",
] as const;

export type NormalChatContextPreparationStageId =
	(typeof NORMAL_CHAT_CONTEXT_PREPARATION_STAGE_IDS)[number];

const NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASS_BY_STAGE_ID = {
	plan: "planning",
	constructed_context: "context-retrieval",
	attachment_trace: "attachment-processing",
	base_prompt: "prompt-assembly",
	system_prompt: "prompt-assembly",
	automatic_compression: "context-compression",
	forced_web_prefetch: "web-grounding",
	// Reuses "context-retrieval" rather than adding a new activity class:
	// this stage retrieves connector (calendar/email) context, the same
	// user-facing category as constructed_context, and adding a bespoke
	// class would mean also updating $lib/types.ts's activity-class union
	// plus the client-side label mapping (streaming.ts/MessageBubble.svelte)
	// for a distinction the UI doesn't need to draw.
	proactive_connector_context: "context-retrieval",
	prompt_budget: "budgeting",
} as const satisfies Record<
	NormalChatContextPreparationStageId,
	NormalChatContextPreparationActivityClass
>;

export type NormalChatContextPreparationStageStatus =
	| "started"
	| "done"
	| "error";

export type NormalChatContextPreparationStageTiming = {
	stageId: NormalChatContextPreparationStageId;
	activityClass: NormalChatContextPreparationActivityClass;
	status: NormalChatContextPreparationStageStatus;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
};

export const NORMAL_CHAT_CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS =
	CONTEXT_PREPARATION_SLOW_STAGE_BUDGET_MS;

export type NormalChatContextPreparationSlowStageDiagnostic =
	StreamTimelineContextPreparationSlowStageDiagnostic<NormalChatContextPreparationStageId>;

export type NormalChatContextPreparationActivity = {
	stageId: NormalChatContextPreparationStageId;
	status: NormalChatContextPreparationStageStatus;
	error?: string;
};

export type NormalChatContextPreparationActivityCallback = (
	activity: NormalChatContextPreparationActivity,
) => void;

export type NormalChatContextPreparationResponseActivityCallback = (
	entry: ResponseActivityEntry,
) => void;

export function mapNormalChatContextPreparationActivityToResponseActivity(
	activity: NormalChatContextPreparationActivity,
): ResponseActivityEntry {
	return {
		id: RESPONSE_ACTIVITY_IDS.CONTEXT_PREPARING,
		kind: "context",
		status:
			activity.status === "error"
				? "error"
				: activity.stageId === "prompt_budget" && activity.status === "done"
					? "done"
					: "running",
		contextPreparationClass:
			NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASS_BY_STAGE_ID[
				activity.stageId
			],
	};
}

export function createNormalChatContextPreparationActivityHandler(params: {
	onContextPreparationActivity?: NormalChatContextPreparationActivityCallback;
	onResponseActivity?: NormalChatContextPreparationResponseActivityCallback;
}): NormalChatContextPreparationActivityCallback | undefined {
	if (!params.onContextPreparationActivity && !params.onResponseActivity) {
		return undefined;
	}

	return (activity) => {
		params.onContextPreparationActivity?.(activity);
		params.onResponseActivity?.(
			mapNormalChatContextPreparationActivityToResponseActivity(activity),
		);
	};
}

export function evaluateNormalChatContextPreparationSlowStageBudgets(
	timings:
		| readonly NormalChatContextPreparationStageTiming[]
		| null
		| undefined,
	scope?: ContextPreparationTimelineScope,
): NormalChatContextPreparationSlowStageDiagnostic[] {
	return classifyContextPreparationSlowStageTimings(timings, scope);
}

type NormalChatContextPreparationPlanItem = {
	id: NormalChatContextPreparationStageId;
	dependsOn: readonly NormalChatContextPreparationStageId[];
};

type NormalChatContextPreparationPlan = {
	stages: readonly NormalChatContextPreparationPlanItem[];
};

type NormalChatContextPreparationStageHandler<State extends object> = (
	state: Readonly<State>,
) => Partial<State> | undefined | Promise<Partial<State> | undefined>;

type NormalChatContextPreparationStageHandlers<State extends object> = Partial<
	Record<
		NormalChatContextPreparationStageId,
		NormalChatContextPreparationStageHandler<State>
	>
>;

type NormalChatContextPreparationClock = () => number;

const DEFAULT_NORMAL_CHAT_CONTEXT_PREPARATION_PLAN = {
	stages: [
		{ id: "plan", dependsOn: [] },
		{ id: "constructed_context", dependsOn: ["plan"] },
		{ id: "attachment_trace", dependsOn: ["constructed_context"] },
		{ id: "base_prompt", dependsOn: ["plan"] },
		{ id: "system_prompt", dependsOn: ["attachment_trace", "base_prompt"] },
		{ id: "automatic_compression", dependsOn: ["system_prompt"] },
		{ id: "forced_web_prefetch", dependsOn: ["automatic_compression"] },
		// Chained strictly after forced_web_prefetch (not just
		// constructed_context, though it transitively depends on that too via
		// automatic_compression -> system_prompt -> attachment_trace/
		// base_prompt -> constructed_context/plan) rather than run in parallel
		// with it: both stages splice text into the SAME `inputValue` field, and
		// the stage runner starts every stage whose deps are satisfied against
		// the SAME state snapshot — two stages racing to mutate inputValue from
		// that shared snapshot would silently lose whichever one's insert lands
		// first when the other's result merges in over it. Sequencing avoids
		// that lost-update hazard entirely.
		{
			id: "proactive_connector_context",
			dependsOn: ["forced_web_prefetch"],
		},
		{ id: "prompt_budget", dependsOn: ["proactive_connector_context"] },
	],
} as const satisfies NormalChatContextPreparationPlan;

export function getDefaultNormalChatContextPreparationPlan(): NormalChatContextPreparationPlan {
	return DEFAULT_NORMAL_CHAT_CONTEXT_PREPARATION_PLAN;
}

function describeStageError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function createStageActivity(
	stageId: NormalChatContextPreparationStageId,
	status: NormalChatContextPreparationStageStatus,
	error?: unknown,
): NormalChatContextPreparationActivity {
	return {
		stageId,
		status,
		...(status === "error" ? { error: describeStageError(error) } : {}),
	};
}

function snapshotStageTimings(
	timings: NormalChatContextPreparationStageTiming[],
): NormalChatContextPreparationStageTiming[] {
	return timings.map((timing) => ({ ...timing }));
}

function attachContextPreparationTimingsToError(
	error: unknown,
	timings: NormalChatContextPreparationStageTiming[],
): unknown {
	if (
		(typeof error !== "object" && typeof error !== "function") ||
		error === null
	) {
		return error;
	}
	(
		error as {
			contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
		}
	).contextPreparationTimings = snapshotStageTimings(timings);
	return error;
}

type NormalChatContextPreparationStageResult =
	| { stageId: NormalChatContextPreparationStageId; status: "done" }
	| {
			stageId: NormalChatContextPreparationStageId;
			status: "error";
			error: unknown;
	  };

function mergePreparationState<State extends object>(
	state: State,
	nextState: Partial<State> | undefined,
): State {
	if (nextState === undefined) {
		return state;
	}
	return { ...state, ...nextState };
}

export async function runNormalChatContextPreparationStages<
	State extends object,
>(params: {
	plan: NormalChatContextPreparationPlan;
	initialState: State;
	handlers: NormalChatContextPreparationStageHandlers<State>;
	onActivity?: NormalChatContextPreparationActivityCallback;
	now?: NormalChatContextPreparationClock;
}): Promise<{
	state: State;
	activities: NormalChatContextPreparationActivity[];
	timings: NormalChatContextPreparationStageTiming[];
}> {
	let state = params.initialState;
	const now = params.now ?? Date.now;
	const activities: NormalChatContextPreparationActivity[] = [];
	const timings: NormalChatContextPreparationStageTiming[] = [];

	const record = (activity: NormalChatContextPreparationActivity) => {
		activities.push(activity);
		params.onActivity?.(activity);
	};

	const startTiming = (
		stageId: NormalChatContextPreparationStageId,
	): NormalChatContextPreparationStageTiming => {
		const timing: NormalChatContextPreparationStageTiming = {
			stageId,
			activityClass:
				NORMAL_CHAT_CONTEXT_PREPARATION_ACTIVITY_CLASS_BY_STAGE_ID[stageId],
			status: "started",
			startedAt: now(),
		};
		timings.push(timing);
		return timing;
	};

	const completeTiming = (
		timing: NormalChatContextPreparationStageTiming,
		status: "done" | "error",
	) => {
		if (timing.completedAt !== undefined) {
			return;
		}
		const completedAt = now();
		timing.completedAt = completedAt;
		timing.durationMs = Math.max(0, completedAt - timing.startedAt);
		timing.status = status;
	};

	const pending = new Map(
		params.plan.stages.map((stage) => [stage.id, stage] as const),
	);
	const running = new Map<
		NormalChatContextPreparationStageId,
		Promise<NormalChatContextPreparationStageResult>
	>();
	const completed = new Set<NormalChatContextPreparationStageId>();

	const runStage = async (
		stage: NormalChatContextPreparationPlanItem,
		stageState: State,
	): Promise<NormalChatContextPreparationStageResult> => {
		const handler = params.handlers[stage.id];
		const timing = startTiming(stage.id);
		record(createStageActivity(stage.id, "started"));
		try {
			if (!handler) {
				throw new Error(`Missing preparation stage handler: ${stage.id}`);
			}
			const nextState = await handler(stageState);
			state = mergePreparationState(state, nextState);
			completed.add(stage.id);
			completeTiming(timing, "done");
			record(createStageActivity(stage.id, "done"));
			return { stageId: stage.id, status: "done" };
		} catch (error) {
			completeTiming(timing, "error");
			record(createStageActivity(stage.id, "error", error));
			return { stageId: stage.id, status: "error", error };
		}
	};

	const startReadyStages = () => {
		let started = false;
		for (const stage of params.plan.stages) {
			if (!pending.has(stage.id)) continue;
			if (!stage.dependsOn.every((dependency) => completed.has(dependency))) {
				continue;
			}
			pending.delete(stage.id);
			running.set(stage.id, runStage(stage, state));
			started = true;
		}
		return started;
	};

	startReadyStages();

	while (pending.size > 0 || running.size > 0) {
		if (running.size === 0) {
			const blockedStages = Array.from(pending.values())
				.map((stage) => stage.id)
				.join(", ");
			throw new Error(
				`Unable to resolve normal chat context preparation dependencies: ${blockedStages}`,
			);
		}
		const result = await Promise.race(running.values());
		running.delete(result.stageId);
		if (result.status === "error") {
			throw attachContextPreparationTimingsToError(result.error, timings);
		}
		startReadyStages();
	}

	return { state, activities, timings };
}
