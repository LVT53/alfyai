<script lang="ts">
import { t } from "$lib/i18n";
import type { I18nKey } from "$lib/i18n";
import type {
	DeepResearchDepth,
	DeepResearchJob,
	DeepResearchJobStatus,
	DeepResearchReportIntent,
	DeepResearchSourceCounts,
	DeepResearchTimelineEvent,
	DeepResearchPlanSummary,
	DocumentWorkspaceItem,
	DeepResearchMemoRecoveryAction,
} from "$lib/types";

type VisiblePlanSection = {
	heading: string;
	items: string[];
};

type VisiblePlan = {
	sections: VisiblePlanSection[];
};

type TimelineStep = {
	id: string;
	labelKey: I18nKey;
	stages: string[];
	status: "completed" | "active" | "pending";
	events: TimelineEventView[];
};

type TimelineEventView = DeepResearchTimelineEvent & {
	showSourceCounts: boolean;
	isMeaningful: boolean;
};

type ResearchCardSeverity =
	| "awaiting_plan"
	| "needs_attention"
	| "working"
	| "completed"
	| "insufficient_evidence"
	| "cancelled"
	| "failed";

let {
	job,
	onApprove = undefined,
	onEdit = undefined,
	onCancel = undefined,
	onOpenReport = undefined,
	onDiscussReport = undefined,
	onResearchFurther = undefined,
	onAdvanceResearch = undefined,
}: {
	job: DeepResearchJob;
	onApprove?: ((jobId: string) => void | Promise<void>) | undefined;
	onEdit?:
		| ((
				jobId: string,
				instructions: string,
				reportIntent?: DeepResearchReportIntent,
		  ) => void | Promise<void>)
		| undefined;
	onCancel?: ((jobId: string) => void | Promise<void>) | undefined;
	onOpenReport?: ((document: DocumentWorkspaceItem) => void) | undefined;
	onDiscussReport?: ((jobId: string) => void | Promise<void>) | undefined;
	onResearchFurther?:
		| ((
				jobId: string,
				options?: { depth?: DeepResearchDepth },
		  ) => void | Promise<void>)
		| undefined;
	onAdvanceResearch?: ((jobId: string) => void | Promise<void>) | undefined;
} = $props();

let isEditingPlan = $state(false);
let planEditInstructions = $state("");
let selectedPlanReportIntent = $state<DeepResearchReportIntent | "">("");
let planEditPending = $state(false);
let planApprovalPending = $state(false);
let advancePending = $state(false);
let isStageDetailOpen = $state(false);
let isTimelineOpen = $state(false);
let timelinePreferenceJobId = $state<string | null>(null);
let hasManualTimelinePreference = $state(false);
let planEditError = $state<string | null>(null);
let advanceError = $state<string | null>(null);
let memoRecoveryPendingKey = $state<string | null>(null);
let memoRecoveryError = $state<string | null>(null);
let failedFavicons = $state<Record<string, true>>({});

let isOptimisticJob = $derived(job.id.startsWith("pending-deep-research-"));
let canCancel = $derived(
	!isOptimisticJob &&
		(job.status === "awaiting_plan" ||
			job.status === "awaiting_approval" ||
			job.status === "approved" ||
			job.status === "running"),
);
let canAdvanceResearch = $derived(
	job.status === "approved" || job.status === "running",
);
let activePlan = $derived(job.plan ?? job.currentPlan ?? null);
let isPlanRevisionNeeded = $derived(isPlanRevisionNeededJob(job, activePlan));
let activeReportIntent = $derived(activePlan?.rawPlan?.reportIntent ?? null);
let canApprovePlan = $derived(
	(job.status === "awaiting_approval" || isPlanRevisionNeeded) &&
		Boolean(activePlan),
);
let hasReportIntentEdit = $derived(
	Boolean(
		selectedPlanReportIntent && selectedPlanReportIntent !== activeReportIntent,
	),
);
let evidenceLimitationMemo = $derived(job.evidenceLimitationMemo ?? null);
let isEvidenceLimitationMemo = $derived(
	job.status === "completed" &&
		(job.stage === "evidence_limitation_memo_ready" ||
			Boolean(evidenceLimitationMemo)),
);
let isLimitedResearchReport = $derived(isLimitedResearchReportJob(job));
let researchSeverity = $derived(
	getResearchSeverity(job, isEvidenceLimitationMemo),
);
let reportDocument = $derived(buildReportDocument(job));
let openReportLabelKey = $derived(
	isLimitedResearchReport
		? "deepResearch.openLimitedReportLabel"
		: "deepResearch.openReportLabel",
);
let sourceCounts = $derived(
	job.sourceCounts ?? { discovered: 0, reviewed: 0, cited: 0 },
);
let visiblePlan = $derived(activePlan ? buildVisiblePlan(activePlan) : null);
let timelineSteps = $derived(buildTimelineSteps(job));
let visibleTimelineSteps = $derived(
	buildVisibleTimelineSteps(job, timelineSteps),
);
let effectiveTimelineOpen = $derived(
	timelinePreferenceJobId === job.id
		? isTimelineOpen
		: shouldOpenTimelineByDefault(job),
);
let activeStage = $derived(
	timelineSteps.find((step) => step.status === "active") ??
		timelineSteps.at(-1) ??
		null,
);
let activeStageLabelKey = $derived(
	activeStage
		? timelineStepLabelKey(job, activeStage)
		: "deepResearch.timeline.planDrafting",
);
let progressRingClass = $derived(
	`research-card__progress-ring research-card__progress-ring--${stageProgressBand(job)}`,
);
let stageDetailRows = $derived(buildStageDetailRows(job));
let costLabel = $derived(
	formatCostLabel(job.usageSummary?.totalCostUsdMicros ?? 0),
);
let finalResearchTimeLabel = $derived(formatFinalResearchTimeLabel(job));
let hasSourceLedgerProgress = $derived(
	sourceCounts.discovered > 0 ||
		sourceCounts.reviewed > 0 ||
		sourceCounts.cited > 0,
);
let visibleSources = $derived(
	(job.sources ?? [])
		.filter((source) => source.reviewedAt || source.citedAt)
		.slice(0, 4),
);

const depthKeys: Record<DeepResearchDepth, I18nKey> = {
	focused: "deepResearch.depth.focused",
	standard: "deepResearch.depth.standard",
	max: "deepResearch.depth.max",
};

const statusKeys: Record<DeepResearchJobStatus, I18nKey> = {
	awaiting_plan: "deepResearch.status.awaitingPlan",
	awaiting_approval: "deepResearch.status.awaitingApproval",
	approved: "deepResearch.status.approved",
	running: "deepResearch.status.running",
	completed: "deepResearch.status.completed",
	failed: "deepResearch.status.failed",
	cancelled: "deepResearch.status.cancelled",
};

const reportIntentKeys: Record<DeepResearchReportIntent, I18nKey> = {
	comparison: "deepResearch.reportIntent.comparison",
	recommendation: "deepResearch.reportIntent.recommendation",
	investigation: "deepResearch.reportIntent.investigation",
	market_scan: "deepResearch.reportIntent.marketScan",
	product_scan: "deepResearch.reportIntent.productScan",
	limitation_focused: "deepResearch.reportIntent.limitationFocused",
};

const reportIntentOptions = [
	"comparison",
	"recommendation",
	"investigation",
	"market_scan",
	"product_scan",
	"limitation_focused",
] satisfies DeepResearchReportIntent[];

$effect(() => {
	const defaultOpen = shouldOpenTimelineByDefault(job);
	if (timelinePreferenceJobId !== job.id) {
		timelinePreferenceJobId = job.id;
		hasManualTimelinePreference = false;
		isTimelineOpen = defaultOpen;
		return;
	}
	if (!hasManualTimelinePreference && defaultOpen) {
		isTimelineOpen = true;
	}
});

function getResearchSeverity(
	job: DeepResearchJob,
	hasEvidenceLimitationMemo: boolean,
): ResearchCardSeverity {
	if (hasEvidenceLimitationMemo) return "insufficient_evidence";
	if (isPlanRevisionNeededJob(job, job.plan ?? job.currentPlan ?? null))
		return "needs_attention";
	if (job.status === "awaiting_approval") return "needs_attention";
	if (job.status === "approved" || job.status === "running") return "working";
	if (job.status === "completed") return "completed";
	if (job.status === "cancelled") return "cancelled";
	if (job.status === "failed") return "failed";
	return "awaiting_plan";
}

function isPlanRevisionNeededJob(
	job: DeepResearchJob,
	plan: DeepResearchPlanSummary | null,
): boolean {
	return (
		job.status === "completed" &&
		job.stage === "plan_revision_needed" &&
		plan?.status === "awaiting_approval"
	);
}

function isLimitedResearchReportJob(job: DeepResearchJob): boolean {
	return (
		job.status === "completed" &&
		job.stage === "limited_research_report_ready" &&
		Boolean(job.reportArtifactId)
	);
}

function severityLabelKey(severity: ResearchCardSeverity): I18nKey {
	if (severity === "needs_attention")
		return "deepResearch.status.needsAttention";
	if (severity === "working") return "deepResearch.status.working";
	if (severity === "insufficient_evidence")
		return "deepResearch.status.insufficientEvidence";
	if (severity === "awaiting_plan") return statusKeys.awaiting_plan;
	return statusKeys[severity];
}

function sourceCountLabels(sourceCounts: DeepResearchSourceCounts) {
	return [
		$t("deepResearch.timeline.discovered", { count: sourceCounts.discovered }),
		$t("deepResearch.timeline.reviewed", { count: sourceCounts.reviewed }),
		$t("deepResearch.timeline.cited", { count: sourceCounts.cited }),
	];
}

function markFaviconFailed(sourceId: string) {
	failedFavicons = {
		...failedFavicons,
		[sourceId]: true,
	};
}

function handleStageDetailKeydown(event: KeyboardEvent) {
	if (event.key === "Escape") {
		isStageDetailOpen = false;
	}
}

function formatReportIntent(intent: DeepResearchReportIntent): string {
	return $t(reportIntentKeys[intent]);
}

function isInternalApprovalConstraint(value: string): boolean {
	return (
		/do not start source-heavy research until the research plan is approved/i.test(
			value,
		) || /ne induljon forrásigényes kutatás/i.test(value)
	);
}

function compactItems(items: Array<string | null | undefined>): string[] {
	return items
		.map((item) => item?.trim() ?? "")
		.filter((item) => item.length > 0 && !isInternalApprovalConstraint(item));
}

function buildVisiblePlan(plan: DeepResearchPlanSummary): VisiblePlan {
	if (plan.rawPlan) {
		const rawPlan = plan.rawPlan;
		const sections: VisiblePlanSection[] = [];
		const keyQuestions = compactItems(rawPlan.keyQuestions);
		if (keyQuestions.length > 0) {
			sections.push({
				heading: $t("deepResearch.plan.keyQuestions"),
				items: keyQuestions,
			});
		}

		const deliverables = compactItems(rawPlan.deliverables);
		if (deliverables.length > 0) {
			sections.push({
				heading: $t("deepResearch.plan.deliverables"),
				items: deliverables,
			});
		}

		return { sections };
	}

	return parseRenderedPlan(plan.renderedPlan);
}

function parseRenderedPlan(renderedPlan: string): VisiblePlan {
	const lines = renderedPlan
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => {
			if (!line) return false;
			if (/^#\s+/.test(line)) return false;
			if (/^(Research Plan|Kutatási terv)$/i.test(line)) return false;
			if (/^(Cost|Költség):/i.test(line)) return false;
			if (
				/^(Key questions|Kulcskérdések|Deliverables|Eredmények|Research steps|Kutatási lépések):?$/i.test(
					line,
				)
			)
				return false;
			if (isInternalApprovalConstraint(line.replace(/^-\s*/, ""))) return false;
			return true;
		});
	const goalIndex = lines.findIndex((line) => /^(Goal|Cél):/i.test(line));
	const remaining = lines.filter((_, index) => index !== goalIndex);
	const goalLine =
		goalIndex >= 0
			? lines[goalIndex]?.replace(/^(Goal|Cél):\s*/i, "").trim()
			: "";
	const sections: VisiblePlanSection[] = [];
	if (goalLine) {
		sections.push({ heading: $t("deepResearch.plan.goal"), items: [goalLine] });
	}
	const keyQuestionItems = remaining.filter(
		(line) =>
			!/^(Goal|Cél|Expected report shape|Várt jelentésszerkezet):/i.test(line),
	);
	if (keyQuestionItems.length > 0) {
		sections.push({
			heading: $t("deepResearch.plan.keyQuestions"),
			items: keyQuestionItems,
		});
	}
	return {
		sections,
	};
}

function formatCostLabel(costUsdMicros: number): string | null {
	if (!Number.isFinite(costUsdMicros) || costUsdMicros <= 0) return null;
	return $t("deepResearch.estimatedCost", {
		cost: `$${(costUsdMicros / 1_000_000).toFixed(4)}`,
	});
}

function formatFinalResearchTimeLabel(job: DeepResearchJob): string | null {
	if (job.status !== "completed") return null;
	const runtimeMs =
		job.runtimeEstimate?.actualRuntimeMs ??
		(job.completedAt && job.createdAt ? job.completedAt - job.createdAt : null);
	if (!runtimeMs || !Number.isFinite(runtimeMs) || runtimeMs <= 0) return null;
	const totalSeconds = Math.max(1, Math.round(runtimeMs / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const time =
		hours > 0
			? `${hours}h ${String(minutes).padStart(2, "0")}m`
			: `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	return $t("deepResearch.finalResearchTime", { time });
}

function buildTimelineSteps(job: DeepResearchJob): TimelineStep[] {
	const currentIndex = activeTimelineIndex(job);
	const timelineEvents = buildTimelineEventViews(job.timeline ?? []);
	const isTerminalCompleted =
		job.status === "completed" &&
		!isPlanRevisionNeededJob(job, job.plan ?? job.currentPlan ?? null);
	return TIMELINE_STEP_DEFINITIONS.map((step, index) => {
		const events = timelineEvents.filter((event) =>
			step.stages.includes(event.stage),
		);
		return {
			...step,
			status:
				isTerminalCompleted || index < currentIndex
					? "completed"
					: index === currentIndex
						? "active"
						: "pending",
			events,
		};
	}).filter((step, index) => {
		if (step.events.length > 0) return true;
		if (index === currentIndex) return true;
		if (job.status === "awaiting_approval" && step.id === "plan-drafted")
			return true;
		return false;
	});
}

function buildVisibleTimelineSteps(
	job: DeepResearchJob,
	steps: TimelineStep[],
): TimelineStep[] {
	if (job.status !== "running" && job.status !== "approved") return steps;
	return steps
		.map((step) => ({
			...step,
			events: step.events.filter((event) => event.isMeaningful),
		}))
		.filter((step) => step.events.length > 0);
}

function stageProgressBand(
	job: DeepResearchJob,
): "start" | "early" | "middle" | "late" | "done" {
	const index = activeTimelineIndex(job);
	if (isPlanRevisionNeededJob(job, job.plan ?? job.currentPlan ?? null))
		return "early";
	if (job.status === "completed") return "done";
	if (index <= 1) return "start";
	if (index <= 3) return "early";
	if (index <= 6) return "middle";
	return "late";
}

function buildStageDetailRows(job: DeepResearchJob): string[] {
	return [
		formatPassProgress(job),
		formatOpenCoverageGaps(job),
		formatResolvedClaimConflicts(job),
		formatAuditRepairState(job),
	].filter((row): row is string => Boolean(row));
}

function formatPassProgress(job: DeepResearchJob): string | null {
	const checkpoints = job.passCheckpoints ?? [];
	if (checkpoints.length === 0) return null;
	const completed = checkpoints.filter(
		(checkpoint) => checkpoint.lifecycleState === "decided",
	).length;
	const running = checkpoints.filter(
		(checkpoint) => checkpoint.lifecycleState === "running",
	).length;
	if (completed > 0 && running > 0) {
		const key =
			completed === 1 && running === 1
				? "deepResearch.progress.meaningfulPassesCompletedAndRunning"
				: "deepResearch.progress.meaningfulPassesCompletedAndRunningPlural";
		return $t(key, {
			completed,
			running,
		});
	}
	if (completed > 0) {
		return $t(
			completed === 1
				? "deepResearch.progress.meaningfulPassesCompleted"
				: "deepResearch.progress.meaningfulPassesCompletedPlural",
			{ count: completed },
		);
	}
	if (running > 0) {
		return $t(
			running === 1
				? "deepResearch.progress.meaningfulPassesRunning"
				: "deepResearch.progress.meaningfulPassesRunningPlural",
			{ count: running },
		);
	}
	return null;
}

function formatOpenCoverageGaps(job: DeepResearchJob): string | null {
	const openGaps = (job.coverageGaps ?? []).filter(
		(gap) =>
			gap.lifecycleState === "open" || gap.lifecycleState === "in_progress",
	).length;
	if (openGaps === 0) return null;
	return $t(
		openGaps === 1
			? "deepResearch.progress.openCoverageGaps"
			: "deepResearch.progress.openCoverageGapsPlural",
		{ count: openGaps },
	);
}

function formatResolvedClaimConflicts(job: DeepResearchJob): string | null {
	const conflictGroups = new Map<string, Set<string>>();
	for (const claim of job.synthesisClaims ?? []) {
		if (!claim.competingClaimGroupId || claim.status === "needs-repair")
			continue;
		const statuses =
			conflictGroups.get(claim.competingClaimGroupId) ?? new Set<string>();
		statuses.add(claim.status);
		conflictGroups.set(claim.competingClaimGroupId, statuses);
	}
	const resolvedConflicts = [...conflictGroups.values()].filter(
		(statuses) => statuses.has("accepted") && statuses.has("rejected"),
	).length;
	if (resolvedConflicts === 0) return null;
	return $t(
		resolvedConflicts === 1
			? "deepResearch.progress.resolvedClaimConflicts"
			: "deepResearch.progress.resolvedClaimConflictsPlural",
		{ count: resolvedConflicts },
	);
}

function formatAuditRepairState(job: DeepResearchJob): string | null {
	if (hasRunningCitationAuditRepair(job))
		return $t("deepResearch.progress.auditRepairRunning");
	const needsRepair = (job.synthesisClaims ?? []).some(
		(claim) => claim.status === "needs-repair",
	);
	if (needsRepair) return $t("deepResearch.progress.auditRepairNeeded");
	return null;
}

function hasRunningCitationAuditRepair(job: DeepResearchJob): boolean {
	const repairPoint = (job.resumePoints ?? []).find(
		(point) => point.boundary === "repair" && point.status === "running",
	);
	if (repairPoint) return true;
	return (
		job.stage === "research_tasks" &&
		(job.passCheckpoints ?? []).some(
			(checkpoint) =>
				checkpoint.lifecycleState === "running" &&
				/\b(repair|citation audit)\b/i.test(checkpoint.searchIntent),
		)
	);
}

function buildTimelineEventViews(
	events: DeepResearchTimelineEvent[],
): TimelineEventView[] {
	let previousCounts: DeepResearchSourceCounts | null = null;
	return events.map((event) => {
		const countsChanged = previousCounts
			? !sameSourceCounts(previousCounts, event.sourceCounts)
			: hasAnySourceCounts(event.sourceCounts);
		const showSourceCounts =
			countsChanged ||
			isSourceSpecificTimelineEvent(event) ||
			event.warnings.length > 0;
		const isMeaningful =
			countsChanged ||
			isSourceSpecificTimelineEvent(event) ||
			isDecisionTimelineEvent(event) ||
			isTerminalTimelineEvent(event) ||
			event.assumptions.length > 0 ||
			event.warnings.length > 0;
		previousCounts = event.sourceCounts;
		return {
			...event,
			showSourceCounts,
			isMeaningful,
		};
	});
}

function sameSourceCounts(
	a: DeepResearchSourceCounts,
	b: DeepResearchSourceCounts,
): boolean {
	return (
		a.discovered === b.discovered &&
		a.reviewed === b.reviewed &&
		a.cited === b.cited
	);
}

function hasAnySourceCounts(sourceCounts: DeepResearchSourceCounts): boolean {
	return (
		sourceCounts.discovered > 0 ||
		sourceCounts.reviewed > 0 ||
		sourceCounts.cited > 0
	);
}

function isSourceSpecificTimelineEvent(
	event: DeepResearchTimelineEvent,
): boolean {
	const eventText =
		`${event.stage} ${event.kind} ${event.messageKey}`.toLowerCase();
	return eventText.includes("source") || eventText.includes("citation");
}

function isDecisionTimelineEvent(event: DeepResearchTimelineEvent): boolean {
	const eventText =
		`${event.stage} ${event.kind} ${event.messageKey}`.toLowerCase();
	return (
		eventText.includes("coverage") ||
		eventText.includes("repair") ||
		eventText.includes("assumption")
	);
}

function isTerminalTimelineEvent(event: DeepResearchTimelineEvent): boolean {
	const eventText =
		`${event.stage} ${event.kind} ${event.messageKey}`.toLowerCase();
	return (
		eventText.includes("completed") ||
		eventText.includes("memo") ||
		eventText.includes("failed") ||
		eventText.includes("cancelled")
	);
}

function countTimelineAttentionEvents(job: DeepResearchJob): number {
	return (job.timeline ?? []).filter((event) => {
		const eventText =
			`${event.stage} ${event.kind} ${event.messageKey}`.toLowerCase();
		return (
			event.warnings.length > 0 ||
			eventText.includes("failed") ||
			eventText.includes("failure") ||
			eventText.includes("memo")
		);
	}).length;
}

function shouldOpenTimelineByDefault(job: DeepResearchJob): boolean {
	if (job.status !== "running" && job.status !== "approved") return true;
	return countTimelineAttentionEvents(job) > 0;
}

function showTimelineStepLabel(job: DeepResearchJob): boolean {
	return job.status !== "running" && job.status !== "approved";
}

function toggleTimeline() {
	hasManualTimelinePreference = true;
	isTimelineOpen = !effectiveTimelineOpen;
}

function timelineEventSummary(event: TimelineEventView): string {
	if (!isLocalizableTimelineSummary(event)) {
		return event.summary;
	}
	if (event.messageKey === "deepResearch.timeline.planGenerated") {
		return $t("deepResearch.timeline.summary.planGenerated");
	}
	if (event.messageKey === "deepResearch.timeline.planRevisionNeeded") {
		return $t("deepResearch.timeline.summary.planRevisionNeeded");
	}
	if (event.messageKey === "deepResearch.timeline.sourceDiscoveryCompleted") {
		return $t("deepResearch.timeline.summary.sourceDiscoveryCompleted", {
			count: timelineNumberParam(
				event,
				["discoveredSources"],
				event.sourceCounts.discovered,
			),
		});
	}
	if (event.messageKey === "deepResearch.timeline.sourceReviewCompleted") {
		return $t("deepResearch.timeline.summary.sourceReviewCompleted", {
			count: timelineNumberParam(
				event,
				["reviewedSources"],
				event.sourceCounts.reviewed,
			),
		});
	}
	if (event.messageKey === "deepResearch.timeline.researchTasksCompleted") {
		return $t("deepResearch.timeline.summary.researchTasksCompleted", {
			passNumber: timelineNumberParam(event, ["passNumber"], 1),
			count: timelineNumberParam(event, ["completedTasks"], 0),
		});
	}
	if (event.messageKey === "deepResearch.timeline.coverageSufficient") {
		return $t("deepResearch.timeline.summary.coverageSufficient");
	}
	if (event.messageKey === "deepResearch.timeline.coverageLimited") {
		return $t("deepResearch.timeline.summary.coverageLimited");
	}
	if (event.messageKey === "deepResearch.timeline.coverageInsufficient") {
		return $t("deepResearch.timeline.summary.coverageInsufficient");
	}
	if (event.messageKey === "deepResearch.timeline.citationAuditCompleted") {
		return $t("deepResearch.timeline.summary.citationAuditCompleted");
	}
	if (event.messageKey === "deepResearch.timeline.citationAuditFailed") {
		return $t("deepResearch.timeline.summary.citationAuditFailed");
	}
	if (
		event.messageKey === "deepResearch.timeline.citationAuditRepairPassCreated"
	) {
		return $t("deepResearch.timeline.summary.citationAuditRepairPassCreated", {
			passNumber: timelineNumberParam(event, ["passNumber"], 1),
			count: timelineNumberParam(event, ["repairTasks"], 0),
		});
	}
	if (
		event.messageKey === "deepResearch.timeline.evidenceLimitationMemoCompleted"
	) {
		return $t("deepResearch.timeline.summary.evidenceLimitationMemoCompleted");
	}
	if (event.messageKey === "deepResearch.timeline.workerCancelled") {
		return $t("deepResearch.timeline.summary.workerCancelled");
	}
	if (event.messageKey === "deepResearch.timeline.workerStaleRecovered") {
		return $t("deepResearch.timeline.summary.workerStaleRecovered");
	}
	return event.summary;
}

function isLocalizableTimelineSummary(
	event: DeepResearchTimelineEvent,
): boolean {
	const summary = event.summary.trim();
	if (event.messageKey === "deepResearch.timeline.planGenerated") {
		return summary === "Research Plan drafted for approval.";
	}
	if (event.messageKey === "deepResearch.timeline.planRevisionNeeded") {
		return (
			summary ===
			"Research Plan revision needed; corrected draft is ready for approval."
		);
	}
	if (event.messageKey === "deepResearch.timeline.sourceDiscoveryCompleted") {
		return /^Discovered \d+ public web source candidates\.$/.test(summary);
	}
	if (event.messageKey === "deepResearch.timeline.sourceReviewCompleted") {
		return /^Source review completed for \d+ reviewed sources?\.$/.test(
			summary,
		);
	}
	if (event.messageKey === "deepResearch.timeline.researchTasksCompleted") {
		return /^Research task pass \d+ completed with \d+ completed tasks?\.$/.test(
			summary,
		);
	}
	if (event.messageKey === "deepResearch.timeline.coverageSufficient") {
		return (
			summary ===
			"Reviewed evidence covers the approved Research Plan key questions."
		);
	}
	if (event.messageKey === "deepResearch.timeline.coverageLimited") {
		return (
			summary ===
			"Depth budget is exhausted; incomplete coverage will be disclosed as report limitations."
		);
	}
	if (event.messageKey === "deepResearch.timeline.coverageInsufficient") {
		return summary === "Coverage gaps remain before report synthesis.";
	}
	if (event.messageKey === "deepResearch.timeline.citationAuditCompleted") {
		return (
			summary ===
			"Citation audit completed and unsupported claims were removed or retained with citations."
		);
	}
	if (event.messageKey === "deepResearch.timeline.citationAuditFailed") {
		return (
			summary ===
			"Citation audit failed because no credible supported claims remained."
		);
	}
	if (
		event.messageKey === "deepResearch.timeline.citationAuditRepairPassCreated"
	) {
		return /^Citation audit created repair pass \d+ with \d+ repair tasks?\.$/.test(
			summary,
		);
	}
	if (
		event.messageKey === "deepResearch.timeline.evidenceLimitationMemoCompleted"
	) {
		return (
			summary ===
			"Research completed with an Evidence Limitation Memo because there was not enough credible topic-relevant evidence."
		);
	}
	if (event.messageKey === "deepResearch.timeline.workerCancelled") {
		return (
			summary ===
			"Deep Research job cancelled before further worker advancement."
		);
	}
	if (event.messageKey === "deepResearch.timeline.workerStaleRecovered") {
		return (
			summary ===
			"Deep Research job resumed from the latest durable Research Resume Point after exceeding the stale worker timeout."
		);
	}
	return false;
}

function timelineNumberParam(
	event: DeepResearchTimelineEvent,
	names: string[],
	fallback: number,
): number {
	for (const name of names) {
		const value = event.messageParams?.[name];
		const parsed = typeof value === "number" ? value : Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

function activeTimelineIndex(job: DeepResearchJob): number {
	if (isPlanRevisionNeededJob(job, job.plan ?? job.currentPlan ?? null)) {
		return TIMELINE_STEP_DEFINITIONS.findIndex((step) =>
			step.stages.includes("plan_revision_needed"),
		);
	}
	if (job.status === "completed") return TIMELINE_STEP_DEFINITIONS.length - 1;
	if (job.status === "awaiting_approval")
		return TIMELINE_STEP_DEFINITIONS.findIndex(
			(step) => step.id === "approval",
		);
	const stage = job.stage ?? "";
	const index = TIMELINE_STEP_DEFINITIONS.findIndex((step) =>
		step.stages.includes(stage),
	);
	return Math.max(0, index);
}

function timelineStepLabelKey(
	job: DeepResearchJob,
	step: TimelineStep,
): I18nKey {
	if (step.id === "gaps" && hasRunningCitationAuditRepair(job)) {
		return "deepResearch.timeline.repairingCitations";
	}
	return step.labelKey;
}

const TIMELINE_STEP_DEFINITIONS = [
	{
		id: "plan",
		labelKey: "deepResearch.timeline.planDrafting",
		stages: ["plan_generation"],
	},
	{
		id: "plan-drafted",
		labelKey: "deepResearch.timeline.planDrafted",
		stages: ["plan_drafted", "plan_revised"],
	},
	{
		id: "plan-revision-needed",
		labelKey: "deepResearch.timeline.planRevisionNeeded",
		stages: ["plan_revision_needed"],
	},
	{
		id: "approval",
		labelKey: "deepResearch.timeline.awaitingApproval",
		stages: ["plan_approved"],
	},
	{
		id: "discovery",
		labelKey: "deepResearch.timeline.discoveringSources",
		stages: ["source_discovery"],
	},
	{
		id: "review",
		labelKey: "deepResearch.timeline.reviewingSources",
		stages: ["source_review"],
	},
	{
		id: "coverage",
		labelKey: "deepResearch.timeline.checkingCoverage",
		stages: ["coverage_assessment"],
	},
	{
		id: "gaps",
		labelKey: "deepResearch.timeline.fillingGaps",
		stages: ["research_tasks"],
	},
	{
		id: "synthesis",
		labelKey: "deepResearch.timeline.synthesizing",
		stages: ["synthesis"],
	},
	{
		id: "audit",
		labelKey: "deepResearch.timeline.auditingCitations",
		stages: ["citation_audit", "citation_audit_failed"],
	},
	{
		id: "writing",
		labelKey: "deepResearch.timeline.writingReport",
		stages: ["report_assembly", "report_writing", "report_ready"],
	},
	{
		id: "completed",
		labelKey: "deepResearch.timeline.completed",
		stages: ["completed"],
	},
] satisfies Array<Omit<TimelineStep, "status" | "events">>;

function cancelJob() {
	if (!canCancel || !onCancel) return;
	void onCancel(job.id);
}

function buildReportFilename(
	title: string,
	prefix = "Research Report",
): string {
	const safeTitle = title
		.replace(/[\\/:*?"<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 96);
	return `${prefix} - ${safeTitle || "Deep Research"}.md`;
}

function buildReportDocument(
	job: DeepResearchJob,
): DocumentWorkspaceItem | null {
	if (job.status !== "completed" || !job.reportArtifactId) return null;
	if (
		job.stage === "evidence_limitation_memo_ready" ||
		job.evidenceLimitationMemo
	)
		return null;
	const filename = buildReportFilename(
		job.title,
		isLimitedResearchReportJob(job)
			? $t("deepResearch.limitedReport.filenamePrefix")
			: undefined,
	);
	return {
		id: `artifact:${job.reportArtifactId}`,
		source: "knowledge_artifact",
		filename,
		title: filename,
		documentLabel: filename,
		documentRole: "research_report",
		versionNumber: 1,
		mimeType: "text/markdown",
		artifactId: job.reportArtifactId,
		conversationId: job.conversationId,
		previewUrl: `/api/knowledge/${job.reportArtifactId}/preview`,
		downloadUrl: `/api/knowledge/${job.reportArtifactId}/download`,
	};
}

function openReport() {
	if (!reportDocument || !onOpenReport) return;
	onOpenReport(reportDocument);
}

function discussResearchArtifact() {
	if (!onDiscussReport) return;
	return onDiscussReport(job.id);
}

function researchFurther(options?: { depth?: DeepResearchDepth }) {
	if (!onResearchFurther) return;
	if (options) {
		return onResearchFurther(job.id, options);
	}
	return onResearchFurther(job.id);
}

function nextDeeperDepth(depth: DeepResearchDepth): DeepResearchDepth {
	if (depth === "focused") return "standard";
	return "max";
}

function memoRecoveryActionKey(action: { kind: string }): string {
	if (action.kind === "choose_deeper_depth") {
		return `${action.kind}:${nextDeeperDepth(job.depth)}`;
	}
	return action.kind;
}

function canRunMemoRecoveryAction(action: { kind: string }): boolean {
	if (memoRecoveryPendingKey) return false;
	if (action.kind === "add_sources") return Boolean(onDiscussReport);
	return Boolean(onResearchFurther);
}

async function runMemoRecoveryAction(action: DeepResearchMemoRecoveryAction) {
	if (!canRunMemoRecoveryAction(action)) return;
	const actionKey = memoRecoveryActionKey(action);
	memoRecoveryPendingKey = actionKey;
	memoRecoveryError = null;
	try {
		if (action.kind === "add_sources") {
			await discussResearchArtifact();
			return;
		}
		await researchFurther(
			action.kind === "choose_deeper_depth"
				? { depth: nextDeeperDepth(job.depth) }
				: undefined,
		);
	} catch (err) {
		memoRecoveryError =
			err instanceof Error ? err.message : $t("deepResearch.memo.actionFailed");
	} finally {
		memoRecoveryPendingKey = null;
	}
}

async function advanceResearch() {
	if (!canAdvanceResearch || !onAdvanceResearch || advancePending) return;
	advancePending = true;
	advanceError = null;
	try {
		await onAdvanceResearch(job.id);
	} catch (err) {
		advanceError =
			err instanceof Error
				? err.message
				: $t("deepResearch.advanceWorkflowFailed");
	} finally {
		advancePending = false;
	}
}

async function approvePlan() {
	if (!canApprovePlan || !onApprove || planApprovalPending) return;
	planApprovalPending = true;
	try {
		await onApprove(job.id);
	} catch (err) {
		planEditError =
			err instanceof Error ? err.message : $t("deepResearch.approvePlanFailed");
	} finally {
		planApprovalPending = false;
	}
}

function editPlan() {
	if (!canApprovePlan || !onEdit) return;
	selectedPlanReportIntent = activeReportIntent ?? "";
	isEditingPlan = true;
	planEditError = null;
}

async function submitPlanEdit(event: SubmitEvent) {
	event.preventDefault();
	if (!canApprovePlan || !onEdit || planEditPending || planApprovalPending)
		return;
	const trimmedInstructions = planEditInstructions.trim();
	const reportIntent = hasReportIntentEdit
		? selectedPlanReportIntent
		: undefined;
	if (!trimmedInstructions && !reportIntent) return;

	planEditPending = true;
	planEditError = null;
	try {
		if (reportIntent) {
			await onEdit(job.id, trimmedInstructions, reportIntent);
		} else {
			await onEdit(job.id, trimmedInstructions);
		}
		planEditInstructions = "";
		selectedPlanReportIntent = "";
		isEditingPlan = false;
	} catch (err) {
		planEditError =
			err instanceof Error ? err.message : $t("deepResearch.editPlanFailed");
	} finally {
		planEditPending = false;
	}
}
</script>

<svelte:window onkeydown={handleStageDetailKeydown} />

<article
	class="research-card"
	aria-label={$t('deepResearch.cardLabel', { title: job.title })}
>
	<div class="research-card__header">
		<div class="research-card__title-group">
			<div class="research-card__eyebrow">{$t('composerTools.deepResearch')}</div>
			<h2 class="research-card__title" title={job.title}>{job.title}</h2>
		</div>
		<div class="research-card__header-actions">
			<button
				type="button"
				class="research-card__progress-button"
				aria-label={$t('deepResearch.progress.showDetails')}
				aria-expanded={isStageDetailOpen}
				onclick={() => {
					isStageDetailOpen = !isStageDetailOpen;
				}}
			>
				<span class={progressRingClass} aria-hidden="true"></span>
				<span class="research-card__progress-stage">
					{$t('deepResearch.progress.stagePrefix')}{$t(activeStageLabelKey)}
				</span>
			</button>
			<div class="research-card__depth">{$t(depthKeys[job.depth])}</div>
		</div>
	</div>

	{#if isStageDetailOpen}
		<div
			class="research-card__progress-popover"
			role="dialog"
			aria-label={$t('deepResearch.progress.detailsLabel')}
		>
			<div class="research-card__progress-popover-header">
				<strong>{$t('deepResearch.progress.detailsLabel')}</strong>
				<button
					type="button"
					class="research-card__progress-close"
					aria-label={$t('deepResearch.progress.dismissDetails')}
					onclick={() => {
						isStageDetailOpen = false;
					}}
				>
					x
				</button>
			</div>
			<p class="research-card__progress-current">
				{$t('deepResearch.progress.currentStage', {
					stage: $t(activeStageLabelKey),
				})}
			</p>
			{#if stageDetailRows.length > 0}
				<ul>
					{#each stageDetailRows as row}
						<li>{row}</li>
					{/each}
				</ul>
			{:else}
				<p class="research-card__progress-empty">{$t('deepResearch.progress.noDetailsYet')}</p>
			{/if}
		</div>
	{/if}

	<div class="research-card__meta">
		<span class={`research-card__status research-card__status--${researchSeverity}`}>
			<span class="research-card__status-dot" aria-hidden="true"></span>
			{$t(severityLabelKey(researchSeverity))}
		</span>
		{#if job.status === 'completed' && costLabel}
			<span class="research-card__cost">{costLabel}</span>
		{/if}
		{#if finalResearchTimeLabel}
			<span class="research-card__cost">{finalResearchTimeLabel}</span>
		{/if}
	</div>

	{#if activePlan}
		<section class="research-card__plan" aria-labelledby={`${job.id}-research-plan-heading`}>
			<div class="research-card__section-header">
				<h3 id={`${job.id}-research-plan-heading`}>{$t('deepResearch.planHeading')}</h3>
				<span>v{activePlan.version}</span>
			</div>

			{#if isPlanRevisionNeeded}
				<div class="research-card__notice research-card__notice--attention">
					<strong>{$t('deepResearch.planRevision.heading')}</strong>
					<p>{$t('deepResearch.planRevision.body')}</p>
				</div>
			{/if}

			<div class="research-card__effort" aria-label={$t('deepResearch.effortHeading')}>
				<span>
					<strong>{$t('deepResearch.expectedTime')}</strong>
					{job.runtimeEstimate?.label ?? activePlan.effortEstimate.expectedTimeBand}
				</span>
				<span>
					{$t('deepResearch.sourceCeiling', {
						count: activePlan.effortEstimate.sourceReviewCeiling,
					})}
				</span>
			</div>

			{#if activePlan.contextDisclosure}
				<p class="research-card__context">
					<strong>{$t('deepResearch.contextConsidered')}:</strong>
					{activePlan.contextDisclosure}
				</p>
			{/if}

			{#if activeReportIntent}
				<p class="research-card__intent">
					<strong>{$t('deepResearch.reportIntentLabel')}:</strong>
					{formatReportIntent(activeReportIntent)}
				</p>
			{/if}

			{#if visiblePlan}
				<div class="research-card__plan-text">
					{#each visiblePlan.sections as section}
						<div class="research-card__plan-section">
							<strong>{section.heading}</strong>
							<ul>
								{#each section.items as item}
									<li>{item.replace(/^-\s*/, '')}</li>
								{/each}
							</ul>
						</div>
					{/each}
				</div>
			{/if}

			{#if isEditingPlan}
				<form class="research-card__edit-form" onsubmit={submitPlanEdit}>
					{#if activeReportIntent}
						<label class="research-card__edit-label" for={`${job.id}-plan-report-intent`}>
							{$t('deepResearch.reportIntentLabel')}
						</label>
						<select
							id={`${job.id}-plan-report-intent`}
							class="research-card__edit-select"
							bind:value={selectedPlanReportIntent}
							disabled={planEditPending}
						>
							{#each reportIntentOptions as intent}
								<option value={intent}>{formatReportIntent(intent)}</option>
							{/each}
						</select>
					{/if}
					<label class="research-card__edit-label" for={`${job.id}-plan-edit`}>
						{$t('deepResearch.planEditInstructions')}
					</label>
					<textarea
						id={`${job.id}-plan-edit`}
						class="research-card__edit-textarea"
						bind:value={planEditInstructions}
						disabled={planEditPending}
						rows="3"
					></textarea>
					{#if planEditError}
						<p class="research-card__error" role="alert">{planEditError}</p>
					{/if}
					<div class="research-card__edit-actions">
						<button
							type="submit"
							class="research-card__action research-card__action--primary"
							disabled={planEditPending || (!planEditInstructions.trim() && !hasReportIntentEdit)}
						>
							{planEditPending
								? $t('deepResearch.submittingPlanEdit')
								: $t('deepResearch.submitPlanEdit')}
						</button>
						<button
							type="button"
							class="research-card__action"
							disabled={planEditPending}
							onclick={() => {
								isEditingPlan = false;
								planEditError = null;
								selectedPlanReportIntent = '';
							}}
						>
							{$t('common.cancel')}
						</button>
					</div>
				</form>
			{:else if planEditError}
				<p class="research-card__error" role="alert">{planEditError}</p>
			{/if}
		</section>
	{:else if job.status === 'awaiting_plan'}
		<section class="research-card__planning" aria-live="polite">
			<div class="research-card__planning-spinner" aria-hidden="true"></div>
			<div>
				<strong>{$t('deepResearch.planningInProgress')}</strong>
				<p>{$t('deepResearch.planningInProgressDetail')}</p>
			</div>
		</section>
	{/if}

	{#if isLimitedResearchReport}
		<section
			class="research-card__notice research-card__notice--limited"
			aria-labelledby={`${job.id}-limited-report-heading`}
		>
			<h3 id={`${job.id}-limited-report-heading`}>{$t('deepResearch.limitedReport.heading')}</h3>
			<p>{$t('deepResearch.limitedReport.body')}</p>
		</section>
	{/if}

	{#if hasSourceLedgerProgress}
		<section class="research-card__sources" aria-labelledby={`${job.id}-sources-heading`}>
			<div class="research-card__section-header">
				<h3 id={`${job.id}-sources-heading`}>{$t('deepResearch.sourcesHeading')}</h3>
			</div>
			<div class="research-card__source-counts" aria-label={$t('deepResearch.sourceCountsLabel')}>
				{#each sourceCountLabels(sourceCounts) as label}
					<span>{label}</span>
				{/each}
			</div>
			{#if visibleSources.length > 0}
				<div class="research-card__reviewed-sources">
					<strong>{$t('deepResearch.reviewedSourcesHeading')}</strong>
					<ul>
						{#each visibleSources as source (source.id)}
							<li>
								<span class="research-card__source-favicon" aria-hidden="true">
									{#if source.faviconUrl && !failedFavicons[source.id]}
										<img
											src={source.faviconUrl}
											alt=""
											loading="lazy"
											onerror={() => markFaviconFailed(source.id)}
										/>
									{:else}
										<span class="research-card__source-favicon-fallback"></span>
									{/if}
								</span>
								<a href={source.url} target="_blank" rel="noreferrer">
									{source.title ?? source.url}
								</a>
								<span>
									{source.citedAt
										? $t('deepResearch.sourceStatus.cited')
										: $t('deepResearch.sourceStatus.reviewed')}
								</span>
								{#if source.citationNote ?? source.reviewedNote}
									<p>{source.citationNote ?? source.reviewedNote}</p>
								{/if}
							</li>
						{/each}
					</ul>
				</div>
			{/if}
		</section>
	{/if}

	{#if isEvidenceLimitationMemo && evidenceLimitationMemo}
		<section class="research-card__memo" aria-labelledby={`${job.id}-memo-heading`}>
			<div class="research-card__section-header">
				<h3 id={`${job.id}-memo-heading`}>{$t('deepResearch.memo.heading')}</h3>
			</div>

			<div class="research-card__memo-group">
				<strong>{$t('deepResearch.memo.reviewedScope')}</strong>
				<div class="research-card__source-counts" aria-label={$t('deepResearch.memo.reviewedScope')}>
					<span>{$t('deepResearch.timeline.discovered', { count: evidenceLimitationMemo.reviewedScope.discoveredCount })}</span>
					<span>{$t('deepResearch.timeline.reviewed', { count: evidenceLimitationMemo.reviewedScope.reviewedCount })}</span>
					<span>{$t('deepResearch.memo.topicRelevant', { count: evidenceLimitationMemo.reviewedScope.topicRelevantCount })}</span>
					<span>{$t('deepResearch.memo.rejectedOrOffTopic', { count: evidenceLimitationMemo.reviewedScope.rejectedOrOffTopicCount })}</span>
				</div>
			</div>

			<div class="research-card__memo-group">
				<strong>{$t('deepResearch.memo.limitations')}</strong>
				<ul>
					{#each evidenceLimitationMemo.limitations as limitation}
						<li>{limitation}</li>
					{/each}
				</ul>
			</div>

			<div class="research-card__memo-group">
				<strong>{$t('deepResearch.memo.nextDirection')}</strong>
				<p>{evidenceLimitationMemo.nextResearchDirection}</p>
			</div>

			<div class="research-card__memo-group">
				<strong>{$t('deepResearch.memo.recoveryActions')}</strong>
				<ul class="research-card__memo-actions">
					{#each evidenceLimitationMemo.recoveryActions as action}
						<li>
							<button
								type="button"
								class="research-card__memo-action-button"
								onclick={() => runMemoRecoveryAction(action)}
								disabled={!canRunMemoRecoveryAction(action)}
								aria-busy={memoRecoveryPendingKey === memoRecoveryActionKey(action)}
								aria-label={action.label}
								title={action.label}
							>
								{memoRecoveryPendingKey === memoRecoveryActionKey(action)
									? $t('deepResearch.memo.actionPending')
									: action.label}
							</button>
							<p>{action.description}</p>
						</li>
					{/each}
				</ul>
				{#if memoRecoveryError}
					<p class="research-card__error" role="alert">{memoRecoveryError}</p>
				{/if}
			</div>
		</section>
	{/if}

	{#if visibleTimelineSteps.length > 0}
		<section class="research-card__timeline" aria-labelledby={`${job.id}-timeline-heading`}>
			<div class="research-card__section-header">
				<h3 id={`${job.id}-timeline-heading`}>{$t('deepResearch.timelineHeading')}</h3>
				<button
					type="button"
					class="research-card__timeline-toggle"
					aria-expanded={effectiveTimelineOpen}
					aria-controls={`${job.id}-timeline-list`}
					onclick={toggleTimeline}
				>
					{effectiveTimelineOpen ? $t('deepResearch.timeline.hide') : $t('deepResearch.timeline.show')}
				</button>
			</div>

			{#if effectiveTimelineOpen}
				<ol id={`${job.id}-timeline-list`} class="research-card__timeline-list">
					{#each visibleTimelineSteps as step (step.id)}
						<li class={`research-card__timeline-item research-card__timeline-item--${step.status}`}>
							<div class="research-card__timeline-marker" aria-hidden="true"></div>
							<div class="research-card__timeline-body">
								{#if showTimelineStepLabel(job)}
									<p class="research-card__timeline-summary">{$t(timelineStepLabelKey(job, step))}</p>
								{/if}
								{#each step.events ?? [] as event (event.id)}
									<div class="research-card__timeline-event">
										<p>{timelineEventSummary(event)}</p>
										{#if event.showSourceCounts}
											<div class="research-card__source-counts" aria-label={$t('deepResearch.sourceCountsLabel')}>
												{#each sourceCountLabels(event.sourceCounts) as label}
													<span>{label}</span>
												{/each}
											</div>
										{/if}
										{#if event.assumptions.length > 0}
											<div class="research-card__timeline-notes">
												<strong>{$t('deepResearch.timeline.assumptions')}</strong>
												<ul>
													{#each event.assumptions as assumption}
														<li>{assumption}</li>
													{/each}
												</ul>
											</div>
										{/if}
										{#if event.warnings.length > 0}
											<div class="research-card__timeline-notes research-card__timeline-notes--warning">
												<strong>{$t('deepResearch.timeline.warnings')}</strong>
												<ul>
													{#each event.warnings as warning}
														<li>{warning}</li>
													{/each}
												</ul>
											</div>
										{/if}
									</div>
								{/each}
							</div>
						</li>
					{/each}
				</ol>
			{/if}
		</section>
	{/if}

	{#if advanceError}
		<p class="research-card__error" role="alert">{advanceError}</p>
	{/if}

	{#if canAdvanceResearch}
		<div class="research-card__actions">
			<button
				type="button"
				class="research-card__action"
				onclick={advanceResearch}
				disabled={!onAdvanceResearch || advancePending}
				aria-label={$t('deepResearch.advanceWorkflowLabel')}
				title={$t('deepResearch.advanceWorkflowHelp')}
			>
				{advancePending
					? $t('deepResearch.advancingWorkflow')
					: $t('deepResearch.advanceWorkflowLabel')}
			</button>
		</div>
	{/if}

	{#if canCancel || canApprovePlan}
		<div class="research-card__actions">
			{#if canApprovePlan}
				<button
					type="button"
					class="research-card__action research-card__action--primary"
					onclick={approvePlan}
					disabled={!onApprove || planApprovalPending || planEditPending}
					aria-label={$t('deepResearch.approvePlanLabel')}
					title={$t('deepResearch.approvePlanLabel')}
				>
					{$t('deepResearch.approvePlanLabel')}
				</button>
				<button
					type="button"
					class="research-card__action"
					onclick={editPlan}
					disabled={!onEdit || planApprovalPending || planEditPending}
					aria-label={$t('deepResearch.editPlanLabel')}
					title={$t('deepResearch.editPlanLabel')}
				>
					{$t('deepResearch.editPlanLabel')}
				</button>
			{/if}
			{#if canCancel}
				<button
					type="button"
					class="research-card__action research-card__cancel"
					onclick={cancelJob}
					disabled={!onCancel || planApprovalPending || planEditPending}
					aria-label={$t('deepResearch.cancelLabel')}
					title={$t('deepResearch.cancelLabel')}
				>
					{$t('common.cancel')}
				</button>
			{/if}
		</div>
	{/if}

	{#if reportDocument}
		<div class="research-card__actions">
			<button
				type="button"
				class="research-card__action research-card__action--primary"
				onclick={openReport}
				disabled={!onOpenReport}
				aria-label={$t(openReportLabelKey)}
				title={$t(openReportLabelKey)}
			>
				{$t(openReportLabelKey)}
			</button>
			<button
				type="button"
				class="research-card__action"
				onclick={discussResearchArtifact}
				disabled={!onDiscussReport}
				aria-label={$t('deepResearch.discussReportLabel')}
				title={$t('deepResearch.discussReportLabel')}
			>
				{$t('deepResearch.discussReportLabel')}
			</button>
			<button
				type="button"
				class="research-card__action"
				onclick={() => researchFurther()}
				disabled={!onResearchFurther}
				aria-label={$t('deepResearch.researchFurtherLabel')}
				title={$t('deepResearch.researchFurtherLabel')}
			>
				{$t('deepResearch.researchFurtherLabel')}
			</button>
		</div>
	{/if}
</article>

<style>
	.research-card {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border-subtle));
		border-radius: 8px;
		background: var(--surface-elevated);
		padding: var(--space-lg);
		box-shadow: none;
	}

	.research-card__header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-md);
	}

	.research-card__header-actions {
		display: inline-flex;
		flex: 0 0 auto;
		align-items: center;
		gap: var(--space-xs);
	}

	.research-card__title-group {
		min-width: 0;
	}

	.research-card__eyebrow {
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0;
		text-transform: uppercase;
		color: var(--text-muted);
	}

	.research-card__title {
		margin: 0.2rem 0 0;
		overflow-wrap: anywhere;
		font-size: 1rem;
		font-weight: 600;
		line-height: 1.35;
		color: var(--text-primary);
	}

	.research-card__depth {
		flex: 0 0 auto;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border-subtle));
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page));
		padding: 0.22rem 0.55rem;
		font-size: 0.78rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.research-card__progress-button {
		display: inline-flex;
		align-items: center;
		gap: 0.42rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.18rem 0.5rem 0.18rem 0.28rem;
		font: inherit;
		font-size: 0.76rem;
		font-weight: 600;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out);
	}

	.research-card__progress-button:hover,
	.research-card__progress-button:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page));
		color: var(--text-primary);
	}

	.research-card__progress-ring {
		width: 1.05rem;
		height: 1.05rem;
		border-radius: 999px;
		background:
			radial-gradient(circle at center, var(--surface-page) 48%, transparent 50%),
			conic-gradient(var(--accent) 18%, color-mix(in srgb, var(--accent) 18%, var(--border-subtle)) 0);
	}

	.research-card__progress-ring--early {
		background:
			radial-gradient(circle at center, var(--surface-page) 48%, transparent 50%),
			conic-gradient(var(--accent) 34%, color-mix(in srgb, var(--accent) 18%, var(--border-subtle)) 0);
	}

	.research-card__progress-ring--middle {
		background:
			radial-gradient(circle at center, var(--surface-page) 48%, transparent 50%),
			conic-gradient(var(--accent) 56%, color-mix(in srgb, var(--accent) 18%, var(--border-subtle)) 0);
	}

	.research-card__progress-ring--late {
		background:
			radial-gradient(circle at center, var(--surface-page) 48%, transparent 50%),
			conic-gradient(var(--accent) 78%, color-mix(in srgb, var(--accent) 18%, var(--border-subtle)) 0);
	}

	.research-card__progress-ring--done {
		background:
			radial-gradient(circle at center, var(--surface-page) 48%, transparent 50%),
			conic-gradient(#22c55e 100%, color-mix(in srgb, #22c55e 18%, var(--border-subtle)) 0);
	}

	.research-card__progress-stage {
		white-space: nowrap;
	}

	.research-card__progress-popover {
		display: flex;
		flex-direction: column;
		gap: var(--space-xs);
		border: 1px solid color-mix(in srgb, var(--accent) 26%, var(--border-subtle));
		border-radius: 8px;
		background: var(--surface-page);
		padding: var(--space-sm);
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--text-secondary);
		animation: research-top-fade 140ms var(--ease-out);
	}

	.research-card__progress-popover-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-sm);
		color: var(--text-primary);
	}

	.research-card__progress-close {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.45rem;
		height: 1.45rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: transparent;
		color: var(--text-muted);
		cursor: pointer;
	}

	.research-card__progress-current,
	.research-card__progress-empty {
		margin: 0;
	}

	.research-card__progress-popover ul {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		margin: 0;
		padding-left: 1rem;
	}

	.research-card__meta {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-xs);
		font-size: 0.84rem;
		color: var(--text-secondary);
	}

	.research-card__status {
		display: inline-flex;
		align-items: center;
		gap: 0.36rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.research-card__status-dot {
		width: 0.55rem;
		height: 0.55rem;
		border-radius: 999px;
		background: var(--text-muted);
	}

	.research-card__status--working .research-card__status-dot,
	.research-card__status--awaiting_plan .research-card__status-dot,
	.research-card__status--needs_attention .research-card__status-dot {
		background: #f97316;
		animation: research-pulse 1.4s ease-in-out infinite;
	}

	.research-card__status--completed .research-card__status-dot {
		background: #22c55e;
	}

	.research-card__status--insufficient_evidence .research-card__status-dot {
		background: #eab308;
	}

	.research-card__status--cancelled .research-card__status-dot {
		background: var(--text-muted);
	}

	.research-card__status--failed .research-card__status-dot {
		background: var(--danger);
	}

	.research-card__cost {
		border-left: 1px solid var(--border-subtle);
		padding-left: var(--space-xs);
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.research-card__actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		justify-content: flex-end;
	}

	.research-card__plan {
		display: flex;
		flex-direction: column;
		gap: var(--space-md);
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-md);
	}

	.research-card__planning {
		display: grid;
		grid-template-columns: 1.25rem minmax(0, 1fr);
		gap: var(--space-sm);
		align-items: start;
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-md);
		color: var(--text-secondary);
	}

	.research-card__planning strong {
		display: block;
		font-size: 0.9rem;
		color: var(--text-primary);
	}

	.research-card__planning p {
		margin: 0.2rem 0 0;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.research-card__planning-spinner {
		margin-top: 0.1rem;
		width: 1rem;
		height: 1rem;
		border: 2px solid color-mix(in srgb, var(--accent) 24%, transparent);
		border-top-color: var(--accent);
		border-radius: 999px;
		animation: research-spin 0.9s linear infinite;
	}

	.research-card__notice {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		border: 1px solid color-mix(in srgb, var(--accent) 24%, var(--border-subtle));
		border-radius: 8px;
		background: color-mix(in srgb, var(--accent) 7%, var(--surface-page));
		padding: var(--space-sm);
		color: var(--text-secondary);
	}

	.research-card__notice--attention {
		border-color: color-mix(in srgb, #f97316 36%, var(--border-subtle));
		background: color-mix(in srgb, #f97316 8%, var(--surface-page));
	}

	.research-card__notice--limited {
		border-color: color-mix(in srgb, #22c55e 28%, var(--border-subtle));
		background: color-mix(in srgb, #22c55e 7%, var(--surface-page));
	}

	.research-card__notice h3,
	.research-card__notice strong {
		margin: 0;
		font-size: 0.9rem;
		color: var(--text-primary);
	}

	.research-card__notice p {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-muted);
	}

	.research-card__sources,
	.research-card__memo,
	.research-card__timeline {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		border-top: 1px solid var(--border-subtle);
		padding-top: var(--space-md);
	}

	.research-card__timeline-list {
		display: flex;
		flex-direction: column;
		margin: 0;
		padding: 0;
		list-style: none;
		--research-timeline-marker-center: 0.61rem;
	}

	.research-card__timeline-toggle {
		border: 1px solid color-mix(in srgb, var(--accent) 32%, var(--border-subtle));
		border-radius: 999px;
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-page));
		color: var(--text-primary);
		font-size: 0.78rem;
		font-weight: 700;
		padding: 0.3rem 0.65rem;
		cursor: pointer;
	}

	.research-card__timeline-toggle:hover,
	.research-card__timeline-toggle:focus-visible {
		border-color: color-mix(in srgb, var(--accent) 48%, var(--border-subtle));
		background: color-mix(in srgb, var(--accent) 14%, var(--surface-page));
	}

	.research-card__timeline-item {
		position: relative;
		display: grid;
		grid-template-columns: 0.7rem minmax(0, 1fr);
		gap: 0.7rem;
		padding: 0 0 var(--space-sm);
	}

	.research-card__timeline-item::before {
		content: "";
		position: absolute;
		top: 0;
		bottom: 0;
		left: 0.28rem;
		width: 1px;
		background: var(--border-subtle);
	}

	.research-card__timeline-item:first-child::before {
		top: var(--research-timeline-marker-center);
	}

	.research-card__timeline-item--completed::before {
		background: color-mix(in srgb, var(--accent) 45%, var(--border-subtle));
	}

	.research-card__timeline-item:last-child::before {
		bottom: calc(100% - var(--research-timeline-marker-center));
	}

	.research-card__timeline-item:only-child::before {
		display: none;
	}

	.research-card__timeline-marker {
		position: relative;
		z-index: 1;
		margin-top: 0.32rem;
		width: 0.58rem;
		height: 0.58rem;
		border: 1px solid var(--border-subtle);
		border-radius: 999px;
		background: var(--surface-page);
	}

	.research-card__timeline-item--completed .research-card__timeline-marker {
		border-color: #22c55e;
		background: #22c55e;
	}

	.research-card__timeline-item--active .research-card__timeline-marker {
		border-color: #f97316;
		background: #f97316;
		animation: research-pulse 1.4s ease-in-out infinite;
	}

	.research-card__timeline-body {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
	}

	.research-card__timeline-summary {
		margin: 0;
		font-size: 0.83rem;
		font-weight: 500;
		line-height: 1.35;
		color: var(--text-primary);
	}

	.research-card__timeline-item--pending .research-card__timeline-summary {
		color: var(--text-muted);
	}

	.research-card__timeline-event {
		border-radius: 7px;
		background: var(--surface-page);
		padding: var(--space-sm);
	}

	.research-card__timeline-event p {
		margin: 0 0 0.35rem;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.research-card__memo-group {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		font-size: 0.8rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.research-card__memo-group strong {
		font-size: 0.78rem;
		color: var(--text-primary);
	}

	.research-card__memo-group p {
		margin: 0;
	}

	.research-card__memo-group ul {
		display: flex;
		flex-direction: column;
		gap: 0.32rem;
		margin: 0;
		padding-left: 1rem;
	}

	.research-card__memo-actions {
		padding-left: 0 !important;
		list-style: none;
	}

	.research-card__memo-actions li {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.35rem;
		border-radius: 7px;
		background: var(--surface-page);
		padding: 0.45rem 0.55rem;
	}

	.research-card__memo-action-button {
		border: 1px solid var(--border-strong);
		border-radius: 6px;
		background: var(--surface-card);
		padding: 0.34rem 0.52rem;
		text-align: left;
		font-weight: 600;
		color: var(--text-primary);
		cursor: pointer;
	}

	.research-card__memo-action-button:hover:not(:disabled) {
		border-color: var(--accent);
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 8%, var(--surface-card));
	}

	.research-card__memo-action-button:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	.research-card__source-counts {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3rem;
		font-size: 0.74rem;
		color: var(--text-secondary);
	}

	.research-card__source-counts span {
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.16rem 0.42rem;
	}

	.research-card__reviewed-sources {
		font-size: 0.78rem;
		line-height: 1.4;
		color: var(--text-secondary);
	}

	.research-card__reviewed-sources strong {
		display: block;
		margin-bottom: 0.3rem;
		color: var(--text-primary);
	}

	.research-card__reviewed-sources ul {
		display: flex;
		flex-direction: column;
		gap: 0.35rem;
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.research-card__reviewed-sources li {
		display: grid;
		grid-template-columns: 1rem minmax(0, 1fr) auto;
		gap: 0.15rem 0.45rem;
		border-radius: 7px;
		background: var(--surface-page);
		padding: 0.45rem 0.55rem;
	}

	.research-card__source-favicon {
		width: 1rem;
		height: 1rem;
		align-self: center;
		justify-self: center;
		border-radius: 4px;
		overflow: hidden;
		background: var(--surface-page);
	}

	.research-card__source-favicon img,
	.research-card__source-favicon-fallback {
		display: block;
		width: 1rem;
		height: 1rem;
	}

	.research-card__source-favicon-fallback {
		border: 1px solid var(--border-subtle);
		border-radius: 4px;
		background:
			linear-gradient(135deg, transparent 45%, var(--text-muted) 47%, var(--text-muted) 53%, transparent 55%),
			var(--surface-page);
	}

	.research-card__reviewed-sources a {
		overflow-wrap: anywhere;
		font-weight: 600;
		color: var(--text-primary);
		text-decoration: none;
	}

	.research-card__reviewed-sources a:hover {
		text-decoration: underline;
	}

	.research-card__reviewed-sources span {
		border-radius: 999px;
		background: var(--surface-page);
		padding: 0.08rem 0.36rem;
		font-size: 0.7rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.research-card__reviewed-sources p {
		grid-column: 2 / -1;
		margin: 0;
		color: var(--text-secondary);
	}

	.research-card__timeline-notes {
		font-size: 0.76rem;
		line-height: 1.4;
		color: var(--text-secondary);
	}

	.research-card__timeline-notes strong {
		display: block;
		margin-bottom: 0.18rem;
		color: var(--text-primary);
	}

	.research-card__timeline-notes ul {
		margin: 0;
		padding-left: 1rem;
	}

	.research-card__timeline-notes--warning {
		color: var(--text-secondary);
	}

	.research-card__section-header {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-sm);
	}

	.research-card__section-header h3 {
		margin: 0;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.research-card__section-header span {
		font-size: 0.75rem;
		font-weight: 500;
		color: var(--text-muted);
	}

	.research-card__effort {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-sm);
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.research-card__effort span {
		border-radius: 7px;
		background: var(--surface-page);
		padding: 0.3rem 0.5rem;
	}

	.research-card__effort strong {
		margin-right: 0.3rem;
		color: var(--text-primary);
	}

	.research-card__context,
	.research-card__intent {
		margin: 0;
		font-size: 0.82rem;
		line-height: 1.45;
		color: var(--text-secondary);
	}

	.research-card__context strong,
	.research-card__intent strong {
		color: var(--text-primary);
	}

	.research-card__plan-text {
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--surface-page);
		padding: var(--space-md);
		overflow-wrap: anywhere;
		font-size: 0.82rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.research-card__plan-goal,
	.research-card__plan-section {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}

	.research-card__plan-goal + .research-card__plan-section,
	.research-card__plan-section + .research-card__plan-section {
		margin-top: var(--space-sm);
	}

	.research-card__plan-goal strong,
	.research-card__plan-section strong {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.research-card__plan-goal p {
		margin: 0;
	}

	.research-card__plan-section ul {
		display: flex;
		flex-direction: column;
		gap: 0.22rem;
		margin: 0;
		padding-left: 1rem;
	}

	.research-card__edit-form {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.research-card__edit-label {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-primary);
	}

	.research-card__edit-textarea,
	.research-card__edit-select {
		min-height: 5rem;
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--surface-page);
		padding: var(--space-sm);
		font: inherit;
		font-size: 0.84rem;
		line-height: 1.45;
		color: var(--text-primary);
	}

	.research-card__edit-textarea {
		resize: vertical;
	}

	.research-card__edit-select {
		min-height: 2.4rem;
	}

	.research-card__edit-textarea:focus,
	.research-card__edit-select:focus {
		outline: 2px solid color-mix(in srgb, var(--accent) 58%, transparent);
		outline-offset: 2px;
	}

	.research-card__edit-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		justify-content: flex-end;
		margin-top: var(--space-xs);
	}

	.research-card__error {
		margin: 0;
		font-size: 0.8rem;
		color: var(--danger);
	}

	.research-card__action {
		border: 1px solid var(--border-subtle);
		border-radius: 7px;
		background: var(--surface-page);
		padding: 0.38rem 0.7rem;
		font-size: 0.82rem;
		font-weight: 600;
		color: var(--text-secondary);
		cursor: pointer;
		transition:
			background-color var(--duration-standard) var(--ease-out),
			border-color var(--duration-standard) var(--ease-out),
			color var(--duration-standard) var(--ease-out),
			transform var(--duration-standard) var(--ease-out);
	}

	.research-card__action--primary {
		border-color: color-mix(in srgb, var(--accent) 48%, var(--border-subtle));
		background: var(--accent);
		color: var(--text-on-accent);
	}

	@keyframes research-pulse {
		0%, 100% {
			opacity: 1;
		}
		50% {
			opacity: 0.72;
		}
	}

	@keyframes research-spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes research-top-fade {
		from {
			opacity: 0;
			transform: translateY(-0.35rem);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.research-card__status-dot,
		.research-card__timeline-marker,
		.research-card__planning-spinner,
		.research-card__progress-popover {
			animation: none !important;
		}

		.research-card__action {
			transition: none;
		}

		.research-card__action:hover:not(:disabled),
		.research-card__action:focus-visible:not(:disabled) {
			transform: none;
		}
	}

	.research-card__action:hover:not(:disabled),
	.research-card__action:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--accent) 55%, var(--border-subtle));
		background: color-mix(in srgb, var(--accent) 10%, var(--surface-page));
		color: var(--text-primary);
		transform: translateY(-1px);
	}

	.research-card__action--primary:hover:not(:disabled),
	.research-card__action--primary:focus-visible:not(:disabled) {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 88%, black);
		color: var(--text-on-accent);
	}

	.research-card__cancel:hover:not(:disabled),
	.research-card__cancel:focus-visible:not(:disabled) {
		border-color: color-mix(in srgb, var(--danger) 38%, var(--border-subtle));
		color: var(--danger);
	}

	.research-card__action:disabled {
		cursor: not-allowed;
		opacity: 0.55;
	}

	@media (max-width: 640px) {
		.research-card__header {
			flex-direction: column;
			align-items: stretch;
		}

		.research-card__depth {
			align-self: flex-start;
		}
	}
</style>
