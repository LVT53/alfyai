import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { deepResearchJobs } from "$lib/server/db/schema";
import type { DeepResearchJob } from "$lib/types";
import {
	buildDeepResearchForeignKeyDiagnostics,
	formatDeepResearchDiagnosticsJson,
	isSqliteForeignKeyConstraintError,
} from "./diagnostics";
import { listConversationDeepResearchJobs } from "./index";
import { getLatestValidResearchResumePoint } from "./resume-points";
import { cancelRunningResearchTasks } from "./tasks";
import { saveResearchTimelineEvent } from "./timeline";
import {
	type RunDeepResearchWorkflowStepInput,
	type RunDeepResearchWorkflowStepResult,
	runDeepResearchWorkflowStep,
} from "./workflow";

export type DeepResearchWorkflowStepRunner = (
	input: RunDeepResearchWorkflowStepInput,
) => Promise<RunDeepResearchWorkflowStepResult>;

export type RunNextDeepResearchWorkflowWorkerStepInput = {
	now?: Date;
	controls?: DeepResearchWorkerControls;
	workflowStep?: DeepResearchWorkflowStepRunner;
};

export type RunNextDeepResearchWorkflowWorkerStepResult = {
	job: DeepResearchJob;
	advanced: boolean;
} | null;

export type TriggerDeepResearchWorkflowWorkerForJobInput = {
	userId: string;
	jobId: string;
	now?: Date;
	controls?: DeepResearchWorkerControls;
	workflowStep?: DeepResearchWorkflowStepRunner;
};

export type TriggerDeepResearchWorkflowWorkerForJobResult = {
	job: DeepResearchJob;
	advanced: boolean;
} | null;

export type RecoverStaleDeepResearchJobsInput = {
	now?: Date;
	timeoutMs: number;
};

export type RecoverStaleDeepResearchJobsResult = {
	recoveredJobs: DeepResearchJob[];
};

export type DeepResearchWorkerRecoverStaleJobs = (
	input: RecoverStaleDeepResearchJobsInput,
) => Promise<RecoverStaleDeepResearchJobsResult>;

export type DeepResearchWorkerAdvanceWorkflowStep = (
	input?: RunNextDeepResearchWorkflowWorkerStepInput,
) => Promise<RunNextDeepResearchWorkflowWorkerStepResult>;

export type RunDeepResearchWorkerTickOptions = {
	enabled: boolean;
	intervalMs: number;
	staleTimeoutMs: number;
	controls?: DeepResearchWorkerControls;
	now?: Date;
	recoverStaleJobs?: DeepResearchWorkerRecoverStaleJobs;
	advanceWorkflowStep?: DeepResearchWorkerAdvanceWorkflowStep;
};

export type RunDeepResearchWorkerTickResult = {
	enabled: boolean;
	recoveredJobs: DeepResearchJob[];
	recoveredCount: number;
	workerStep: RunNextDeepResearchWorkflowWorkerStepResult;
	advanced: boolean;
};

export type DeepResearchWorkerSchedulerOptionsProvider =
	() => RunDeepResearchWorkerTickOptions;

export type RequestDeepResearchWorkerCancellationInput = {
	userId: string;
	jobId: string;
	now?: Date;
};

export type DeepResearchWorkerControls = {
	globalConcurrencyLimit?: number;
	userConcurrencyLimit?: number;
};

type WorkerConcurrencyTransition = {
	fromStatus: string;
	toStatus: string;
};

const REAL_WORKFLOW_RUNNING_STAGES = [
	"source_review",
	"research_tasks",
	"synthesis",
	"citation_audit",
	"report_assembly",
];
const DEFAULT_WORKER_INTERVAL_MS = 60_000;
const DEFAULT_WORKER_STALE_TIMEOUT_MS = 30 * 60_000;

let workerSchedulerHandle: ReturnType<typeof setInterval> | null = null;
let workerSchedulerTickInFlight = false;

function getDisabledDeepResearchWorkerSchedulerOptions(): RunDeepResearchWorkerTickOptions {
	return {
		enabled: false,
		intervalMs: DEFAULT_WORKER_INTERVAL_MS,
		staleTimeoutMs: DEFAULT_WORKER_STALE_TIMEOUT_MS,
	};
}

export async function runDeepResearchWorkerTick(
	options: RunDeepResearchWorkerTickOptions,
): Promise<RunDeepResearchWorkerTickResult> {
	if (!options.enabled) {
		return {
			enabled: false,
			recoveredJobs: [],
			recoveredCount: 0,
			workerStep: null,
			advanced: false,
		};
	}

	const now = options.now ?? new Date();
	const recoverStaleJobs =
		options.recoverStaleJobs ?? recoverStaleDeepResearchJobs;
	const advanceWorkflowStep =
		options.advanceWorkflowStep ?? runNextDeepResearchWorkflowWorkerStep;
	const recovered = await recoverStaleJobs({
		now,
		timeoutMs: options.staleTimeoutMs,
	});
	const workerStep = await advanceWorkflowStep({
		now,
		controls: options.controls,
	});

	return {
		enabled: true,
		recoveredJobs: recovered.recoveredJobs,
		recoveredCount: recovered.recoveredJobs.length,
		workerStep,
		advanced: workerStep?.advanced ?? false,
	};
}

export function ensureDeepResearchWorkerScheduler(
	optionsProvider: DeepResearchWorkerSchedulerOptionsProvider = getDisabledDeepResearchWorkerSchedulerOptions,
): void {
	if (workerSchedulerHandle) return;

	const initialOptions = optionsProvider();
	const intervalMs =
		normalizePositiveMilliseconds(initialOptions.intervalMs) ??
		DEFAULT_WORKER_INTERVAL_MS;

	workerSchedulerHandle = setInterval(() => {
		if (workerSchedulerTickInFlight) return;
		const currentOptions = optionsProvider();
		if (!currentOptions.enabled) return;

		workerSchedulerTickInFlight = true;

		void runDeepResearchWorkerTick(currentOptions)
			.then((result) => {
				if (result.recoveredCount > 0 || result.advanced) {
					console.info("[DEEP_RESEARCH] Worker tick completed", {
						recoveredCount: result.recoveredCount,
						advanced: result.advanced,
						jobId: result.workerStep?.job.id ?? null,
					});
				}
			})
			.catch((error) => {
				console.error("[DEEP_RESEARCH] Worker tick failed", {
					error,
					foreignKeyDiagnosticsJson: isSqliteForeignKeyConstraintError(error)
						? formatDeepResearchDiagnosticsJson(
								buildDeepResearchForeignKeyDiagnostics(),
							)
						: null,
				});
			})
			.finally(() => {
				workerSchedulerTickInFlight = false;
			});
	}, intervalMs);
	workerSchedulerHandle.unref?.();

	console.info("[DEEP_RESEARCH] Worker scheduler installed", {
		enabled: initialOptions.enabled,
		intervalMs,
	});
}

export function stopDeepResearchWorkerScheduler(): void {
	if (workerSchedulerHandle) {
		clearInterval(workerSchedulerHandle);
		workerSchedulerHandle = null;
	}
	workerSchedulerTickInFlight = false;
}

export async function runNextDeepResearchWorkflowWorkerStep(
	input: RunNextDeepResearchWorkflowWorkerStepInput = {},
): Promise<RunNextDeepResearchWorkflowWorkerStepResult> {
	const now = input.now ?? new Date();
	const workflowStep = input.workflowStep ?? runDeepResearchWorkflowStep;
	const eligibleJobs = await db
		.select()
		.from(deepResearchJobs)
		.where(
			or(
				and(
					eq(deepResearchJobs.status, "approved"),
					eq(deepResearchJobs.stage, "plan_approved"),
				),
				and(
					eq(deepResearchJobs.status, "running"),
					inArray(deepResearchJobs.stage, REAL_WORKFLOW_RUNNING_STAGES),
				),
			),
		)
		.orderBy(asc(deepResearchJobs.createdAt))
		.limit(25);

	let firstBlockedJob: typeof deepResearchJobs.$inferSelect | null = null;
	for (const eligibleJob of eligibleJobs) {
		if (
			!(await canStartApprovedJobWithinConcurrency(
				eligibleJob,
				{
					fromStatus: eligibleJob.status,
					toStatus: "running",
				},
				input.controls,
			))
		) {
			firstBlockedJob ??= eligibleJob;
			continue;
		}

		return runRealWorkflowWorkerStep(eligibleJob, now, workflowStep);
	}

	if (!firstBlockedJob) return null;
	return buildNotAdvancedWorkflowWorkerResult(firstBlockedJob);
}

export async function triggerDeepResearchWorkflowWorkerForJob(
	input: TriggerDeepResearchWorkflowWorkerForJobInput,
): Promise<TriggerDeepResearchWorkflowWorkerForJobResult> {
	const now = input.now ?? new Date();
	const workflowStep = input.workflowStep ?? runDeepResearchWorkflowStep;
	const [job] = await db
		.select()
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.id, input.jobId),
				eq(deepResearchJobs.userId, input.userId),
			),
		)
		.limit(1);

	if (!job) return null;
	if (!isRealWorkflowWorkerEligibleJob(job)) {
		return buildNotAdvancedWorkflowWorkerResult(job);
	}
	if (
		!(await canStartApprovedJobWithinConcurrency(
			job,
			{
				fromStatus: job.status,
				toStatus: "running",
			},
			input.controls,
		))
	) {
		return buildNotAdvancedWorkflowWorkerResult(job);
	}

	return runRealWorkflowWorkerStep(job, now, workflowStep);
}

export async function recoverStaleDeepResearchJobs(
	input: RecoverStaleDeepResearchJobsInput,
): Promise<RecoverStaleDeepResearchJobsResult> {
	const now = input.now ?? new Date();
	const cutoff = new Date(now.getTime() - Math.max(0, input.timeoutMs));
	const staleJobs = await db
		.select()
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.status, "running"),
				lte(deepResearchJobs.updatedAt, cutoff),
			),
		)
		.orderBy(asc(deepResearchJobs.updatedAt));
	const recoveredJobs: DeepResearchJob[] = [];

	for (const staleJob of staleJobs) {
		const latestResumePoint = await getLatestValidResearchResumePoint({
			userId: staleJob.userId,
			jobId: staleJob.id,
		});
		const resumedStage = normalizeRecoverableStage(
			latestResumePoint?.stage ?? staleJob.stage,
		);
		const [recoveredJob] = await db
			.update(deepResearchJobs)
			.set({
				status: "running",
				stage: resumedStage,
				updatedAt: now,
			})
			.where(
				and(
					eq(deepResearchJobs.id, staleJob.id),
					eq(deepResearchJobs.status, "running"),
					lte(deepResearchJobs.updatedAt, cutoff),
				),
			)
			.returning();
		if (!recoveredJob) continue;

		await saveResearchTimelineEvent({
			jobId: recoveredJob.id,
			conversationId: recoveredJob.conversationId,
			userId: recoveredJob.userId,
			taskId: null,
			stage: "report_completion",
			kind: "warning",
			occurredAt: now.toISOString(),
			messageKey: "deepResearch.timeline.workerStaleRecovered",
			messageParams: {
				stage: staleJob.stage ?? "unknown",
			},
			sourceCounts: {
				discovered: 0,
				reviewed: 0,
				cited: 0,
			},
			assumptions: [],
			warnings: [
				`Worker timeout exceeded for stage ${staleJob.stage ?? "unknown"}.`,
			],
			summary:
				"Deep Research job resumed from the latest durable Research Resume Point after exceeding the stale worker timeout.",
		});

		const mappedJob = await loadDeepResearchJobForWorker(recoveredJob);
		if (mappedJob) recoveredJobs.push(mappedJob);
	}

	return { recoveredJobs };
}

export async function requestDeepResearchWorkerCancellation(
	input: RequestDeepResearchWorkerCancellationInput,
): Promise<DeepResearchJob | null> {
	const now = input.now ?? new Date();
	const [job] = await db
		.select()
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.id, input.jobId),
				eq(deepResearchJobs.userId, input.userId),
			),
		)
		.limit(1);
	if (!job) return null;

	const previousStage = job.stage ?? "unknown";
	const [cancelledJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "cancelled",
			stage: "cancelled_by_request",
			cancelledAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, job.id),
				eq(deepResearchJobs.userId, input.userId),
				sql`${deepResearchJobs.status} IN ('awaiting_plan', 'awaiting_approval', 'approved', 'running')`,
			),
		)
		.returning();
	if (!cancelledJob) return loadDeepResearchJobForWorker(job);

	await cancelRunningResearchTasks({
		userId: input.userId,
		jobId: job.id,
		reason: "Deep Research job cancelled by user request.",
		now,
	});

	await saveResearchTimelineEvent({
		jobId: cancelledJob.id,
		conversationId: cancelledJob.conversationId,
		userId: cancelledJob.userId,
		taskId: null,
		stage: "report_completion",
		kind: "warning",
		occurredAt: now.toISOString(),
		messageKey: "deepResearch.timeline.workerCancelled",
		messageParams: {
			stage: previousStage,
		},
		sourceCounts: {
			discovered: 0,
			reviewed: 0,
			cited: 0,
		},
		assumptions: [],
		warnings: [
			`Cancellation requested while job was at stage ${previousStage}.`,
		],
		summary: "Deep Research job cancelled before further worker advancement.",
	});

	return loadDeepResearchJobForWorker(cancelledJob);
}

async function canStartApprovedJobWithinConcurrency(
	job: typeof deepResearchJobs.$inferSelect,
	nextStage: WorkerConcurrencyTransition,
	controls: DeepResearchWorkerControls | undefined,
): Promise<boolean> {
	if (nextStage.fromStatus !== "approved" || nextStage.toStatus !== "running") {
		return true;
	}
	if (!controls) return true;

	const globalLimit = normalizeConcurrencyLimit(
		controls.globalConcurrencyLimit,
	);
	if (globalLimit !== null) {
		const runningCount = await countRunningJobs();
		if (runningCount >= globalLimit) return false;
	}

	const userLimit = normalizeConcurrencyLimit(controls.userConcurrencyLimit);
	if (userLimit !== null) {
		const runningCount = await countRunningJobs(job.userId);
		if (runningCount >= userLimit) return false;
	}

	return true;
}

function isRealWorkflowWorkerEligibleJob(
	job: typeof deepResearchJobs.$inferSelect,
): boolean {
	if (job.status === "approved" && job.stage === "plan_approved") {
		return true;
	}
	return (
		job.status === "running" &&
		!!job.stage &&
		REAL_WORKFLOW_RUNNING_STAGES.includes(job.stage)
	);
}

async function runRealWorkflowWorkerStep(
	job: typeof deepResearchJobs.$inferSelect,
	now: Date,
	workflowStep: DeepResearchWorkflowStepRunner,
): Promise<RunNextDeepResearchWorkflowWorkerStepResult> {
	console.info("[DEEP_RESEARCH] Worker step start", {
		jobId: job.id,
		status: job.status,
		stage: job.stage,
		updatedAt: job.updatedAt.toISOString(),
	});
	const result = await workflowStep({
		userId: job.userId,
		jobId: job.id,
		now,
	});
	if (!result) return null;
	console.info("[DEEP_RESEARCH] Worker step completed", {
		jobId: result.job.id,
		advanced: result.advanced,
		outcome: result.outcome,
		status: result.job.status,
		stage: result.job.stage,
	});
	return {
		job: result.job,
		advanced: result.advanced,
	};
}

async function buildNotAdvancedWorkflowWorkerResult(
	job: typeof deepResearchJobs.$inferSelect,
): Promise<RunNextDeepResearchWorkflowWorkerStepResult> {
	const currentJob = await loadDeepResearchJobForWorker(job);
	if (!currentJob) return null;
	return {
		job: currentJob,
		advanced: false,
	};
}

async function countRunningJobs(userId?: string): Promise<number> {
	const where = userId
		? and(
				eq(deepResearchJobs.status, "running"),
				eq(deepResearchJobs.userId, userId),
			)
		: eq(deepResearchJobs.status, "running");
	const [result] = await db
		.select({ count: sql<number>`count(*)` })
		.from(deepResearchJobs)
		.where(where);

	return Number(result?.count ?? 0);
}

function normalizeConcurrencyLimit(value: number | undefined): number | null {
	if (value === undefined) return null;
	if (!Number.isFinite(value)) return null;
	return Math.max(0, Math.floor(value));
}

function normalizePositiveMilliseconds(value: number): number | null {
	if (!Number.isFinite(value)) return null;
	const normalized = Math.floor(value);
	return normalized > 0 ? normalized : null;
}

function normalizeRecoverableStage(stage: string | null | undefined): string {
	if (stage && REAL_WORKFLOW_RUNNING_STAGES.includes(stage)) return stage;
	return "source_review";
}

async function loadDeepResearchJobForWorker(
	job: typeof deepResearchJobs.$inferSelect,
): Promise<DeepResearchJob | null> {
	const jobs = await listConversationDeepResearchJobs(
		job.userId,
		job.conversationId,
	);
	return jobs.find((candidate) => candidate.id === job.id) ?? null;
}
