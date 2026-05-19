import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import {
	artifactLinks,
	artifacts,
	conversations,
	deepResearchJobs,
	deepResearchPlanVersions,
	messages,
} from "$lib/server/db/schema";
import {
	createConversation,
	updateConversationTitle,
} from "$lib/server/services/conversations";
import {
	createArtifact,
	createArtifactLink,
} from "$lib/server/services/knowledge/store";
import { createMessage } from "$lib/server/services/messages";
import { messageTimestampOrderAsc } from "$lib/server/services/message-ordering";
import { generateTitle } from "$lib/server/services/title-generator";
import type {
	Conversation,
	DeepResearchCoverageGap,
	DeepResearchDepth,
	DeepResearchEffortEstimate,
	DeepResearchEvidenceLimitationMemo,
	DeepResearchEvidenceNote,
	DeepResearchJob,
	DeepResearchPassCheckpoint,
	DeepResearchPlanRaw,
	DeepResearchPlanSummary,
	DeepResearchResumePoint,
	DeepResearchRuntimeEstimate,
	DeepResearchSource,
	DeepResearchSourceCounts,
	DeepResearchSynthesisClaim,
	DeepResearchTimelineEvent,
	DeepResearchUsageSummary,
} from "$lib/types";
import {
	auditAndPersistDeepResearchClaimGraph,
	auditDeepResearchReportCitations,
	type DeepResearchReportDraft,
} from "./citation-audit";
import { listDeepResearchEvidenceNotes } from "./evidence-notes";
import { resolveResearchLanguage } from "./language";
import {
	buildCitationClaimReviewerWithLlm,
	buildClaimGraphCitationReviewerWithLlm,
	draftResearchPlanWithLlm,
	writeResearchReportWithLlm,
} from "./llm-steps";
import {
	listResearchCoverageGaps,
	listResearchPassCheckpoints,
	upsertResearchPassCheckpoint,
} from "./pass-state";
import {
	createFirstResearchPlanDraft,
	createRevisedResearchPlanDraft,
	type PlanningContextItem,
	type ReportIntent,
	type ResearchLanguage,
	type ResearchPlanDraftRecord,
	type ResearchPlanIncludedSource,
} from "./planning";
import {
	type ResearchReportDraft,
	renderAuditedResearchReportMarkdown,
	selectResearchReportFindings,
	writeEvidenceLimitationMemo,
} from "./report-writer";
import {
	completeResearchResumePoint,
	getResearchResumePoint,
	listResearchResumePoints,
	upsertResearchResumePoint,
} from "./resume-points";
import { isSourceTopicRelevantToPlan } from "./source-review";
import {
	getResearchSourceFaviconUrl,
	listResearchSources,
	markResearchSourceCited,
	saveDiscoveredResearchSource,
} from "./sources";
import type { SynthesisNotes } from "./synthesis";
import { listDeepResearchSynthesisClaims } from "./synthesis-claims";
import { createResearchTasksFromCoverageGaps } from "./tasks";
import {
	createPlanGenerationTimelineEvent,
	listResearchTimelineEventsForJobs,
	type PersistedResearchTimelineEvent,
	saveResearchTimelineEvent,
} from "./timeline";
import {
	buildPlanGenerationResearchUsageRecord,
	getResearchUsageCostSummary,
	type ResearchProviderUsageSnapshot,
	saveResearchUsageRecord,
} from "./usage";

export type PlanGenerationUsageInput = {
	modelId: string;
	modelDisplayName?: string | null;
	providerId?: string | null;
	providerDisplayName?: string | null;
	runtimeMs?: number | null;
	providerUsage?: ResearchProviderUsageSnapshot | null;
	costUsdMicros?: number | null;
};

export type StartDeepResearchJobShellInput = {
	userId: string;
	conversationId: string;
	triggerMessageId: string;
	userRequest: string;
	depth: DeepResearchDepth;
	researchLanguage?: ResearchLanguage;
	planningContext?: PlanningContextItem[];
	planGenerationUsage?: PlanGenerationUsageInput | null;
	now?: Date;
};

export type AssertCanStartDeepResearchJobInput = {
	userId: string;
	conversationId: string;
};

export type CancelPrePlanDeepResearchJobInput = {
	userId: string;
	jobId: string;
	now?: Date;
};

export type EditDeepResearchPlanInput = {
	userId: string;
	jobId: string;
	editInstruction: string;
	reportIntent?: ReportIntent;
	researchLanguage?: ResearchLanguage;
	now?: Date;
};

export type ApproveDeepResearchPlanInput = {
	userId: string;
	jobId: string;
	now?: Date;
};

export type CompleteDeepResearchJobWithAuditedReportInput = {
	userId: string;
	jobId: string;
	synthesisNotes: SynthesisNotes;
	limitations?: string[];
	now?: Date;
};

export type CompleteDeepResearchJobWithEvidenceLimitationMemoInput = {
	userId: string;
	jobId: string;
	limitations: string[];
	now?: Date;
};

export type DiscussDeepResearchReportInput = {
	userId: string;
	jobId: string;
	persistSeedMessage?: boolean;
	now?: Date;
};

export type ResearchFurtherFromDeepResearchReportInput = {
	userId: string;
	jobId: string;
	depth?: DeepResearchDepth;
	researchLanguage?: ResearchLanguage;
	now?: Date;
};

export type DeepResearchReportActionResult = {
	sourceJobId: string;
	reportArtifactId: string;
	conversation: Conversation;
	messageId?: string;
	seedMessage: string;
	researchLanguage: ResearchLanguage;
};

export type ResearchFurtherReportActionResult =
	DeepResearchReportActionResult & {
		job: DeepResearchJob;
	};

type DeepResearchJobRow = typeof deepResearchJobs.$inferSelect;
type DeepResearchPlanVersionRow = typeof deepResearchPlanVersions.$inferSelect;
type ResearchReportContext = {
	job: DeepResearchJobRow;
	report: typeof artifacts.$inferSelect;
	artifactKind: "report" | "memo";
	sourceProjectId: string | null;
};
type ExistingReportActionMessage = {
	message: typeof messages.$inferSelect;
	conversation: typeof conversations.$inferSelect;
	job: DeepResearchJobRow | null;
};
type DeepResearchReportContextMetadata = {
	action: string;
	sourceJobId: string;
	reportArtifactId: string;
	requestedDepth?: DeepResearchDepth;
};

const OPEN_JOB_STATUS_FILTER = sql`${deepResearchJobs.status} NOT IN ('completed', 'failed', 'cancelled')`;
const FINALIZABLE_JOB_STATUS_FILTER = sql`${deepResearchJobs.status} IN ('approved', 'running')`;
const inFlightReportActions = new Map<string, Promise<unknown>>();

export class DeepResearchJobStartError extends Error {
	constructor(
		public readonly code:
			| "conversation_not_found"
			| "conversation_sealed"
			| "active_job_exists"
			| "active_user_limit_exceeded"
			| "active_global_limit_exceeded",
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "DeepResearchJobStartError";
	}
}

export class DeepResearchPlanActionError extends Error {
	constructor(
		public readonly code:
			| "plan_already_approved"
			| "plan_not_editable"
			| "plan_not_approvable",
		message: string,
		public readonly status: number,
	) {
		super(message);
		this.name = "DeepResearchPlanActionError";
	}
}

export function isDeepResearchJobStartError(
	error: unknown,
): error is DeepResearchJobStartError {
	return error instanceof DeepResearchJobStartError;
}

export function isDeepResearchPlanActionError(
	error: unknown,
): error is DeepResearchPlanActionError {
	return error instanceof DeepResearchPlanActionError;
}

export async function startDeepResearchJobShell(
	input: StartDeepResearchJobShellInput,
): Promise<DeepResearchJob> {
	await assertCanStartDeepResearchJob(input);

	const now = input.now ?? new Date();
	const researchLanguage = resolveResearchLanguage({
		userRequest: input.userRequest,
		explicitOutputLanguage: input.researchLanguage,
	});
	const triggerMessageId = await resolveDeepResearchTriggerMessageId({
		conversationId: input.conversationId,
		triggerMessageId: input.triggerMessageId,
	});
	const [job] = await db
		.insert(deepResearchJobs)
		.values({
			id: randomUUID(),
			userId: input.userId,
			conversationId: input.conversationId,
			triggerMessageId,
			depth: input.depth,
			status: "awaiting_plan",
			stage: "job_shell_created",
			title: buildJobTitle(input.userRequest),
			userRequest: input.userRequest,
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	const draft = await createFirstResearchPlanDraft(
		{
			jobId: job.id,
			userRequest: input.userRequest,
			selectedDepth: input.depth,
			researchLanguage,
			planningContext: input.planningContext,
		},
		{
			structuredPlanner: {
				draftPlan: (plannerInput, context) =>
					draftResearchPlanWithLlm({
						context: {
							jobId: job.id,
							conversationId: input.conversationId,
							userId: input.userId,
							now,
						},
						role: "plan_generation",
						userRequest: plannerInput.userRequest,
						selectedDepth: plannerInput.selectedDepth,
						researchLanguage: plannerInput.researchLanguage,
						selectedBudget: context.selectedBudget,
						contextDisclosure: context.contextDisclosure,
					}),
			},
			repository: {
				saveResearchPlanDraft: (draftRecord) =>
					saveResearchPlanDraft(draftRecord, now),
			},
		},
	);

	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: draft.status,
			stage: "plan_drafted",
			updatedAt: now,
		})
		.where(eq(deepResearchJobs.id, job.id))
		.returning();

	const titledJob = await applyGeneratedResearchTitle({
		userId: input.userId,
		conversationId: input.conversationId,
		job: updatedJob,
		userRequest: input.userRequest,
		assistantContext: draft.renderedPlan,
		now,
	});

	const timelineEvent = await saveResearchTimelineEvent(
		createPlanGenerationTimelineEvent({
			jobId: job.id,
			conversationId: input.conversationId,
			userId: input.userId,
			stage: "plan_generation",
			researchLanguage,
			occurredAt: now,
			assumptions: [],
		}),
	);

	if (input.planGenerationUsage) {
		await saveResearchUsageRecord(
			buildPlanGenerationResearchUsageRecord({
				jobId: job.id,
				conversationId: input.conversationId,
				userId: input.userId,
				modelId: input.planGenerationUsage.modelId,
				modelDisplayName: input.planGenerationUsage.modelDisplayName,
				providerId: input.planGenerationUsage.providerId,
				providerDisplayName: input.planGenerationUsage.providerDisplayName,
				occurredAt: now,
				runtimeMs: input.planGenerationUsage.runtimeMs,
				providerUsage: input.planGenerationUsage.providerUsage,
				costUsdMicros: input.planGenerationUsage.costUsdMicros,
			}),
		);
	}

	return mapDeepResearchJob(titledJob, mapResearchPlanVersionRow(draft), [
		mapTimelineEvent(timelineEvent),
	]);
}

async function resolveDeepResearchTriggerMessageId(input: {
	conversationId: string;
	triggerMessageId: string | null | undefined;
}): Promise<string | null> {
	if (!input.triggerMessageId) return null;
	const [message] = await db
		.select({ id: messages.id })
		.from(messages)
		.where(
			and(
				eq(messages.id, input.triggerMessageId),
				eq(messages.conversationId, input.conversationId),
			),
		)
		.limit(1);
	return message?.id ?? null;
}

export async function assertCanStartDeepResearchJob(
	input: AssertCanStartDeepResearchJobInput,
): Promise<void> {
	const [conversation] = await db
		.select({
			id: conversations.id,
			status: conversations.status,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.id, input.conversationId),
				eq(conversations.userId, input.userId),
			),
		)
		.limit(1);

	if (!conversation) {
		throw new DeepResearchJobStartError(
			"conversation_not_found",
			"Conversation not found",
			404,
		);
	}
	if (conversation.status === "sealed") {
		throw new DeepResearchJobStartError(
			"conversation_sealed",
			"Deep Research cannot be started in a sealed conversation",
			409,
		);
	}

	const runtimePolicy = getConfig();
	const activeConversationLimit = Math.max(
		1,
		runtimePolicy.deepResearchActiveConversationLimit,
	);
	const activeConversationCount = await countActiveDeepResearchJobs({
		userId: input.userId,
		conversationId: input.conversationId,
	});
	if (activeConversationCount >= activeConversationLimit) {
		throw new DeepResearchJobStartError(
			"active_job_exists",
			"This conversation already has an active Deep Research job",
			409,
		);
	}

	const activeUserLimit = Math.max(
		0,
		runtimePolicy.deepResearchActiveUserLimit,
	);
	const activeGlobalLimit = Math.max(
		0,
		runtimePolicy.deepResearchActiveGlobalLimit,
	);
	const activeUserCount = await countActiveDeepResearchJobs({
		userId: input.userId,
	});
	if (activeUserCount >= activeUserLimit) {
		throw new DeepResearchJobStartError(
			"active_user_limit_exceeded",
			"This user already has the maximum number of active Deep Research jobs",
			429,
		);
	}

	const activeGlobalCount = await countActiveDeepResearchJobs();
	if (activeGlobalCount >= activeGlobalLimit) {
		throw new DeepResearchJobStartError(
			"active_global_limit_exceeded",
			"The Deep Research runtime is at its global active-job limit",
			429,
		);
	}
}

async function countActiveDeepResearchJobs(
	input: { userId?: string; conversationId?: string } = {},
): Promise<number> {
	const filters = [OPEN_JOB_STATUS_FILTER];
	if (input.userId) {
		filters.push(eq(deepResearchJobs.userId, input.userId));
	}
	if (input.conversationId) {
		filters.push(eq(deepResearchJobs.conversationId, input.conversationId));
	}
	const [result] = await db
		.select({ count: sql<number>`count(*)` })
		.from(deepResearchJobs)
		.where(and(...filters));
	return Number(result?.count ?? 0);
}

export async function listConversationDeepResearchJobs(
	userId: string,
	conversationId: string,
): Promise<DeepResearchJob[]> {
	const rows = await db
		.select()
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				eq(deepResearchJobs.conversationId, conversationId),
			),
		)
		.orderBy(asc(deepResearchJobs.createdAt));
	const currentPlans = await loadCurrentPlansByJobId(rows.map((row) => row.id));
	const timelineEvents = await loadTimelineEventsByJobId(
		userId,
		rows.map((row) => row.id),
	);
	const sourceLedgers = await loadSourceLedgersByJobId(
		userId,
		conversationId,
		rows.map((row) => row.id),
	);
	const usageSummaries = await loadUsageSummariesByJobId(
		userId,
		rows.map((row) => row.id),
	);
	const runtimeEstimates = await loadRuntimeEstimatesByJobId(rows);
	const evidenceLimitationMemos = await loadEvidenceLimitationMemosByJobId(
		userId,
		rows,
	);
	const passStates = await loadPassStatesByJobId(
		userId,
		rows.map((row) => row.id),
	);
	return rows.map((row) =>
		mapDeepResearchJob(
			row,
			currentPlans.get(row.id) ?? null,
			timelineEvents.get(row.id) ?? [],
			sourceLedgers.get(row.id),
			{
				usageSummary: usageSummaries.get(row.id),
				runtimeEstimate: runtimeEstimates.get(row.id),
				evidenceLimitationMemo: evidenceLimitationMemos.get(row.id) ?? null,
				passCheckpoints: passStates.get(row.id)?.passCheckpoints ?? [],
				coverageGaps: passStates.get(row.id)?.coverageGaps ?? [],
				evidenceNotes: passStates.get(row.id)?.evidenceNotes ?? [],
				synthesisClaims: passStates.get(row.id)?.synthesisClaims ?? [],
				resumePoints: passStates.get(row.id)?.resumePoints ?? [],
			},
		),
	);
}

export async function cancelPrePlanDeepResearchJob(
	input: CancelPrePlanDeepResearchJobInput,
): Promise<DeepResearchJob | null> {
	const now = input.now ?? new Date();
	const [job] = await db
		.update(deepResearchJobs)
		.set({
			status: "cancelled",
			stage: "cancelled_before_approval",
			cancelledAt: now,
			updatedAt: now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, input.jobId),
				eq(deepResearchJobs.userId, input.userId),
				sql`${deepResearchJobs.status} IN ('awaiting_plan', 'awaiting_approval')`,
			),
		)
		.returning();

	if (!job) return null;
	const currentPlans = await loadCurrentPlansByJobId([job.id]);
	const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
		job.id,
	]);
	return mapDeepResearchJob(
		job,
		currentPlans.get(job.id) ?? null,
		timelineEvents.get(job.id) ?? [],
	);
}

export async function editDeepResearchPlan(
	input: EditDeepResearchPlanInput,
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
	if (job.status === "approved") {
		throw new DeepResearchPlanActionError(
			"plan_already_approved",
			"Approved Research Plans cannot be edited",
			409,
		);
	}
	if (job.status !== "awaiting_approval") {
		throw new DeepResearchPlanActionError(
			"plan_not_editable",
			"This Deep Research Plan cannot be edited in its current state",
			409,
		);
	}

	const [currentPlanRow] = await db
		.select()
		.from(deepResearchPlanVersions)
		.where(eq(deepResearchPlanVersions.jobId, job.id))
		.orderBy(desc(deepResearchPlanVersions.version))
		.limit(1);

	if (!currentPlanRow) return null;

	const currentPlan = mapResearchPlanVersionRow(currentPlanRow);
	if (!currentPlan.rawPlan) return null;

	const draft = await createRevisedResearchPlanDraft(
		{
			jobId: job.id,
			previousPlan: currentPlan.rawPlan,
			previousVersion: currentPlan.version,
			editInstruction: input.editInstruction,
			reportIntent: input.reportIntent,
			selectedDepth: job.depth as DeepResearchDepth,
			researchLanguage:
				input.researchLanguage ?? currentPlan.rawPlan.researchLanguage ?? "en",
			contextDisclosure: currentPlan.contextDisclosure ?? null,
		},
		{
			structuredPlanner: {
				draftPlan: (plannerInput, context) =>
					draftResearchPlanWithLlm({
						context: {
							jobId: job.id,
							conversationId: job.conversationId,
							userId: input.userId,
							now,
						},
						role: "plan_revision",
						userRequest: input.editInstruction,
						selectedDepth: plannerInput.selectedDepth,
						researchLanguage: plannerInput.researchLanguage,
						selectedBudget: context.selectedBudget,
						contextDisclosure: context.contextDisclosure,
						previousPlan: currentPlan.rawPlan,
						editInstruction: input.editInstruction,
						reportIntent: input.reportIntent,
					}),
			},
			repository: {
				saveResearchPlanDraft: (draftRecord) =>
					saveResearchPlanDraft(draftRecord, now),
			},
		},
	);

	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "awaiting_approval",
			stage: "plan_revised",
			updatedAt: now,
		})
		.where(eq(deepResearchJobs.id, job.id))
		.returning();

	const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
		job.id,
	]);
	return mapDeepResearchJob(
		updatedJob,
		mapResearchPlanVersionRow(draft),
		timelineEvents.get(job.id) ?? [],
	);
}

export async function approveDeepResearchPlan(
	input: ApproveDeepResearchPlanInput,
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
	if (job.status === "approved") {
		const currentPlans = await loadCurrentPlansByJobId([job.id]);
		const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
			job.id,
		]);
		return mapDeepResearchJob(
			job,
			currentPlans.get(job.id) ?? null,
			timelineEvents.get(job.id) ?? [],
		);
	}
	if (job.status !== "awaiting_approval") {
		throw new DeepResearchPlanActionError(
			"plan_not_approvable",
			"This Deep Research Plan cannot be approved in its current state",
			409,
		);
	}

	const [currentPlanRow] = await db
		.select()
		.from(deepResearchPlanVersions)
		.where(eq(deepResearchPlanVersions.jobId, job.id))
		.orderBy(desc(deepResearchPlanVersions.version))
		.limit(1);

	if (!currentPlanRow) return null;

	const [approvedPlanRow] = await db
		.update(deepResearchPlanVersions)
		.set({
			status: "approved",
			updatedAt: now,
		})
		.where(eq(deepResearchPlanVersions.id, currentPlanRow.id))
		.returning();

	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "approved",
			stage: "plan_approved",
			updatedAt: now,
		})
		.where(eq(deepResearchJobs.id, job.id))
		.returning();

	await persistApprovedPlanSourceScope({
		userId: input.userId,
		conversationId: job.conversationId,
		jobId: job.id,
		includedSources:
			parseJson<DeepResearchPlanRaw>(approvedPlanRow.rawPlanJson).sourceScope
				.includedSources ?? [],
		discoveredAt: now,
	});

	const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
		job.id,
	]);
	return mapDeepResearchJob(
		updatedJob,
		mapResearchPlanVersionRow(approvedPlanRow),
		timelineEvents.get(job.id) ?? [],
	);
}

export async function completeDeepResearchJobWithAuditedReport(
	input: CompleteDeepResearchJobWithAuditedReportInput,
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
	if (job.status === "completed" && job.reportArtifactId) {
		const currentPlans = await loadCurrentPlansByJobId([job.id]);
		const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
			job.id,
		]);
		return mapDeepResearchJob(
			job,
			currentPlans.get(job.id) ?? null,
			timelineEvents.get(job.id) ?? [],
		);
	}
	if (job.status !== "approved" && job.status !== "running") {
		return null;
	}

	const currentPlans = await loadCurrentPlansByJobId([job.id]);
	const currentPlan = currentPlans.get(job.id);
	if (!currentPlan?.rawPlan) return null;
	if (
		(await countCompletedMeaningfulResearchPasses({
			userId: input.userId,
			jobId: job.id,
		})) < minimumMeaningfulPassExpectation(currentPlan.rawPlan)
	) {
		return null;
	}
	const reportAssemblyResumeKey = `report:${job.id}:audited`;
	const citationAuditResumeKey = `citation-audit:${job.id}:audited`;
	const existingReportAssembly = await getResearchResumePoint({
		userId: input.userId,
		jobId: job.id,
		resumeKey: reportAssemblyResumeKey,
	});
	const existingReportArtifactId =
		typeof existingReportAssembly?.result?.artifactId === "string"
			? existingReportAssembly.result.artifactId
			: null;
	if (existingReportArtifactId) {
		return finalizeAuditedReportJobFromArtifact({
			job,
			currentPlan,
			artifactId: existingReportArtifactId,
			now,
		});
	}

	await updateRunningDeepResearchStage({
		userId: job.userId,
		jobId: job.id,
		stage: "citation_audit",
		now,
	});
	await upsertResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		conversationId: job.conversationId,
		boundary: "citation_audit",
		resumeKey: citationAuditResumeKey,
		stage: "citation_audit",
		payload: {
			source: "claim_graph",
		},
		now,
	});
	const [claimGraphClaims, claimGraphEvidenceNotes] = await Promise.all([
		listDeepResearchSynthesisClaims({
			userId: input.userId,
			jobId: job.id,
		}),
		listDeepResearchEvidenceNotes({
			userId: input.userId,
			jobId: job.id,
		}),
	]);
	const claimGraphReviewer = await buildClaimGraphCitationReviewerWithLlm({
		context: {
			jobId: job.id,
			conversationId: job.conversationId,
			userId: job.userId,
			now,
		},
		claims: claimGraphClaims,
		evidenceNotes: claimGraphEvidenceNotes,
		concurrency: Math.min(
			2,
			Math.max(1, currentPlan.rawPlan.researchBudget.modelReasoningConcurrency),
		),
	});
	const claimGraphAuditResult = await auditAndPersistDeepResearchClaimGraph({
		userId: input.userId,
		jobId: job.id,
		claims: claimGraphClaims,
		evidenceNotes: claimGraphEvidenceNotes,
		reviewClaim: claimGraphReviewer ?? undefined,
		now,
	});
	if (claimGraphAuditResult) {
		await completeResearchResumePoint({
			userId: job.userId,
			jobId: job.id,
			resumeKey: citationAuditResumeKey,
			result: {
				source: "claim_graph",
				status: claimGraphAuditResult.status,
				canRenderMarkdown: claimGraphAuditResult.canRenderMarkdown,
				verdictCount: claimGraphAuditResult.verdicts.length,
			},
			now,
		});
		if (!(await loadFinalizableDeepResearchJobRow(job))) {
			return loadDeepResearchJobSnapshot({
				userId: job.userId,
				jobId: job.id,
				currentPlan,
			});
		}

		if (claimGraphAuditResult.status === "failed") {
			await saveResearchTimelineEvent({
				jobId: job.id,
				conversationId: job.conversationId,
				userId: job.userId,
				taskId: null,
				stage: "citation_audit",
				kind: "warning",
				occurredAt: now.toISOString(),
				messageKey: "deepResearch.timeline.citationAuditFailed",
				messageParams: {
					status: claimGraphAuditResult.status,
					retainedClaims: 0,
					removedClaims: claimGraphAuditResult.verdicts.length,
				},
				sourceCounts: sourceCountsFromSources(
					await listResearchSources({ userId: input.userId, jobId: job.id }),
				),
				assumptions: [],
				warnings: claimGraphAuditWarnings(claimGraphAuditResult),
				summary:
					"Citation audit failed because no credible supported claims remained.",
			});
			return completeDeepResearchJobWithEvidenceLimitationMemoFromState({
				job,
				currentPlan,
				sources: await listResearchSources({
					userId: input.userId,
					jobId: job.id,
				}),
				limitations: [
					...(input.limitations ?? []),
					...claimGraphAuditWarnings(claimGraphAuditResult),
				],
				now,
			});
		}

		if (claimGraphAuditResult.status === "needs_repair") {
			return createCitationAuditRepairPass({
				job,
				currentPlan,
				auditResult: claimGraphAuditResult,
				synthesisNotes: input.synthesisNotes,
				limitations: input.limitations,
				claims: claimGraphClaims,
				evidenceNotes: claimGraphEvidenceNotes,
				now,
			});
		}
	}

	const citedAt = now;
	const initialSources = await listResearchSources({
		userId: input.userId,
		jobId: job.id,
	});
	const verifiedSynthesisClaims = claimGraphClaims;
	const verifiedEvidenceNotes = claimGraphEvidenceNotes;
	const synthesisFindingsForCitations = [
		...input.synthesisNotes.findings,
		...input.synthesisNotes.supportedFindings,
	];
	const sourceIdsNeededForReport = new Set(
		synthesisFindingsForCitations.flatMap((finding) =>
			finding.sourceRefs.flatMap((sourceRef) => [
				sourceRef.discoveredSourceId,
				sourceRef.reviewedSourceId,
			]),
		),
	);
	if (sourceIdsNeededForReport.size === 0) {
		for (const source of initialSources) {
			if (source.reviewedAt) {
				sourceIdsNeededForReport.add(source.id);
			}
		}
	}
	for (const sourceId of sourceIdsFromVerifiedClaims(
		verifiedSynthesisClaims,
		verifiedEvidenceNotes,
	)) {
		sourceIdsNeededForReport.add(sourceId);
	}
	await Promise.all(
		initialSources
			.filter(
				(source) =>
					sourceIdsNeededForReport.has(source.id) &&
					source.reviewedAt &&
					!source.citedAt,
			)
			.map((source) =>
				markResearchSourceCited({
					userId: input.userId,
					sourceId: source.id,
					citedAt,
					citationNote: `Cited in audited Research Report for ${job.title}`,
				}),
			),
	);

	const sources = await listResearchSources({
		userId: input.userId,
		jobId: job.id,
	});
	await updateRunningDeepResearchStage({
		userId: job.userId,
		jobId: job.id,
		stage: "report_assembly",
		now,
	});
	await upsertResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		conversationId: job.conversationId,
		boundary: "report_assembly",
		resumeKey: reportAssemblyResumeKey,
		stage: "report_assembly",
		payload: {
			synthesisFindingCount: input.synthesisNotes.findings.length,
			limitationCount: input.limitations?.length ?? 0,
		},
		now,
	});
	const reportDraft = await writeResearchReportWithLlm({
		context: {
			jobId: job.id,
			conversationId: job.conversationId,
			userId: job.userId,
			now,
		},
		jobId: job.id,
		plan: currentPlan.rawPlan,
		synthesisNotes: input.synthesisNotes,
		synthesisClaims: verifiedSynthesisClaims,
		evidenceNotes: verifiedEvidenceNotes,
		sources: sources.map(mapSourceForReportWriter),
		limitations: input.limitations,
	});
	if (!(await loadFinalizableDeepResearchJobRow(job))) {
		return loadDeepResearchJobSnapshot({
			userId: job.userId,
			jobId: job.id,
			currentPlan,
		});
	}
	const citationAuditReportDraft = buildCitationAuditReportDraft(
		reportDraft,
		input.synthesisNotes,
	);
	await updateRunningDeepResearchStage({
		userId: job.userId,
		jobId: job.id,
		stage: "citation_audit",
		now,
	});
	await upsertResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		conversationId: job.conversationId,
		boundary: "citation_audit",
		resumeKey: citationAuditResumeKey,
		stage: "citation_audit",
		payload: {
			claimCount: citationAuditReportDraft.sections.reduce(
				(count, section) => count + section.claims.length,
				0,
			),
			sourceCount: sources.length,
		},
		now,
	});
	const citationAuditSources = sources.map((source) => ({
		id: source.id,
		status: source.status,
		title: source.title ?? source.url,
		url: source.url,
		reviewedAt: source.reviewedAt,
		citedAt: source.citedAt,
		reviewedNote: source.reviewedNote,
		citationNote: source.citationNote,
		snippet: source.snippet,
		sourceText: source.sourceText,
		supportedKeyQuestions: source.supportedKeyQuestions,
		extractedClaims: source.extractedClaims,
		sourceQualitySignals: source.sourceQualitySignals,
	}));
	const llmClaimReviewer = await buildCitationClaimReviewerWithLlm({
		context: {
			jobId: job.id,
			conversationId: job.conversationId,
			userId: job.userId,
			now,
		},
		report: citationAuditReportDraft,
		citedSources: citationAuditSources,
	});
	const auditResult = await auditDeepResearchReportCitations({
		jobId: job.id,
		report: citationAuditReportDraft,
		citedSources: citationAuditSources,
		reviewClaimSupport: llmClaimReviewer
			? async ({ claim }) => {
					const review = llmClaimReviewer(claim.id);
					if (review?.status === "repaired") {
						return {
							status: "unsupported",
							reason:
								"Citation audit repair requires an explicit Repair Pass before report rendering.",
						};
					}
					return review;
				}
			: undefined,
	});
	await completeResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		resumeKey: citationAuditResumeKey,
		result: {
			status: auditResult.status,
			canComplete: auditResult.canComplete,
		},
		now,
	});
	const repairResumeKey = `repair:${job.id}:audited`;
	await upsertResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		conversationId: job.conversationId,
		boundary: "repair",
		resumeKey: repairResumeKey,
		stage: "citation_audit",
		payload: {
			auditStatus: auditResult.status,
		},
		now,
	});
	await completeResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		resumeKey: repairResumeKey,
		result: {
			retainedClaims: auditResult.findings.filter((finding) =>
				["supported", "repaired"].includes(finding.status),
			).length,
			removedClaims: auditResult.findings.filter((finding) =>
				["unsupported_source", "unsupported_claim"].includes(finding.status),
			).length,
		},
		now,
	});
	await saveResearchTimelineEvent({
		jobId: job.id,
		conversationId: job.conversationId,
		userId: job.userId,
		taskId: null,
		stage: "citation_audit",
		kind: auditResult.canComplete ? "stage_completed" : "warning",
		occurredAt: now.toISOString(),
		messageKey: auditResult.canComplete
			? "deepResearch.timeline.citationAuditCompleted"
			: "deepResearch.timeline.citationAuditFailed",
		messageParams: {
			status: auditResult.status,
			retainedClaims: auditResult.findings.filter((finding) =>
				["supported", "repaired"].includes(finding.status),
			).length,
			removedClaims: auditResult.findings.filter((finding) =>
				["unsupported_source", "unsupported_claim"].includes(finding.status),
			).length,
		},
		sourceCounts: sourceCountsFromSources(sources),
		assumptions: [],
		warnings: citationAuditWarnings(auditResult),
		summary: auditResult.canComplete
			? "Citation audit completed and unsupported claims were removed or retained with citations."
			: "Citation audit failed because no credible supported claims remained.",
	});
	if (!(await loadFinalizableDeepResearchJobRow(job))) {
		return loadDeepResearchJobSnapshot({
			userId: job.userId,
			jobId: job.id,
			currentPlan,
		});
	}

	if (!auditResult.canComplete) {
		return completeDeepResearchJobWithEvidenceLimitationMemoFromState({
			job,
			currentPlan,
			sources,
			limitations: [
				...(input.limitations ?? []),
				...citationAuditWarnings(auditResult),
			],
			now,
		});
	}

	const auditedMarkdown = renderAuditedResearchReportMarkdown({
		reportDraft,
		auditedReport: auditResult.auditedReport,
		sources: reportDraft.sources,
		researchLanguage: currentPlan.rawPlan.researchLanguage ?? "en",
	});
	const reportName = buildReportArtifactName(
		job.title,
		currentPlan.rawPlan.researchLanguage ?? "en",
	);
	const reportArtifactId = `deep-research-report-${job.id}`;
	const existingReportArtifact = await loadArtifactById({
		userId: job.userId,
		artifactId: reportArtifactId,
	});
	const reportArtifact =
		existingReportArtifact ??
		(await createArtifact({
			id: reportArtifactId,
			userId: job.userId,
			conversationId: job.conversationId,
			type: "generated_output",
			retrievalClass: "durable",
			name: reportName,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: Buffer.byteLength(auditedMarkdown, "utf8"),
			contentText: auditedMarkdown,
			summary:
				(currentPlan.rawPlan.researchLanguage ?? "en") === "hu"
					? `Ellenőrzött kutatási jelentés: ${job.title}`
					: `Audited Research Report for ${job.title}`,
			metadata: {
				deepResearchReport: true,
				deepResearchReportKind: "audited",
				deepResearchJobId: job.id,
				deepResearchDepth: job.depth,
				deepResearchSourceLedgerSnapshot: {
					markdown: reportDraft.structuredReport.core.sourceLedgerSnapshot,
					sources: reportDraft.sourceLedgerSnapshotSources,
					sourceCounts: sourceCountsFromSources(sources),
				},
				documentFamilyId: randomUUID(),
				documentFamilyStatus: "active",
				documentLabel: reportName,
				documentRole: "research_report",
				versionNumber: 1,
				originConversationId: job.conversationId,
				citationAuditStatus: auditResult.status,
			},
		}));
	await completeResearchResumePoint({
		userId: job.userId,
		jobId: job.id,
		resumeKey: reportAssemblyResumeKey,
		result: {
			artifactId: reportArtifact.id,
			citationAuditStatus: auditResult.status,
		},
		now,
	});

	return finalizeAuditedReportJobFromArtifact({
		job,
		currentPlan,
		artifactId: reportArtifact.id,
		now,
	});
}

async function finalizeAuditedReportJobFromArtifact(input: {
	job: DeepResearchJobRow;
	currentPlan: DeepResearchPlanSummary;
	artifactId: string;
	now: Date;
}): Promise<DeepResearchJob | null> {
	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "completed",
			stage: "report_ready",
			reportArtifactId: input.artifactId,
			completedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, input.job.id),
				eq(deepResearchJobs.userId, input.job.userId),
				FINALIZABLE_JOB_STATUS_FILTER,
			),
		)
		.returning();
	if (!updatedJob) {
		return loadDeepResearchJobSnapshot({
			userId: input.job.userId,
			jobId: input.job.id,
			currentPlan: input.currentPlan,
		});
	}

	await db
		.update(conversations)
		.set({
			status: "sealed",
			sealedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(conversations.id, input.job.conversationId),
				eq(conversations.userId, input.job.userId),
			),
		);

	const timelineEvents = await loadTimelineEventsByJobId(input.job.userId, [
		updatedJob.id,
	]);
	return mapDeepResearchJob(
		updatedJob,
		input.currentPlan,
		timelineEvents.get(updatedJob.id) ?? [],
	);
}

async function loadFinalizableDeepResearchJobRow(
	job: Pick<DeepResearchJobRow, "id" | "userId">,
): Promise<DeepResearchJobRow | null> {
	const [freshJob] = await db
		.select()
		.from(deepResearchJobs)
		.where(
			and(
				eq(deepResearchJobs.id, job.id),
				eq(deepResearchJobs.userId, job.userId),
				FINALIZABLE_JOB_STATUS_FILTER,
			),
		)
		.limit(1);
	return freshJob ?? null;
}

async function updateRunningDeepResearchStage(input: {
	userId: string;
	jobId: string;
	stage: string;
	now: Date;
}): Promise<void> {
	await db
		.update(deepResearchJobs)
		.set({
			stage: input.stage,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, input.jobId),
				eq(deepResearchJobs.userId, input.userId),
				eq(deepResearchJobs.status, "running"),
			),
		);
}

async function loadDeepResearchJobSnapshot(input: {
	userId: string;
	jobId: string;
	currentPlan?: DeepResearchPlanSummary | null;
}): Promise<DeepResearchJob | null> {
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
	const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
		input.jobId,
	]);
	return mapDeepResearchJob(
		job,
		input.currentPlan ?? null,
		timelineEvents.get(input.jobId) ?? [],
	);
}

async function createCitationAuditRepairPass(input: {
	job: DeepResearchJobRow;
	currentPlan: DeepResearchPlanSummary;
	auditResult: Awaited<
		ReturnType<typeof auditAndPersistDeepResearchClaimGraph>
	>;
	synthesisNotes?: SynthesisNotes;
	limitations?: string[];
	claims?: DeepResearchSynthesisClaim[];
	evidenceNotes?: DeepResearchEvidenceNote[];
	now: Date;
}): Promise<DeepResearchJob | null> {
	if (!input.auditResult) return null;
	const repairVerdicts = input.auditResult.verdicts.filter((verdict) =>
		["needs_repair", "contradicted"].includes(verdict.verdict),
	);
	if (repairVerdicts.length === 0) return null;
	const [passCheckpoints, claims] = await Promise.all([
		listResearchPassCheckpoints({
			userId: input.job.userId,
			jobId: input.job.id,
		}),
		listDeepResearchSynthesisClaims({
			userId: input.job.userId,
			jobId: input.job.id,
		}),
	]);
	const claimsById = new Map(claims.map((claim) => [claim.id, claim]));
	const repairPassCeiling =
		input.currentPlan.rawPlan?.researchBudget.repairPassCeiling ?? 1;
	const existingRepairPasses = passCheckpoints.filter((checkpoint) =>
		/\b(repair|citation audit)\b/i.test(checkpoint.searchIntent),
	).length;
	if (existingRepairPasses >= repairPassCeiling) {
		if (input.synthesisNotes && input.claims && input.evidenceNotes) {
			const reportFromSupportedClaims =
				await completeAuditedReportWithSupportedClaimGraph({
					job: input.job,
					currentPlan: input.currentPlan,
					synthesisNotes: input.synthesisNotes,
					limitations: [
						...(input.limitations ?? []),
						`Repair pass budget exhausted after ${existingRepairPasses} repair pass${existingRepairPasses === 1 ? "" : "es"}.`,
					],
					auditResult: input.auditResult,
					claims: input.claims,
					evidenceNotes: input.evidenceNotes,
					now: input.now,
				});
			if (reportFromSupportedClaims) return reportFromSupportedClaims;
		}
		return completeDeepResearchJobWithEvidenceLimitationMemoFromState({
			job: input.job,
			currentPlan: input.currentPlan,
			sources: await listResearchSources({
				userId: input.job.userId,
				jobId: input.job.id,
			}),
			limitations: [
				`Repair pass budget exhausted after ${existingRepairPasses} repair pass${existingRepairPasses === 1 ? "" : "es"}.`,
				...claimGraphAuditWarnings(input.auditResult),
			],
			now: input.now,
		});
	}
	const passNumber =
		Math.max(1, ...passCheckpoints.map((checkpoint) => checkpoint.passNumber)) +
		1;
	const repairResumeKey = `repair:${input.job.id}:citation-audit:${passNumber}`;
	await upsertResearchResumePoint({
		userId: input.job.userId,
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		boundary: "repair",
		resumeKey: repairResumeKey,
		stage: "repair",
		passNumber,
		payload: {
			auditStatus: input.auditResult.status,
			repairVerdicts: repairVerdicts.length,
		},
		now: input.now,
	});
	await upsertResearchPassCheckpoint({
		userId: input.job.userId,
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		passNumber,
		searchIntent:
			"Citation audit repair pass for unsupported or contradicted Synthesis Claims",
		reviewedSourceIds: [],
		now: input.now,
	});
	const tasks = await createResearchTasksFromCoverageGaps({
		userId: input.job.userId,
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		passNumber,
		gaps: repairVerdicts.map((verdict) => {
			const claim = claimsById.get(verdict.claimId);
			return {
				id: `citation-audit:${verdict.claimId}`,
				keyQuestion: claim?.planQuestion ?? null,
				summary: [
					`Repair claim after citation audit: ${claim?.statement ?? verdict.claimId}`,
					`Audit verdict: ${verdict.verdict}.`,
					`Reason: ${verdict.reason}`,
				].join(" "),
				severity: claim?.central === false ? "important" : "critical",
			};
		}),
		now: input.now,
	});
	await db
		.update(deepResearchJobs)
		.set({
			status: "running",
			stage: "research_tasks",
			updatedAt: input.now,
		})
		.where(eq(deepResearchJobs.id, input.job.id));
	await completeResearchResumePoint({
		userId: input.job.userId,
		jobId: input.job.id,
		resumeKey: repairResumeKey,
		result: {
			passNumber,
			taskIds: tasks.map((task) => task.id),
		},
		now: input.now,
	});
	await saveResearchTimelineEvent({
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		userId: input.job.userId,
		taskId: null,
		stage: "repair",
		kind: "stage_started",
		occurredAt: input.now.toISOString(),
		messageKey: "deepResearch.timeline.citationAuditRepairPassCreated",
		messageParams: {
			passNumber,
			repairTasks: tasks.length,
		},
		sourceCounts: sourceCountsFromSources(
			await listResearchSources({
				userId: input.job.userId,
				jobId: input.job.id,
			}),
		),
		assumptions: [],
		warnings: claimGraphAuditWarnings(input.auditResult).slice(0, 6),
		summary: `Citation audit created repair pass ${passNumber} with ${tasks.length} repair task${tasks.length === 1 ? "" : "s"}.`,
	});
	const [updatedJob] = await db
		.select()
		.from(deepResearchJobs)
		.where(eq(deepResearchJobs.id, input.job.id))
		.limit(1);
	if (!updatedJob) return null;
	const [timelineEvents, passStates, sourceLedgers] = await Promise.all([
		loadTimelineEventsByJobId(input.job.userId, [input.job.id]),
		loadPassStatesByJobId(input.job.userId, [input.job.id]),
		loadSourceLedgersByJobId(input.job.userId, input.job.conversationId, [
			input.job.id,
		]),
	]);
	return mapDeepResearchJob(
		updatedJob,
		input.currentPlan,
		timelineEvents.get(input.job.id) ?? [],
		sourceLedgers.get(input.job.id),
		{
			passCheckpoints: passStates.get(input.job.id)?.passCheckpoints ?? [],
			coverageGaps: passStates.get(input.job.id)?.coverageGaps ?? [],
			evidenceNotes: passStates.get(input.job.id)?.evidenceNotes ?? [],
			synthesisClaims: passStates.get(input.job.id)?.synthesisClaims ?? [],
			resumePoints: passStates.get(input.job.id)?.resumePoints ?? [],
		},
	);
}

async function completeAuditedReportWithSupportedClaimGraph(input: {
	job: DeepResearchJobRow;
	currentPlan: DeepResearchPlanSummary;
	synthesisNotes: SynthesisNotes;
	limitations: string[];
	auditResult: NonNullable<
		Awaited<ReturnType<typeof auditAndPersistDeepResearchClaimGraph>>
	>;
	claims: DeepResearchSynthesisClaim[];
	evidenceNotes: DeepResearchEvidenceNote[];
	now: Date;
}): Promise<DeepResearchJob | null> {
	const verifiedSynthesisClaims = filterSynthesisClaimsForReportableVerdicts({
		claims: input.claims,
		auditResult: input.auditResult,
	});
	if (verifiedSynthesisClaims.length === 0) return null;

	const citedAt = input.now;
	const initialSources = await listResearchSources({
		userId: input.job.userId,
		jobId: input.job.id,
	});
	const synthesisFindingsForCitations = [
		...input.synthesisNotes.findings,
		...input.synthesisNotes.supportedFindings,
	];
	const sourceIdsNeededForReport = new Set(
		synthesisFindingsForCitations.flatMap((finding) =>
			finding.sourceRefs.flatMap((sourceRef) => [
				sourceRef.discoveredSourceId,
				sourceRef.reviewedSourceId,
			]),
		),
	);
	for (const sourceId of sourceIdsFromVerifiedClaims(
		verifiedSynthesisClaims,
		input.evidenceNotes,
	)) {
		sourceIdsNeededForReport.add(sourceId);
	}
	await Promise.all(
		initialSources
			.filter(
				(source) =>
					sourceIdsNeededForReport.has(source.id) &&
					source.reviewedAt &&
					!source.citedAt,
			)
			.map((source) =>
				markResearchSourceCited({
					userId: input.job.userId,
					sourceId: source.id,
					citedAt,
					citationNote: `Cited in audited Research Report for ${input.job.title}`,
				}),
			),
	);

	const sources = await listResearchSources({
		userId: input.job.userId,
		jobId: input.job.id,
	});
	await updateRunningDeepResearchStage({
		userId: input.job.userId,
		jobId: input.job.id,
		stage: "report_assembly",
		now: input.now,
	});
	const reportLimitations = [
		...input.limitations,
		...claimGraphReportLimitations(input.auditResult),
	];
	const reportDraft = await writeResearchReportWithLlm({
		context: {
			jobId: input.job.id,
			conversationId: input.job.conversationId,
			userId: input.job.userId,
			now: input.now,
		},
		jobId: input.job.id,
		plan: input.currentPlan.rawPlan,
		synthesisNotes: input.synthesisNotes,
		synthesisClaims: verifiedSynthesisClaims,
		evidenceNotes: input.evidenceNotes,
		sources: sources.map(mapSourceForReportWriter),
		limitations: reportLimitations,
	});
	if (!(await loadFinalizableDeepResearchJobRow(input.job))) {
		return loadDeepResearchJobSnapshot({
			userId: input.job.userId,
			jobId: input.job.id,
			currentPlan: input.currentPlan,
		});
	}
	const citationAuditReportDraft = buildCitationAuditReportDraft(
		reportDraft,
		input.synthesisNotes,
	);
	const citationAuditSources = sources.map((source) => ({
		id: source.id,
		status: source.status,
		title: source.title ?? source.url,
		url: source.url,
		reviewedAt: source.reviewedAt,
		citedAt: source.citedAt,
		reviewedNote: source.reviewedNote,
		citationNote: source.citationNote,
		snippet: source.snippet,
		sourceText: source.sourceText,
		supportedKeyQuestions: source.supportedKeyQuestions,
		extractedClaims: source.extractedClaims,
		sourceQualitySignals: source.sourceQualitySignals,
	}));
	const llmClaimReviewer = await buildCitationClaimReviewerWithLlm({
		context: {
			jobId: input.job.id,
			conversationId: input.job.conversationId,
			userId: input.job.userId,
			now: input.now,
		},
		report: citationAuditReportDraft,
		citedSources: citationAuditSources,
	});
	const auditResult = await auditDeepResearchReportCitations({
		jobId: input.job.id,
		report: citationAuditReportDraft,
		citedSources: citationAuditSources,
		reviewClaimSupport: llmClaimReviewer
			? async ({ claim }) => llmClaimReviewer(claim.id)
			: undefined,
	});
	await saveResearchTimelineEvent({
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		userId: input.job.userId,
		taskId: null,
		stage: "citation_audit",
		kind: auditResult.canComplete ? "stage_completed" : "warning",
		occurredAt: input.now.toISOString(),
		messageKey: auditResult.canComplete
			? "deepResearch.timeline.citationAuditCompleted"
			: "deepResearch.timeline.citationAuditFailed",
		messageParams: {
			status: auditResult.status,
			retainedClaims: auditResult.findings.filter((finding) =>
				["supported", "repaired"].includes(finding.status),
			).length,
			removedClaims: auditResult.findings.filter((finding) =>
				["unsupported_source", "unsupported_claim"].includes(finding.status),
			).length,
		},
		sourceCounts: sourceCountsFromSources(sources),
		assumptions: [],
		warnings: citationAuditWarnings(auditResult),
		summary: auditResult.canComplete
			? "Citation audit completed and unsupported claims were removed or retained with citations."
			: "Citation audit failed because no credible supported claims remained.",
	});
	if (!auditResult.canComplete) return null;

	const auditedMarkdown = renderAuditedResearchReportMarkdown({
		reportDraft,
		auditedReport: auditResult.auditedReport,
		sources: reportDraft.sources,
		researchLanguage: input.currentPlan.rawPlan.researchLanguage ?? "en",
	});
	const reportName = buildReportArtifactName(
		input.job.title,
		input.currentPlan.rawPlan.researchLanguage ?? "en",
	);
	const reportArtifactId = `deep-research-report-${input.job.id}`;
	const existingReportArtifact = await loadArtifactById({
		userId: input.job.userId,
		artifactId: reportArtifactId,
	});
	const reportArtifact =
		existingReportArtifact ??
		(await createArtifact({
			id: reportArtifactId,
			userId: input.job.userId,
			conversationId: input.job.conversationId,
			type: "generated_output",
			retrievalClass: "durable",
			name: reportName,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: Buffer.byteLength(auditedMarkdown, "utf8"),
			contentText: auditedMarkdown,
			summary:
				(input.currentPlan.rawPlan.researchLanguage ?? "en") === "hu"
					? `Ellenőrzött kutatási jelentés: ${input.job.title}`
					: `Audited Research Report for ${input.job.title}`,
			metadata: {
				deepResearchReport: true,
				deepResearchReportKind: "audited",
				deepResearchJobId: input.job.id,
				deepResearchDepth: input.job.depth,
				deepResearchSourceLedgerSnapshot: {
					markdown: reportDraft.structuredReport.core.sourceLedgerSnapshot,
					sources: reportDraft.sourceLedgerSnapshotSources,
					sourceCounts: sourceCountsFromSources(sources),
				},
				documentFamilyId: randomUUID(),
				documentFamilyStatus: "active",
				documentLabel: reportName,
				documentRole: "research_report",
				versionNumber: 1,
				originConversationId: input.job.conversationId,
				citationAuditStatus: auditResult.status,
			},
		}));
	return finalizeAuditedReportJobFromArtifact({
		job: input.job,
		currentPlan: input.currentPlan,
		artifactId: reportArtifact.id,
		now: input.now,
	});
}

export async function completeDeepResearchJobWithEvidenceLimitationMemo(
	input: CompleteDeepResearchJobWithEvidenceLimitationMemoInput,
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
	if (
		job.status === "completed" &&
		job.stage === "evidence_limitation_memo_ready" &&
		job.reportArtifactId
	) {
		const currentPlans = await loadCurrentPlansByJobId([job.id]);
		const timelineEvents = await loadTimelineEventsByJobId(input.userId, [
			job.id,
		]);
		return mapDeepResearchJob(
			job,
			currentPlans.get(job.id) ?? null,
			timelineEvents.get(job.id) ?? [],
		);
	}
	if (job.status !== "approved" && job.status !== "running") {
		return null;
	}

	const currentPlans = await loadCurrentPlansByJobId([job.id]);
	const currentPlan = currentPlans.get(job.id);
	if (!currentPlan?.rawPlan) return null;
	const sources = await listResearchSources({
		userId: input.userId,
		jobId: job.id,
	});

	return completeDeepResearchJobWithEvidenceLimitationMemoFromState({
		job,
		currentPlan,
		sources,
		limitations: input.limitations,
		now,
	});
}

async function completeDeepResearchJobWithEvidenceLimitationMemoFromState(input: {
	job: DeepResearchJobRow;
	currentPlan: DeepResearchPlanSummary;
	sources: DeepResearchSource[];
	limitations: string[];
	now: Date;
}): Promise<DeepResearchJob | null> {
	if (!input.currentPlan.rawPlan) return null;
	const memoResumeKey = `report:${input.job.id}:evidence_limitation_memo`;
	const existingMemoResumePoint = await getResearchResumePoint({
		userId: input.job.userId,
		jobId: input.job.id,
		resumeKey: memoResumeKey,
	});
	const existingMemoArtifactId =
		typeof existingMemoResumePoint?.result?.artifactId === "string"
			? existingMemoResumePoint.result.artifactId
			: null;
	if (existingMemoArtifactId) {
		return finalizeEvidenceLimitationMemoJobFromArtifact({
			job: input.job,
			currentPlan: input.currentPlan,
			artifactId: existingMemoArtifactId,
			now: input.now,
		});
	}
	const researchLanguage = input.currentPlan.rawPlan.researchLanguage ?? "en";
	const reviewedScope = buildEvidenceLimitationReviewedScope({
		plan: input.currentPlan.rawPlan,
		sources: input.sources,
	});
	await upsertResearchResumePoint({
		userId: input.job.userId,
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		boundary: "report_assembly",
		resumeKey: memoResumeKey,
		stage: "evidence_limitation_memo",
		payload: {
			limitationCount: input.limitations.length,
			reviewedCount: reviewedScope.reviewedCount,
		},
		now: input.now,
	});
	const memo = writeEvidenceLimitationMemo({
		jobId: input.job.id,
		plan: input.currentPlan.rawPlan,
		reviewedScope,
		limitations: input.limitations,
		nextResearchDirection: buildEvidenceLimitationNextResearchDirection({
			limitations: input.limitations,
			researchLanguage,
		}),
		sources: input.sources.map(mapSourceForReportWriter),
	});
	if (!(await loadFinalizableDeepResearchJobRow(input.job))) {
		return loadDeepResearchJobSnapshot({
			userId: input.job.userId,
			jobId: input.job.id,
			currentPlan: input.currentPlan,
		});
	}
	const memoName = buildEvidenceLimitationMemoArtifactName(
		input.job.title,
		researchLanguage,
	);
	const memoArtifactId = `deep-research-memo-${input.job.id}`;
	const existingMemoArtifact = await loadArtifactById({
		userId: input.job.userId,
		artifactId: memoArtifactId,
	});
	const memoArtifact =
		existingMemoArtifact ??
		(await createArtifact({
			id: memoArtifactId,
			userId: input.job.userId,
			conversationId: input.job.conversationId,
			type: "generated_output",
			retrievalClass: "durable",
			name: memoName,
			mimeType: "text/markdown",
			extension: "md",
			sizeBytes: Buffer.byteLength(memo.markdown, "utf8"),
			contentText: memo.markdown,
			summary:
				researchLanguage === "hu"
					? `Bizonyítékkorlát-memó: ${input.job.title}`
					: `Evidence Limitation Memo for ${input.job.title}`,
			metadata: {
				deepResearchEvidenceLimitationMemo: true,
				deepResearchReport: false,
				deepResearchJobId: input.job.id,
				deepResearchDepth: input.job.depth,
				deepResearchSourceLedgerSnapshot: {
					markdown: memo.sourceLedgerSnapshot,
					sources: memo.sourceLedgerSnapshotSources,
					sourceCounts: sourceCountsFromSources(input.sources),
				},
				documentFamilyId: randomUUID(),
				documentFamilyStatus: "active",
				documentLabel: memoName,
				documentRole: "evidence_limitation_memo",
				memoTitle: memo.title,
				versionNumber: 1,
				originConversationId: input.job.conversationId,
				reviewedScope: memo.reviewedScope,
				groundedLimitationReasons: memo.limitations,
				nextResearchDirection: memo.nextResearchDirection,
				memoRecoveryActions: memo.recoveryActions,
			},
		}));
	await completeResearchResumePoint({
		userId: input.job.userId,
		jobId: input.job.id,
		resumeKey: memoResumeKey,
		result: {
			artifactId: memoArtifact.id,
		},
		now: input.now,
	});

	await saveResearchTimelineEvent({
		jobId: input.job.id,
		conversationId: input.job.conversationId,
		userId: input.job.userId,
		taskId: null,
		stage: "evidence_limitation_memo",
		kind: "stage_completed",
		occurredAt: input.now.toISOString(),
		messageKey: "deepResearch.timeline.evidenceLimitationMemoCompleted",
		messageParams: {
			topicRelevantSources: reviewedScope.topicRelevantCount,
			rejectedOrOffTopicSources: reviewedScope.rejectedOrOffTopicCount,
		},
		sourceCounts: sourceCountsFromSources(input.sources),
		assumptions: [],
		warnings: memo.limitations,
		summary:
			researchLanguage === "hu"
				? "A kutatás bizonyítékkorlát-memóval zárult, mert nem volt elég hiteles, témához illeszkedő bizonyíték."
				: "Research completed with an Evidence Limitation Memo because there was not enough credible topic-relevant evidence.",
	});

	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "completed",
			stage: "evidence_limitation_memo_ready",
			reportArtifactId: memoArtifact.id,
			completedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, input.job.id),
				eq(deepResearchJobs.userId, input.job.userId),
				FINALIZABLE_JOB_STATUS_FILTER,
			),
		)
		.returning();
	if (!updatedJob) {
		return loadDeepResearchJobSnapshot({
			userId: input.job.userId,
			jobId: input.job.id,
			currentPlan: input.currentPlan,
		});
	}
	const timelineEvents = await loadTimelineEventsByJobId(input.job.userId, [
		updatedJob.id,
	]);
	return mapDeepResearchJob(
		updatedJob,
		input.currentPlan,
		timelineEvents.get(updatedJob.id) ?? [],
		undefined,
		{ evidenceLimitationMemo: toEvidenceLimitationMemoPayload(memo) },
	);
}

async function finalizeEvidenceLimitationMemoJobFromArtifact(input: {
	job: DeepResearchJobRow;
	currentPlan: DeepResearchPlanSummary;
	artifactId: string;
	now: Date;
}): Promise<DeepResearchJob | null> {
	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({
			status: "completed",
			stage: "evidence_limitation_memo_ready",
			reportArtifactId: input.artifactId,
			completedAt: input.now,
			updatedAt: input.now,
		})
		.where(
			and(
				eq(deepResearchJobs.id, input.job.id),
				eq(deepResearchJobs.userId, input.job.userId),
				FINALIZABLE_JOB_STATUS_FILTER,
			),
		)
		.returning();
	if (!updatedJob) {
		return loadDeepResearchJobSnapshot({
			userId: input.job.userId,
			jobId: input.job.id,
			currentPlan: input.currentPlan,
		});
	}
	const timelineEvents = await loadTimelineEventsByJobId(input.job.userId, [
		updatedJob.id,
	]);
	return mapDeepResearchJob(
		updatedJob,
		input.currentPlan,
		timelineEvents.get(updatedJob.id) ?? [],
	);
}

function toEvidenceLimitationMemoPayload(input: {
	title: string;
	reviewedScope: DeepResearchEvidenceLimitationMemo["reviewedScope"];
	limitations: string[];
	nextResearchDirection: string;
	recoveryActions: DeepResearchEvidenceLimitationMemo["recoveryActions"];
}): DeepResearchEvidenceLimitationMemo {
	return {
		title: input.title,
		reviewedScope: input.reviewedScope,
		limitations: input.limitations,
		nextResearchDirection: input.nextResearchDirection,
		recoveryActions: input.recoveryActions,
	};
}

export async function discussDeepResearchReport(
	input: DiscussDeepResearchReportInput,
): Promise<DeepResearchReportActionResult | null> {
	return withReportActionLock(
		`discuss:${input.userId}:${input.jobId}:${input.persistSeedMessage === true ? "persisted" : "pending"}`,
		async () => {
			const context = await loadCompletedResearchArtifactContext(input);
			if (!context) return null;

			const researchLanguage = resolveReportLanguage(context);
			const seedMessage = buildDiscussReportSeedMessage(
				context,
				researchLanguage,
			);
			const existingAction = await loadExistingDiscussDeepResearchReportAction({
				userId: input.userId,
				context,
				researchLanguage,
				seedMessage,
				persistSeedMessage: input.persistSeedMessage === true,
			});
			if (existingAction) return existingAction;

			const conversation = await createConversation(
				input.userId,
				buildFollowupConversationTitle("Discuss", context.job.title),
				{ projectId: context.sourceProjectId },
			);
			const message = input.persistSeedMessage
				? await createMessage(
						conversation.id,
						"user",
						seedMessage,
						undefined,
						undefined,
						{
							deepResearchReportContext: {
								action:
									context.artifactKind === "memo" ? "discuss_memo" : "discuss",
								sourceJobId: context.job.id,
								sourceConversationId: context.job.conversationId,
								reportArtifactId: context.report.id,
								researchLanguage,
							},
						},
					)
				: null;
			await createArtifactLink({
				userId: input.userId,
				artifactId: context.report.id,
				linkType: "attached_to_conversation",
				conversationId: conversation.id,
				messageId: message?.id,
			});

			return {
				sourceJobId: context.job.id,
				reportArtifactId: context.report.id,
				conversation,
				messageId: message?.id,
				seedMessage,
				researchLanguage,
			};
		},
	);
}

export async function researchFurtherFromDeepResearchReport(
	input: ResearchFurtherFromDeepResearchReportInput,
): Promise<ResearchFurtherReportActionResult | null> {
	return withReportActionLock(
		`research-further:${input.userId}:${input.jobId}:${input.depth ?? "source-depth"}`,
		async () => {
			const context = await loadCompletedResearchArtifactContext(input);
			if (!context) return null;

			const depth = input.depth ?? (context.job.depth as DeepResearchDepth);
			const researchLanguage =
				input.researchLanguage ?? resolveReportLanguage(context);
			const userRequest = buildResearchFurtherSeedMessage(
				context,
				researchLanguage,
			);
			const actionKind =
				context.artifactKind === "memo"
					? "research_further_from_memo"
					: "research_further";
			const existingAction =
				await loadExistingResearchFurtherDeepResearchAction({
					userId: input.userId,
					context,
					depth,
					researchLanguage,
					seedMessage: userRequest,
					action: actionKind,
				});
			if (existingAction) return existingAction;

			const conversation = await createConversation(
				input.userId,
				buildFollowupConversationTitle("Research further", context.job.title),
				{ projectId: context.sourceProjectId },
			);
			const message = await createMessage(
				conversation.id,
				"user",
				userRequest,
				undefined,
				undefined,
				{
					deepResearchReportContext: {
						action: actionKind,
						sourceJobId: context.job.id,
						sourceConversationId: context.job.conversationId,
						reportArtifactId: context.report.id,
						requestedDepth: depth,
						researchLanguage,
					},
				},
			);
			await createArtifactLink({
				userId: input.userId,
				artifactId: context.report.id,
				linkType: "attached_to_conversation",
				conversationId: conversation.id,
				messageId: message.id,
			});

			const job = await startDeepResearchJobShell({
				userId: input.userId,
				conversationId: conversation.id,
				triggerMessageId: message.id,
				userRequest,
				depth,
				researchLanguage,
				planningContext: [
					{
						type: "report",
						title: context.report.name,
						summary:
							context.report.summary ??
							context.report.contentText ??
							context.job.title,
					},
				],
				now: input.now,
			});

			return {
				sourceJobId: context.job.id,
				reportArtifactId: context.report.id,
				conversation,
				messageId: message.id,
				seedMessage: userRequest,
				researchLanguage,
				job,
			};
		},
	);
}

async function withReportActionLock<T>(
	key: string,
	action: () => Promise<T>,
): Promise<T> {
	const existingAction = inFlightReportActions.get(key) as
		| Promise<T>
		| undefined;
	if (existingAction) return existingAction;

	let actionPromise: Promise<T>;
	actionPromise = action().finally(() => {
		if (inFlightReportActions.get(key) === actionPromise) {
			inFlightReportActions.delete(key);
		}
	});
	inFlightReportActions.set(key, actionPromise);
	return actionPromise;
}

async function loadExistingDiscussDeepResearchReportAction(input: {
	userId: string;
	context: ResearchReportContext;
	researchLanguage: ResearchLanguage;
	seedMessage: string;
	persistSeedMessage: boolean;
}): Promise<DeepResearchReportActionResult | null> {
	const action =
		input.context.artifactKind === "memo" ? "discuss_memo" : "discuss";
	if (input.persistSeedMessage) {
		const existingMessage = await loadExistingReportActionMessage({
			userId: input.userId,
			sourceJobId: input.context.job.id,
			reportArtifactId: input.context.report.id,
			action,
		});
		if (existingMessage) {
			return {
				sourceJobId: input.context.job.id,
				reportArtifactId: input.context.report.id,
				conversation: mapConversationRow(existingMessage.conversation),
				messageId: existingMessage.message.id,
				seedMessage: existingMessage.message.content || input.seedMessage,
				researchLanguage: input.researchLanguage,
			};
		}
	}

	const [existingConversation] = await db
		.select({
			conversation: conversations,
		})
		.from(artifactLinks)
		.innerJoin(
			conversations,
			eq(artifactLinks.conversationId, conversations.id),
		)
		.where(
			and(
				eq(artifactLinks.userId, input.userId),
				eq(artifactLinks.artifactId, input.context.report.id),
				eq(artifactLinks.linkType, "attached_to_conversation"),
				isNull(artifactLinks.messageId),
				eq(conversations.userId, input.userId),
				eq(
					conversations.title,
					buildFollowupConversationTitle("Discuss", input.context.job.title),
				),
			),
		)
		.orderBy(asc(artifactLinks.createdAt))
		.limit(1);
	if (!existingConversation) return null;

	return {
		sourceJobId: input.context.job.id,
		reportArtifactId: input.context.report.id,
		conversation: mapConversationRow(existingConversation.conversation),
		seedMessage: input.seedMessage,
		researchLanguage: input.researchLanguage,
	};
}

async function loadExistingResearchFurtherDeepResearchAction(input: {
	userId: string;
	context: ResearchReportContext;
	depth: DeepResearchDepth;
	researchLanguage: ResearchLanguage;
	seedMessage: string;
	action: "research_further" | "research_further_from_memo";
}): Promise<ResearchFurtherReportActionResult | null> {
	const existingMessage = await loadExistingReportActionMessage({
		userId: input.userId,
		sourceJobId: input.context.job.id,
		reportArtifactId: input.context.report.id,
		action: input.action,
		depth: input.depth,
	});
	if (!existingMessage?.job) return null;

	const [currentPlans, timelineEvents] = await Promise.all([
		loadCurrentPlansByJobId([existingMessage.job.id]),
		loadTimelineEventsByJobId(input.userId, [existingMessage.job.id]),
	]);

	return {
		sourceJobId: input.context.job.id,
		reportArtifactId: input.context.report.id,
		conversation: mapConversationRow(existingMessage.conversation),
		messageId: existingMessage.message.id,
		seedMessage: existingMessage.message.content || input.seedMessage,
		researchLanguage: input.researchLanguage,
		job: mapDeepResearchJob(
			existingMessage.job,
			currentPlans.get(existingMessage.job.id) ?? null,
			timelineEvents.get(existingMessage.job.id) ?? [],
		),
	};
}

async function loadExistingReportActionMessage(input: {
	userId: string;
	sourceJobId: string;
	reportArtifactId: string;
	action: string;
	depth?: DeepResearchDepth;
}): Promise<ExistingReportActionMessage | null> {
	const rows = await db
		.select({
			message: messages,
			conversation: conversations,
			job: deepResearchJobs,
		})
		.from(messages)
		.innerJoin(conversations, eq(messages.conversationId, conversations.id))
		.leftJoin(
			deepResearchJobs,
			and(
				eq(deepResearchJobs.conversationId, messages.conversationId),
				eq(deepResearchJobs.triggerMessageId, messages.id),
				eq(deepResearchJobs.userId, input.userId),
			),
		)
		.where(
			and(
				eq(conversations.userId, input.userId),
				eq(messages.role, "user"),
				like(messages.metadataJson, `%"sourceJobId":"${input.sourceJobId}"%`),
			),
		)
		.orderBy(...messageTimestampOrderAsc());

	for (const row of rows) {
		const metadata = parseDeepResearchReportContextMetadata(
			row.message.metadataJson,
		);
		if (!metadata) continue;
		if (
			metadata.action !== input.action ||
			metadata.sourceJobId !== input.sourceJobId ||
			metadata.reportArtifactId !== input.reportArtifactId
		) {
			continue;
		}
		if (input.depth) {
			if (metadata.requestedDepth) {
				if (metadata.requestedDepth !== input.depth) continue;
			} else if (row.job?.depth !== input.depth) {
				continue;
			}
		}
		return {
			message: row.message,
			conversation: row.conversation,
			job: row.job ?? null,
		};
	}
	return null;
}

function parseDeepResearchReportContextMetadata(
	metadataJson: string | null,
): DeepResearchReportContextMetadata | null {
	if (!metadataJson) return null;
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataJson);
	} catch {
		return null;
	}
	if (!metadata || typeof metadata !== "object") return null;
	const context = (metadata as Record<string, unknown>)
		.deepResearchReportContext;
	if (!context || typeof context !== "object") return null;
	const record = context as Record<string, unknown>;
	const action = readStringRecordValue(record, "action");
	const sourceJobId = readStringRecordValue(record, "sourceJobId");
	const reportArtifactId = readStringRecordValue(record, "reportArtifactId");
	if (!action || !sourceJobId || !reportArtifactId) return null;
	const requestedDepth = readDeepResearchDepth(record.requestedDepth);
	return {
		action,
		sourceJobId,
		reportArtifactId,
		...(requestedDepth ? { requestedDepth } : {}),
	};
}

function readStringRecordValue(
	record: Record<string, unknown>,
	key: string,
): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim() ? value : null;
}

function readDeepResearchDepth(value: unknown): DeepResearchDepth | null {
	return value === "focused" || value === "standard" || value === "max"
		? value
		: null;
}

function mapConversationRow(
	row: typeof conversations.$inferSelect,
): Conversation {
	return {
		id: row.id,
		title: row.title,
		projectId: row.projectId ?? null,
		createdAt: row.createdAt.getTime() / 1000,
		updatedAt: row.updatedAt.getTime() / 1000,
	};
}

async function loadCompletedResearchArtifactContext(input: {
	userId: string;
	jobId: string;
}): Promise<ResearchReportContext | null> {
	const [row] = await db
		.select({
			job: deepResearchJobs,
			report: artifacts,
			sourceProjectId: conversations.projectId,
		})
		.from(deepResearchJobs)
		.innerJoin(artifacts, eq(deepResearchJobs.reportArtifactId, artifacts.id))
		.innerJoin(conversations, eq(deepResearchJobs.conversationId, conversations.id))
		.where(
			and(
				eq(deepResearchJobs.id, input.jobId),
				eq(deepResearchJobs.userId, input.userId),
				eq(deepResearchJobs.status, "completed"),
				eq(artifacts.userId, input.userId),
				eq(conversations.userId, input.userId),
			),
		)
		.limit(1);

	const artifactKind = classifyDeepResearchCompletedArtifact(
		row?.report.metadataJson ?? null,
	);
	if (!row || !artifactKind) {
		return null;
	}
	return { ...row, artifactKind };
}

async function loadArtifactById(input: {
	userId: string;
	artifactId: string;
}): Promise<typeof artifacts.$inferSelect | null> {
	const [artifact] = await db
		.select()
		.from(artifacts)
		.where(
			and(
				eq(artifacts.id, input.artifactId),
				eq(artifacts.userId, input.userId),
			),
		)
		.limit(1);
	return artifact ?? null;
}

function classifyDeepResearchCompletedArtifact(
	metadataJson: string | null,
): "report" | "memo" | null {
	if (!metadataJson) return null;
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataJson);
	} catch {
		return null;
	}
	if (!metadata || typeof metadata !== "object") return null;
	const record = metadata as Record<string, unknown>;
	if (
		record.deepResearchReport === true &&
		record.documentRole === "research_report" &&
		record.deepResearchEvidenceLimitationMemo !== true
	) {
		return "report";
	}
	if (
		record.deepResearchEvidenceLimitationMemo === true &&
		record.documentRole === "evidence_limitation_memo"
	) {
		return "memo";
	}
	return null;
}

async function applyGeneratedResearchTitle(input: {
	userId: string;
	conversationId: string;
	job: DeepResearchJobRow;
	userRequest: string;
	assistantContext: string;
	now: Date;
}): Promise<DeepResearchJobRow> {
	const title = await generateDeepResearchTitle(
		input.userRequest,
		input.assistantContext,
	);
	if (title === input.job.title) return input.job;
	const [updatedJob] = await db
		.update(deepResearchJobs)
		.set({ title, updatedAt: input.now })
		.where(eq(deepResearchJobs.id, input.job.id))
		.returning();
	await updateConversationTitle(
		input.userId,
		input.conversationId,
		title,
	).catch(() => null);
	return updatedJob ?? input.job;
}

async function generateDeepResearchTitle(
	userRequest: string,
	assistantContext: string,
): Promise<string> {
	const fallback = buildJobTitle(userRequest);
	if (process.env.NODE_ENV === "test") return fallback;
	try {
		const title = await generateTitle(userRequest, assistantContext);
		return normalizeTitleWithoutEllipsis(title) || fallback;
	} catch {
		return fallback;
	}
}

function buildJobTitle(userRequest: string): string {
	return normalizeTitleWithoutEllipsis(userRequest) || "Deep Research";
}

function buildFollowupConversationTitle(
	prefix: string,
	jobTitle: string,
): string {
	return normalizeTitleWithoutEllipsis(`${prefix}: ${jobTitle}`) || prefix;
}

function normalizeTitleWithoutEllipsis(value: string): string {
	return value
		.replace(/\s+/g, " ")
		.replace(/\.{3,}$/u, "")
		.trim();
}

function resolveReportLanguage(
	context: ResearchReportContext,
): ResearchLanguage {
	const text = `${context.job.title}\n${context.job.userRequest}\n${context.report.contentText ?? ""}`;
	return resolveResearchLanguage({ userRequest: text });
}

function buildDiscussReportSeedMessage(
	context: ResearchReportContext,
	researchLanguage: ResearchLanguage,
): string {
	if (researchLanguage === "hu") {
		const artifactLabel =
			context.artifactKind === "memo"
				? "bizonyítékkorlát-memót"
				: "kutatási jelentést";
		return [
			`Beszéljük át ezt a ${artifactLabel}: ${context.report.name}`,
			"",
			`Forrás mély kutatási téma: ${context.job.title}`,
			"",
			`A csatolt ${artifactLabel} használd munkakontextusként, és magyarul válaszolj.`,
		].join("\n");
	}
	const artifactLabel =
		context.artifactKind === "memo"
			? "Evidence Limitation Memo"
			: "Research Report";
	return [
		`Discuss this ${artifactLabel}: ${context.report.name}`,
		"",
		`Source Deep Research topic: ${context.job.title}`,
		"",
		`Use the attached ${artifactLabel} as the working context for this normal chat.`,
	].join("\n");
}

function buildResearchFurtherSeedMessage(
	context: ResearchReportContext,
	researchLanguage: ResearchLanguage,
): string {
	if (researchLanguage === "hu") {
		const artifactLabel =
			context.artifactKind === "memo"
				? "bizonyítékkorlát-memóból"
				: "kutatási jelentésből";
		return [
			`Kutass tovább ebből a ${artifactLabel}: ${context.report.name}`,
			"",
			`Forrás mély kutatási téma: ${context.job.title}`,
			"",
			"A csatolt anyagot használd tervezési kontextusként, készíts új jóváhagyandó mély kutatási tervet, és magyarul válaszolj.",
		].join("\n");
	}
	const artifactLabel =
		context.artifactKind === "memo"
			? "Evidence Limitation Memo"
			: "Research Report";
	return [
		`Research further from this ${artifactLabel}: ${context.report.name}`,
		"",
		`Source Deep Research topic: ${context.job.title}`,
		"",
		`Use the attached ${artifactLabel} as planning context and draft a new Deep Research Plan for approval.`,
	].join("\n");
}

function mapSourceForReportWriter(source: DeepResearchSource) {
	return {
		id: source.id,
		reviewedSourceId: source.id,
		status: source.status,
		title: source.title ?? source.url,
		url: source.url,
		faviconUrl: source.faviconUrl,
		citationNote: source.citationNote,
		reviewedNote: source.reviewedNote,
		rejectedReason: source.rejectedReason,
		topicRelevant: source.topicRelevant,
		topicRelevanceReason: source.topicRelevanceReason,
		reviewedAt: source.reviewedAt,
		citedAt: source.citedAt,
	};
}

function sourceIdsFromVerifiedClaims(
	claims: DeepResearchSynthesisClaim[],
	evidenceNotes: DeepResearchEvidenceNote[],
): string[] {
	const evidenceById = new Map(evidenceNotes.map((note) => [note.id, note]));
	return uniqueValues(
		claims
			.filter(
				(claim) => claim.status === "accepted" || claim.status === "limited",
			)
			.flatMap((claim) =>
				claim.evidenceLinks
					.filter(
						(link) =>
							link.relation === "support" || link.relation === "qualification",
					)
					.flatMap((link) => {
						const evidence = evidenceById.get(link.evidenceNoteId);
						if (!evidence) return [];
						return [
							evidence.sourceId,
							evidence.sourceSupport.sourceId,
							evidence.sourceSupport.reviewedSourceId,
							...(Array.isArray(evidence.sourceSupport.sourceIds)
								? evidence.sourceSupport.sourceIds
								: []),
						].filter(
							(value): value is string =>
								typeof value === "string" && value.length > 0,
						);
					}),
			),
	);
}

function filterSynthesisClaimsForReportableVerdicts(input: {
	claims: DeepResearchSynthesisClaim[];
	auditResult: NonNullable<
		Awaited<ReturnType<typeof auditAndPersistDeepResearchClaimGraph>>
	>;
}): DeepResearchSynthesisClaim[] {
	const verdictByClaimId = new Map(
		input.auditResult.verdicts.map((verdict) => [verdict.claimId, verdict]),
	);
	return input.claims.flatMap((claim) => {
		const verdict = verdictByClaimId.get(claim.id);
		if (
			!verdict ||
			(verdict.verdict !== "supported" &&
				verdict.verdict !== "partially_supported")
		) {
			return [];
		}
		const allowedEvidenceNoteIds = new Set(verdict.evidenceNoteIds);
		const evidenceLinks = claim.evidenceLinks.filter((link) => {
			if (link.relation !== "support" && link.relation !== "qualification") {
				return false;
			}
			return (
				allowedEvidenceNoteIds.size === 0 ||
				allowedEvidenceNoteIds.has(link.evidenceNoteId)
			);
		});
		if (evidenceLinks.length === 0) return [];
		return [
			{
				...claim,
				status:
					verdict.verdict === "partially_supported" ? "limited" : "accepted",
				statusReason:
					verdict.verdict === "partially_supported"
						? verdict.reason
						: claim.statusReason,
				evidenceLinks,
			},
		];
	});
}

function claimGraphReportLimitations(
	auditResult: NonNullable<
		Awaited<ReturnType<typeof auditAndPersistDeepResearchClaimGraph>>
	>,
): string[] {
	const failedVerdicts = auditResult.verdicts.filter(
		(verdict) =>
			verdict.verdict !== "supported" &&
			verdict.verdict !== "partially_supported",
	);
	if (failedVerdicts.length === 0) return [];
	return [
		`Removed ${failedVerdicts.length} unsupported or unresolved claim${failedVerdicts.length === 1 ? "" : "s"} after citation audit; retained supported and partially supported claims only.`,
		...failedVerdicts
			.slice(0, 8)
			.map(
				(verdict) =>
					`Removed claim ${verdict.claimId} after citation audit (${verdict.verdict}): ${verdict.reason}`,
			),
	];
}

function buildCitationAuditReportDraft(
	reportDraft: ResearchReportDraft,
	synthesisNotes: SynthesisNotes,
): DeepResearchReportDraft {
	if (
		reportDraft.structuredReport.core.keyFindings.some(
			(finding) => finding.claimIds.length > 0,
		)
	) {
		return {
			title: reportDraft.title,
			sections: reportDraft.structuredReport.sections.map((section) => ({
				heading: section.heading,
				claims: reportDraft.structuredReport.core.keyFindings
					.filter((finding) =>
						finding.claimIds.some((claimId) =>
							section.claimIds.includes(claimId),
						),
					)
					.map((finding) => ({
						id: finding.claimIds[0] ?? randomUUID(),
						text: finding.text,
						core: true,
						citationSourceIds: uniqueValues(finding.sourceIds),
					})),
			})),
			limitations: reportDraft.limitations,
		};
	}
	const visibleFindings = selectResearchReportFindings(synthesisNotes);
	return {
		title: reportDraft.title,
		sections: [
			{
				heading: "Key Findings",
				claims: visibleFindings.map((finding, index) => ({
					id: `finding-${index + 1}`,
					text: finding.statement,
					core: finding.central !== false,
					claimType: finding.claimType,
					citationSourceIds: uniqueValues(
						finding.sourceRefs.flatMap((sourceRef) => [
							sourceRef.discoveredSourceId,
							sourceRef.reviewedSourceId,
						]),
					),
				})),
			},
		],
		limitations: reportDraft.limitations,
	};
}

function sourceCountsFromSources(
	sources: DeepResearchSource[],
): DeepResearchSourceCounts {
	return {
		discovered: sources.length,
		reviewed: sources.filter((source) => source.reviewedAt).length,
		cited: sources.filter((source) => source.citedAt).length,
	};
}

function citationAuditWarnings(
	auditResult: Awaited<ReturnType<typeof auditDeepResearchReportCitations>>,
): string[] {
	if (auditResult.limitations.length > 0)
		return auditResult.limitations.slice(0, 6);
	if (!auditResult.canComplete) {
		return [
			"No reviewed cited source supported the core claims strongly enough to publish a report.",
		];
	}
	return [];
}

function claimGraphAuditWarnings(
	auditResult: NonNullable<
		Awaited<ReturnType<typeof auditAndPersistDeepResearchClaimGraph>>
	>,
): string[] {
	const warnings = auditResult.verdicts
		.filter((verdict) => verdict.verdict !== "supported")
		.map(
			(verdict) =>
				`Claim ${verdict.claimId} audit verdict ${verdict.verdict}: ${verdict.reason}`,
		);
	if (warnings.length > 0) return warnings;
	if (!auditResult.canRenderMarkdown) {
		return [
			"Claim graph verification did not find enough supported Synthesis Claims to render Markdown.",
		];
	}
	return [];
}

function uniqueValues<T>(values: T[]): T[] {
	return [...new Set(values)];
}

function buildReportArtifactName(
	jobTitle: string,
	researchLanguage: ResearchLanguage = "en",
): string {
	const safeTitle = jobTitle
		.replace(/[\\/:*?"<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 96);
	const prefix =
		researchLanguage === "hu" ? "Kutatási jelentés" : "Research Report";
	return `${prefix} - ${safeTitle || "Deep Research"}.md`;
}

function buildEvidenceLimitationMemoArtifactName(
	jobTitle: string,
	researchLanguage: ResearchLanguage = "en",
): string {
	const safeTitle = jobTitle
		.replace(/[\\/:*?"<>|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 96);
	const prefix =
		researchLanguage === "hu"
			? "Bizonyítékkorlát-memó"
			: "Evidence Limitation Memo";
	return `${prefix} - ${safeTitle || "Deep Research"}.md`;
}

function buildEvidenceLimitationReviewedScope(input: {
	plan: DeepResearchPlanRaw;
	sources: DeepResearchSource[];
}) {
	let topicRelevantCount = 0;
	let rejectedOrOffTopicCount = 0;

	for (const source of input.sources) {
		if (source.rejectedReason) {
			rejectedOrOffTopicCount += 1;
			continue;
		}
		if (!source.reviewedAt) continue;
		const topicRelevant = isSourceTopicRelevantToPlan({
			planGoal: input.plan.goal,
			keyQuestions: input.plan.keyQuestions,
			source: {
				title: source.title ?? source.url,
				snippet: source.snippet,
				sourceText: [
					source.sourceText,
					source.reviewedNote,
					...(source.extractedClaims ?? []),
				]
					.filter(Boolean)
					.join(" "),
			},
		});
		if (topicRelevant) {
			topicRelevantCount += 1;
		} else {
			rejectedOrOffTopicCount += 1;
		}
	}

	return {
		discoveredCount: input.sources.length,
		reviewedCount: input.sources.filter((source) => Boolean(source.reviewedAt))
			.length,
		topicRelevantCount,
		rejectedOrOffTopicCount,
	};
}

function buildEvidenceLimitationNextResearchDirection(input: {
	limitations: string[];
	researchLanguage: ResearchLanguage;
}): string {
	const primaryLimitation = input.limitations
		.map((value) => value.trim())
		.find(Boolean);
	if (input.researchLanguage === "hu") {
		return primaryLimitation
			? `Következőként ezt a korlátot kezeld célzott tervmódosítással vagy erősebb forrásokkal: ${primaryLimitation}`
			: "Módosítsd a kutatási tervet, vagy adj hozzá erősebb, témához illeszkedő forrásokat az új futás előtt.";
	}
	return primaryLimitation
		? `Address this limitation with a targeted plan revision or stronger sources before requesting a report: ${primaryLimitation}`
		: "Revise the Research Plan or add stronger topic-relevant sources before starting a new run.";
}

async function loadCurrentPlansByJobId(
	jobIds: string[],
): Promise<Map<string, DeepResearchPlanSummary>> {
	if (jobIds.length === 0) return new Map();

	const rows = await db
		.select()
		.from(deepResearchPlanVersions)
		.where(inArray(deepResearchPlanVersions.jobId, jobIds))
		.orderBy(
			asc(deepResearchPlanVersions.jobId),
			desc(deepResearchPlanVersions.version),
		);

	const plans = new Map<string, DeepResearchPlanSummary>();
	for (const row of rows) {
		if (!plans.has(row.jobId)) {
			plans.set(row.jobId, mapResearchPlanVersionRow(row));
		}
	}
	return plans;
}

async function loadTimelineEventsByJobId(
	userId: string,
	jobIds: string[],
): Promise<Map<string, DeepResearchTimelineEvent[]>> {
	const events = await listResearchTimelineEventsForJobs({ userId, jobIds });
	const timelineByJobId = new Map<string, DeepResearchTimelineEvent[]>();
	for (const event of events) {
		const mapped = mapTimelineEvent(event);
		timelineByJobId.set(event.jobId, [
			...(timelineByJobId.get(event.jobId) ?? []),
			mapped,
		]);
	}
	return timelineByJobId;
}

type SourceLedgerForCard = {
	sourceCounts: DeepResearchJob["sourceCounts"];
	sources: DeepResearchSource[];
};

type DeepResearchJobReadModel = {
	usageSummary?: DeepResearchUsageSummary;
	runtimeEstimate?: DeepResearchRuntimeEstimate;
	evidenceLimitationMemo?: DeepResearchEvidenceLimitationMemo | null;
	passCheckpoints?: DeepResearchPassCheckpoint[];
	coverageGaps?: DeepResearchCoverageGap[];
	evidenceNotes?: DeepResearchEvidenceNote[];
	synthesisClaims?: DeepResearchSynthesisClaim[];
	resumePoints?: DeepResearchResumePoint[];
};

type DeepResearchPassStateForCard = {
	passCheckpoints: DeepResearchPassCheckpoint[];
	coverageGaps: DeepResearchCoverageGap[];
	evidenceNotes: DeepResearchEvidenceNote[];
	synthesisClaims: DeepResearchSynthesisClaim[];
	resumePoints: DeepResearchResumePoint[];
};

async function loadPassStatesByJobId(
	userId: string,
	jobIds: string[],
): Promise<Map<string, DeepResearchPassStateForCard>> {
	const states = new Map<string, DeepResearchPassStateForCard>();
	await Promise.all(
		jobIds.map(async (jobId) => {
			const [
				passCheckpoints,
				coverageGaps,
				evidenceNotes,
				synthesisClaims,
				resumePoints,
			] = await Promise.all([
				listResearchPassCheckpoints({ userId, jobId }),
				listResearchCoverageGaps({ userId, jobId }),
				listDeepResearchEvidenceNotes({ userId, jobId }),
				listDeepResearchSynthesisClaims({ userId, jobId }),
				listResearchResumePoints({ userId, jobId }),
			]);
			states.set(jobId, {
				passCheckpoints,
				coverageGaps,
				evidenceNotes,
				synthesisClaims,
				resumePoints,
			});
		}),
	);
	return states;
}

async function loadUsageSummariesByJobId(
	userId: string,
	jobIds: string[],
): Promise<Map<string, DeepResearchUsageSummary>> {
	const summaries = new Map<string, DeepResearchUsageSummary>();
	await Promise.all(
		jobIds.map(async (jobId) => {
			const summary = await getResearchUsageCostSummary({ userId, jobId });
			summaries.set(jobId, {
				totalCostUsdMicros: summary.totalCostUsdMicros,
				totalTokens: summary.totalTokens,
				byModel: summary.byModel,
			});
		}),
	);
	return summaries;
}

async function loadRuntimeEstimatesByJobId(
	rows: DeepResearchJobRow[],
): Promise<Map<string, DeepResearchRuntimeEstimate>> {
	const estimates = new Map<string, DeepResearchRuntimeEstimate>();
	const calibrated = await loadCalibratedRuntimeStats(rows);
	for (const row of rows) {
		const actualRuntimeMs =
			row.completedAt && row.createdAt
				? Math.max(0, row.completedAt.getTime() - row.createdAt.getTime())
				: undefined;
		const calibratedLabel = calibrated.get(row.depth);
		estimates.set(row.id, {
			label: actualRuntimeMs
				? formatRuntimeRange(actualRuntimeMs, actualRuntimeMs)
				: (calibratedLabel ??
					fallbackRuntimeEstimate(row.depth as DeepResearchDepth)),
			source: calibratedLabel ? "calibrated" : "fallback",
			...(actualRuntimeMs !== undefined ? { actualRuntimeMs } : {}),
		});
	}
	return estimates;
}

async function loadEvidenceLimitationMemosByJobId(
	userId: string,
	rows: DeepResearchJobRow[],
): Promise<Map<string, DeepResearchEvidenceLimitationMemo>> {
	const memoRows = rows.filter(
		(row) =>
			row.stage === "evidence_limitation_memo_ready" && row.reportArtifactId,
	);
	if (memoRows.length === 0) return new Map();

	const artifactIds = memoRows
		.map((row) => row.reportArtifactId)
		.filter((id): id is string => Boolean(id));
	const artifactRows = await db
		.select({
			id: artifacts.id,
			metadataJson: artifacts.metadataJson,
		})
		.from(artifacts)
		.where(
			and(eq(artifacts.userId, userId), inArray(artifacts.id, artifactIds)),
		);
	const memoByArtifactId = new Map(
		artifactRows
			.map(
				(row) =>
					[
						row.id,
						parseEvidenceLimitationMemoMetadata(row.metadataJson),
					] as const,
			)
			.filter(
				(
					entry,
				): entry is readonly [string, DeepResearchEvidenceLimitationMemo] =>
					Boolean(entry[1]),
			),
	);
	const memoByJobId = new Map<string, DeepResearchEvidenceLimitationMemo>();
	for (const row of memoRows) {
		const memo = row.reportArtifactId
			? memoByArtifactId.get(row.reportArtifactId)
			: null;
		if (memo) memoByJobId.set(row.id, memo);
	}
	return memoByJobId;
}

function parseEvidenceLimitationMemoMetadata(
	metadataJson: string | null,
): DeepResearchEvidenceLimitationMemo | null {
	if (!metadataJson) return null;
	let metadata: unknown;
	try {
		metadata = JSON.parse(metadataJson);
	} catch {
		return null;
	}
	if (!metadata || typeof metadata !== "object") return null;
	const record = metadata as Record<string, unknown>;
	if (record.deepResearchEvidenceLimitationMemo !== true) return null;
	const reviewedScope = record.reviewedScope;
	if (!reviewedScope || typeof reviewedScope !== "object") return null;
	const scopeRecord = reviewedScope as Record<string, unknown>;
	const recoveryActions = Array.isArray(record.memoRecoveryActions)
		? record.memoRecoveryActions.filter(isEvidenceLimitationMemoRecoveryAction)
		: [];
	return {
		title:
			readString(record.memoTitle) ??
			readString(record.documentLabel) ??
			"Evidence Limitation Memo",
		reviewedScope: {
			discoveredCount: readNumber(scopeRecord.discoveredCount),
			reviewedCount: readNumber(scopeRecord.reviewedCount),
			topicRelevantCount: readNumber(scopeRecord.topicRelevantCount),
			rejectedOrOffTopicCount: readNumber(scopeRecord.rejectedOrOffTopicCount),
		},
		limitations: readStringArray(record.groundedLimitationReasons),
		nextResearchDirection: readString(record.nextResearchDirection) ?? "",
		recoveryActions,
	};
}

function isEvidenceLimitationMemoRecoveryAction(
	value: unknown,
): value is DeepResearchEvidenceLimitationMemo["recoveryActions"][number] {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.kind === "string" &&
		typeof record.label === "string" &&
		typeof record.description === "string"
	);
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function readNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function readStringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter(
				(item): item is string =>
					typeof item === "string" && item.trim().length > 0,
			)
		: [];
}

async function loadCalibratedRuntimeStats(
	rows: DeepResearchJobRow[],
): Promise<Map<string, string>> {
	const depths = [...new Set(rows.map((row) => row.depth))];
	const estimates = new Map<string, string>();
	for (const depth of depths) {
		const completedRows = await db
			.select({
				createdAt: deepResearchJobs.createdAt,
				completedAt: deepResearchJobs.completedAt,
			})
			.from(deepResearchJobs)
			.where(
				and(
					eq(deepResearchJobs.depth, depth),
					eq(deepResearchJobs.status, "completed"),
					sql`${deepResearchJobs.completedAt} IS NOT NULL`,
				),
			)
			.orderBy(desc(deepResearchJobs.completedAt))
			.limit(50);
		const runtimes = completedRows
			.map((row) =>
				row.completedAt
					? row.completedAt.getTime() - row.createdAt.getTime()
					: 0,
			)
			.filter((runtime) => runtime > 0)
			.sort((a, b) => a - b);
		if (runtimes.length < 5) continue;
		estimates.set(
			depth,
			formatRuntimeRange(percentile(runtimes, 0.5), percentile(runtimes, 0.9)),
		);
	}
	return estimates;
}

function fallbackRuntimeEstimate(depth: DeepResearchDepth | string): string {
	if (depth === "focused") return "30-90 sec";
	if (depth === "max") return "4-12 min";
	return "1-4 min";
}

function percentile(values: number[], p: number): number {
	if (values.length === 0) return 0;
	const index = Math.min(
		values.length - 1,
		Math.max(0, Math.ceil(values.length * p) - 1),
	);
	return values[index];
}

function formatRuntimeRange(lowMs: number, highMs: number): string {
	const low = formatRuntimeDuration(lowMs);
	const high = formatRuntimeDuration(highMs);
	return low === high ? low : `${low}-${high}`;
}

function formatRuntimeDuration(ms: number): string {
	const seconds = Math.max(1, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds} sec`;
	const minutes = Math.round(seconds / 60);
	return `${minutes} min`;
}

async function loadSourceLedgersByJobId(
	userId: string,
	conversationId: string,
	jobIds: string[],
): Promise<Map<string, SourceLedgerForCard>> {
	if (jobIds.length === 0) return new Map();

	const jobIdSet = new Set(jobIds);
	const snapshotLedgers = await loadCompletedSourceLedgerSnapshots(
		userId,
		jobIds,
	);
	const sources = (
		await listResearchSources({ userId, conversationId })
	).filter((source) => jobIdSet.has(source.jobId));
	const ledgers = new Map<string, SourceLedgerForCard>();
	for (const jobId of jobIds) {
		ledgers.set(
			jobId,
			snapshotLedgers.get(jobId) ?? {
				sourceCounts: { discovered: 0, reviewed: 0, cited: 0 },
				sources: [],
			},
		);
	}

	for (const source of sources) {
		if (snapshotLedgers.has(source.jobId)) continue;
		const ledger = ledgers.get(source.jobId);
		if (!ledger) continue;
		ledger.sourceCounts.discovered += source.discoveredAt ? 1 : 0;
		ledger.sourceCounts.reviewed += source.reviewedAt ? 1 : 0;
		ledger.sourceCounts.cited += source.citedAt ? 1 : 0;
		if (source.reviewedAt || source.citedAt || source.rejectedReason) {
			ledger.sources.push(mapSourceForCard(source));
		}
	}

	return ledgers;
}

async function loadCompletedSourceLedgerSnapshots(
	userId: string,
	jobIds: string[],
): Promise<Map<string, SourceLedgerForCard>> {
	const rows = await db
		.select({
			jobId: deepResearchJobs.id,
			conversationId: deepResearchJobs.conversationId,
			artifactId: artifacts.id,
			metadataJson: artifacts.metadataJson,
		})
		.from(deepResearchJobs)
		.innerJoin(artifacts, eq(deepResearchJobs.reportArtifactId, artifacts.id))
		.where(
			and(
				eq(deepResearchJobs.userId, userId),
				eq(deepResearchJobs.status, "completed"),
				inArray(deepResearchJobs.id, jobIds),
			),
		);
	const snapshots = new Map<string, SourceLedgerForCard>();
	for (const row of rows) {
		const snapshot = parseSourceLedgerSnapshotMetadata({
			metadataJson: row.metadataJson,
			jobId: row.jobId,
			conversationId: row.conversationId,
		});
		if (snapshot) snapshots.set(row.jobId, snapshot);
	}
	return snapshots;
}

function parseSourceLedgerSnapshotMetadata(input: {
	metadataJson: string | null;
	jobId: string;
	conversationId: string;
}): SourceLedgerForCard | null {
	if (!input.metadataJson) return null;
	let metadata: unknown;
	try {
		metadata = JSON.parse(input.metadataJson);
	} catch {
		return null;
	}
	if (!metadata || typeof metadata !== "object") return null;
	const snapshot = (metadata as Record<string, unknown>)
		.deepResearchSourceLedgerSnapshot;
	if (!snapshot || typeof snapshot !== "object") return null;
	const snapshotRecord = snapshot as Record<string, unknown>;
	const snapshotSources = Array.isArray(snapshotRecord.sources)
		? snapshotRecord.sources
		: [];
	const sources = snapshotSources
		.map((source) =>
			mapSnapshotSourceForCard({
				source,
				jobId: input.jobId,
				conversationId: input.conversationId,
			}),
		)
		.filter((source): source is DeepResearchSource => Boolean(source));
	if (sources.length === 0) return null;
	const sourceCounts = parseSnapshotSourceCounts(
		snapshotRecord.sourceCounts,
		sources,
	);
	return {
		sourceCounts,
		sources: sources.map(mapSourceForCard),
	};
}

function mapSnapshotSourceForCard(input: {
	source: unknown;
	jobId: string;
	conversationId: string;
}): DeepResearchSource | null {
	if (!input.source || typeof input.source !== "object") return null;
	const record = input.source as Record<string, unknown>;
	const id = readString(record.id);
	const url = readString(record.url);
	if (!id || !url) return null;
	const status = readString(record.status) as
		| DeepResearchSource["status"]
		| null;
	const now = new Date(0).toISOString();
	return {
		id,
		jobId: input.jobId,
		conversationId: input.conversationId,
		status:
			status === "reviewed" || status === "cited" || status === "discovered"
				? status
				: "reviewed",
		url,
		faviconUrl:
			readString(record.faviconUrl) ?? getResearchSourceFaviconUrl(url),
		title: readString(record.title) ?? url,
		provider: "snapshot",
		snippet: null,
		sourceText: null,
		reviewedNote: readString(record.reviewedNote),
		citationNote: readString(record.citationNote),
		relevanceScore: null,
		rejectedReason: readString(record.rejectedReason),
		topicRelevant:
			typeof record.topicRelevant === "boolean" ? record.topicRelevant : null,
		topicRelevanceReason: readString(record.topicRelevanceReason),
		supportedKeyQuestions: [],
		extractedClaims: [],
		sourceQualitySignals: null,
		sourceAuthoritySummary: null,
		openedContentLength: 0,
		discoveredAt: now,
		reviewedAt: readString(record.reviewedAt),
		citedAt: readString(record.citedAt),
		createdAt: now,
		updatedAt: now,
	};
}

function parseSnapshotSourceCounts(
	value: unknown,
	sources: DeepResearchSource[],
): DeepResearchSourceCounts {
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		return {
			discovered: readNumber(record.discovered),
			reviewed: readNumber(record.reviewed),
			cited: readNumber(record.cited),
		};
	}
	return {
		discovered: sources.length,
		reviewed: sources.filter(
			(source) =>
				source.status === "reviewed" ||
				source.status === "cited" ||
				source.reviewedAt,
		).length,
		cited: sources.filter(
			(source) => source.status === "cited" || source.citedAt,
		).length,
	};
}

async function saveResearchPlanDraft(
	draft: ResearchPlanDraftRecord,
	now: Date,
): Promise<
	ResearchPlanDraftRecord & { id: string; createdAt: number; updatedAt: number }
> {
	const [row] = await db
		.insert(deepResearchPlanVersions)
		.values({
			id: randomUUID(),
			jobId: draft.jobId,
			version: draft.version,
			status: draft.status,
			rawPlanJson: JSON.stringify(draft.rawPlan),
			renderedPlan: draft.renderedPlan,
			contextDisclosure: draft.contextDisclosure,
			effortEstimateJson: JSON.stringify(draft.effortEstimate),
			createdAt: now,
			updatedAt: now,
		})
		.returning();

	return {
		...draft,
		id: row.id,
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
	};
}

async function persistApprovedPlanSourceScope(input: {
	userId: string;
	conversationId: string;
	jobId: string;
	includedSources: ResearchPlanIncludedSource[];
	discoveredAt: Date;
}): Promise<void> {
	for (const source of input.includedSources) {
		await saveDiscoveredResearchSource({
			userId: input.userId,
			conversationId: input.conversationId,
			jobId: input.jobId,
			url: `artifact:${source.artifactId}`,
			title: source.title ?? null,
			provider: source.type,
			snippet: source.summary,
			discoveredAt: input.discoveredAt,
		});
	}
}

function mapResearchPlanVersionRow(
	row:
		| DeepResearchPlanVersionRow
		| (ResearchPlanDraftRecord & {
				id?: string;
				createdAt?: number;
				updatedAt?: number;
		  }),
): DeepResearchPlanSummary {
	if ("rawPlanJson" in row) {
		return {
			id: row.id,
			jobId: row.jobId,
			version: row.version,
			status: row.status as DeepResearchPlanSummary["status"],
			rawPlan: parseJson<DeepResearchPlanRaw>(row.rawPlanJson),
			renderedPlan: row.renderedPlan,
			contextDisclosure: row.contextDisclosure,
			effortEstimate: parseJson<DeepResearchEffortEstimate>(
				row.effortEstimateJson,
			),
			createdAt: row.createdAt.getTime(),
			updatedAt: row.updatedAt.getTime(),
		};
	}

	return {
		id: row.id,
		jobId: row.jobId,
		version: row.version,
		status: row.status,
		rawPlan: row.rawPlan as DeepResearchPlanRaw,
		renderedPlan: row.renderedPlan,
		contextDisclosure: row.contextDisclosure,
		effortEstimate: row.effortEstimate as DeepResearchEffortEstimate,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function parseJson<T>(value: string): T {
	return JSON.parse(value) as T;
}

function mapDeepResearchJob(
	row: DeepResearchJobRow,
	currentPlan: DeepResearchPlanSummary | null = null,
	timeline: DeepResearchTimelineEvent[] = [],
	sourceLedger: SourceLedgerForCard | undefined = undefined,
	readModel: DeepResearchJobReadModel = {},
): DeepResearchJob {
	return {
		id: row.id,
		conversationId: row.conversationId,
		triggerMessageId: row.triggerMessageId ?? null,
		depth: row.depth as DeepResearchDepth,
		status: row.status as DeepResearchJob["status"],
		stage: row.stage ?? null,
		title: row.title,
		userRequest: row.userRequest,
		reportArtifactId: row.reportArtifactId ?? null,
		plan: currentPlan,
		currentPlan,
		timeline,
		passCheckpoints: readModel.passCheckpoints ?? [],
		coverageGaps: readModel.coverageGaps ?? [],
		evidenceNotes: readModel.evidenceNotes ?? [],
		synthesisClaims: readModel.synthesisClaims ?? [],
		resumePoints: readModel.resumePoints ?? [],
		sourceCounts: sourceLedger?.sourceCounts ?? {
			discovered: 0,
			reviewed: 0,
			cited: 0,
		},
		sources: sourceLedger?.sources ?? [],
		evidenceLimitationMemo: readModel.evidenceLimitationMemo ?? null,
		usageSummary: readModel.usageSummary ?? {
			totalCostUsdMicros: 0,
			totalTokens: 0,
			byModel: [],
		},
		runtimeEstimate: readModel.runtimeEstimate ?? {
			label:
				row.completedAt && row.createdAt
					? formatRuntimeRange(
							row.completedAt.getTime() - row.createdAt.getTime(),
							row.completedAt.getTime() - row.createdAt.getTime(),
						)
					: fallbackRuntimeEstimate(row.depth),
			source: "fallback",
			...(row.completedAt
				? {
						actualRuntimeMs:
							row.completedAt.getTime() - row.createdAt.getTime(),
					}
				: {}),
		},
		createdAt: row.createdAt.getTime(),
		updatedAt: row.updatedAt.getTime(),
		completedAt: row.completedAt ? row.completedAt.getTime() : null,
		cancelledAt: row.cancelledAt ? row.cancelledAt.getTime() : null,
	};
}

function mapSourceForCard(source: DeepResearchSource): DeepResearchSource {
	return {
		id: source.id,
		jobId: source.jobId,
		conversationId: source.conversationId,
		status: source.status,
		url: source.url,
		faviconUrl: source.faviconUrl,
		title: source.title,
		provider: source.provider,
		snippet: source.snippet,
		sourceText: source.sourceText,
		reviewedNote: source.reviewedNote,
		citationNote: source.citationNote,
		relevanceScore: source.relevanceScore,
		rejectedReason: source.rejectedReason,
		topicRelevant: source.topicRelevant,
		topicRelevanceReason: source.topicRelevanceReason,
		supportedKeyQuestions: source.supportedKeyQuestions,
		extractedClaims: source.extractedClaims,
		sourceQualitySignals: source.sourceQualitySignals,
		sourceAuthoritySummary: source.sourceAuthoritySummary,
		openedContentLength: source.openedContentLength,
		discoveredAt: source.discoveredAt,
		reviewedAt: source.reviewedAt,
		citedAt: source.citedAt,
		createdAt: source.createdAt,
		updatedAt: source.updatedAt,
	};
}

async function countCompletedMeaningfulResearchPasses(input: {
	userId: string;
	jobId: string;
}): Promise<number> {
	const checkpoints = await listResearchPassCheckpoints(input);
	return checkpoints.filter(
		(checkpoint) =>
			checkpoint.terminalDecision &&
			!/\b(repair|citation audit)\b/i.test(checkpoint.searchIntent),
	).length;
}

function minimumMeaningfulPassExpectation(plan: DeepResearchPlanRaw): number {
	return Math.max(
		1,
		Math.floor(
			plan.researchBudget.meaningfulPassFloor ??
				plan.researchBudget.synthesisPassCeiling ??
				1,
		),
	);
}

function mapTimelineEvent(
	event: PersistedResearchTimelineEvent,
): DeepResearchTimelineEvent {
	return {
		id: event.id,
		jobId: event.jobId,
		conversationId: event.conversationId,
		taskId: event.taskId,
		stage: event.stage,
		kind: event.kind,
		occurredAt: event.occurredAt,
		messageKey: event.messageKey,
		messageParams: event.messageParams,
		sourceCounts: event.sourceCounts,
		assumptions: event.assumptions,
		warnings: event.warnings,
		summary: event.summary,
		createdAt: event.createdAt,
	};
}
