import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import {
	assignConversationToResearchProject,
	seedAdditionalConversation,
	seedDeepResearchConversation,
	completeApprovedJobWithAuditedReport as sharedCompleteApprovedJobWithAuditedReport,
	completeApprovedJobWithEvidenceLimitationMemo as sharedCompleteApprovedJobWithEvidenceLimitationMemo,
} from "./test-helpers";

let dbPath: string;

const completeApprovedJobWithAuditedReport =
	sharedCompleteApprovedJobWithAuditedReport;
const completeApprovedJobWithEvidenceLimitationMemo =
	sharedCompleteApprovedJobWithEvidenceLimitationMemo;

describe("deep research job shell service", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-deep-research-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedDeepResearchConversation({ dbPath });
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("creates and reloads a durable Deep Research Job with its first Research Plan", async () => {
		const { startDeepResearchJobShell, listConversationDeepResearchJobs } =
			await import("./index");
		const { countResearchSources } = await import("./sources");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
			planningContext: [
				{
					type: "conversation",
					title: "Earlier chat",
					summary: "The user cares about practical product compliance.",
				},
				{
					type: "knowledge",
					title: "Internal preference note",
					summary: "Prefer practical deployment risks over policy theory.",
				},
			],
		});
		const jobs = await listConversationDeepResearchJobs("user-1", "conv-1");
		const sourceCounts = await countResearchSources({
			userId: "user-1",
			jobId: created.id,
		});

		expect(created).toMatchObject({
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			depth: "standard",
			status: "awaiting_approval",
			stage: "plan_drafted",
			title: "Compare EU and US AI copyright training data rules",
			userRequest: "Compare EU and US AI copyright training data rules",
			currentPlan: {
				version: 1,
				status: "awaiting_approval",
				contextDisclosure:
					"Context considered: 1 conversation item, 1 knowledge item.",
				effortEstimate: {
					selectedDepth: "standard",
					sourceReviewCeiling: 75,
				},
			},
		});
		expect(created.currentPlan?.renderedPlan).not.toContain("# Research Plan");
		expect(created.currentPlan?.renderedPlan).toContain(
			"Goal: Compare EU and US AI copyright training data rules",
		);
		expect(created.currentPlan?.renderedPlan).toContain(
			"Context considered: 1 conversation item, 1 knowledge item.",
		);
		expect(created.currentPlan?.rawPlan.goal).toBe(
			"Compare EU and US AI copyright training data rules",
		);
		expect(jobs).toEqual([created]);
		expect(sourceCounts).toEqual({
			discovered: 0,
			reviewed: 0,
			cited: 0,
		});
	});

	it("starts a job without a foreign-key failure when the optional trigger message is stale", async () => {
		const { startDeepResearchJobShell } = await import("./index");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "missing-user-msg",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});

		expect(created).toMatchObject({
			conversationId: "conv-1",
			triggerMessageId: null,
			status: "awaiting_approval",
			stage: "plan_drafted",
		});
	});

	it("writes a plan-drafted Activity Timeline event when the first Research Plan is created", async () => {
		const { listConversationDeepResearchJobs, startDeepResearchJobShell } =
			await import("./index");
		const { listResearchTimelineEvents } = await import("./timeline");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		const events = await listResearchTimelineEvents({
			userId: "user-1",
			jobId: created.id,
		});
		const [reloaded] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);

		expect(events).toEqual([
			expect.objectContaining({
				jobId: created.id,
				conversationId: "conv-1",
				userId: "user-1",
				taskId: null,
				stage: "plan_generation",
				kind: "plan_generated",
				occurredAt: "2026-05-05T10:01:00.000Z",
				messageKey: "deepResearch.timeline.planGenerated",
				sourceCounts: {
					discovered: 0,
					reviewed: 0,
					cited: 0,
				},
				summary: "Research Plan drafted for approval.",
			}),
		]);
		expect(reloaded.timeline).toEqual([
			expect.objectContaining({
				id: events[0].id,
				jobId: created.id,
				conversationId: "conv-1",
				stage: "plan_generation",
				kind: "plan_generated",
				occurredAt: "2026-05-05T10:01:00.000Z",
				sourceCounts: {
					discovered: 0,
					reviewed: 0,
					cited: 0,
				},
				summary: "Research Plan drafted for approval.",
			}),
		]);
		expect("userId" in (reloaded.timeline?.[0] ?? {})).toBe(false);
	});

	it("reloads source ledger progress for the conversation detail Research Card", async () => {
		const { listConversationDeepResearchJobs, startDeepResearchJobShell } =
			await import("./index");
		const {
			markResearchSourceCited,
			markResearchSourceReviewed,
			saveDiscoveredResearchSource,
		} = await import("./sources");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://example.com/discovered-only",
			title: "Discovered only source",
			provider: "web_search",
			discoveredAt: new Date("2026-05-05T10:10:00.000Z"),
		});
		const reviewedSource = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://example.com/reviewed",
			title: "Reviewed source",
			provider: "web_search",
			discoveredAt: new Date("2026-05-05T10:11:00.000Z"),
		});
		await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: reviewedSource.id,
			reviewedAt: new Date("2026-05-05T10:20:00.000Z"),
			reviewedNote: "Relevant background source.",
		});
		const citedSource = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://example.com/cited",
			title: "Cited source",
			provider: "web_search",
			discoveredAt: new Date("2026-05-05T10:12:00.000Z"),
		});
		await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: citedSource.id,
			reviewedAt: new Date("2026-05-05T10:21:00.000Z"),
		});
		await markResearchSourceCited({
			userId: "user-1",
			sourceId: citedSource.id,
			citedAt: new Date("2026-05-05T10:30:00.000Z"),
			citationNote: "Supports a report claim.",
		});

		const [reloaded] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);

		expect(reloaded.sourceCounts).toEqual({
			discovered: 3,
			reviewed: 2,
			cited: 1,
		});
		expect(reloaded.sources).toEqual([
			expect.objectContaining({
				id: reviewedSource.id,
				status: "reviewed",
				title: "Reviewed source",
				url: "https://example.com/reviewed",
				reviewedNote: "Relevant background source.",
				citationNote: null,
			}),
			expect.objectContaining({
				id: citedSource.id,
				status: "cited",
				title: "Cited source",
				url: "https://example.com/cited",
				citationNote: "Supports a report claim.",
			}),
		]);
		expect(reloaded.sources?.map((source) => source.title)).not.toContain(
			"Discovered only source",
		);
		expect("userId" in (reloaded.sources?.[0] ?? {})).toBe(false);
	});

	it("defaults Research Language from the latest user request when job start has no explicit language", async () => {
		const { startDeepResearchJobShell } = await import("./index");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest:
				"Kérlek kutasd ki az AI kódoló asszisztensek beszerzési szempontjait.",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});

		expect(created.currentPlan?.rawPlan.researchLanguage).toBe("hu");
		expect(created.currentPlan?.renderedPlan).not.toContain("# Kutatási terv");
		expect(created.currentPlan?.renderedPlan).toContain(
			"Cél: Kérlek kutasd ki az AI kódoló asszisztensek beszerzési szempontjait.",
		);
	});

	it("writes plan-generation Research Usage when usage is available at job start", async () => {
		const { startDeepResearchJobShell } = await import("./index");
		const { listResearchUsageRecords } = await import("./usage");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
			planGenerationUsage: {
				modelId: "research-planner",
				modelDisplayName: "Research Planner",
				providerId: "internal",
				providerDisplayName: "Internal",
				runtimeMs: 234,
				providerUsage: {
					promptTokens: 900,
					completionTokens: 180,
					reasoningTokens: 40,
					source: "provider",
				},
				costUsdMicros: 12,
			},
		});
		const records = await listResearchUsageRecords({
			userId: "user-1",
			jobId: created.id,
		});

		expect(records).toEqual([
			expect.objectContaining({
				jobId: created.id,
				taskId: null,
				conversationId: "conv-1",
				userId: "user-1",
				stage: "plan_generation",
				operation: "plan_generation",
				modelId: "research-planner",
				modelDisplayName: "Research Planner",
				providerId: "internal",
				providerDisplayName: "Internal",
				billingMonth: "2026-05",
				occurredAt: "2026-05-05T10:01:00.000Z",
				promptTokens: 900,
				completionTokens: 180,
				reasoningTokens: 40,
				totalTokens: 1120,
				usageSource: "provider",
				runtimeMs: 234,
				costUsdMicros: 12,
			}),
		]);
		expect("messageId" in records[0]).toBe(false);
	});

	it("cancels an awaiting-plan Deep Research Job before approval", async () => {
		const {
			cancelPrePlanDeepResearchJob,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});

		const cancelled = await cancelPrePlanDeepResearchJob({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:02:00.000Z"),
		});
		const jobs = await listConversationDeepResearchJobs("user-1", "conv-1");

		expect(cancelled).toMatchObject({
			id: created.id,
			status: "cancelled",
			stage: "cancelled_before_approval",
			cancelledAt: new Date("2026-05-05T10:02:00.000Z").getTime(),
		});
		expect(jobs).toEqual([cancelled]);
	});

	it("rejects a new Deep Research Job while another job is active", async () => {
		const { startDeepResearchJobShell } = await import("./index");
		await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});

		await expect(
			startDeepResearchJobShell({
				userId: "user-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg-1",
				userRequest: "Start another research pass",
				depth: "focused",
				now: new Date("2026-05-05T10:02:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "active_job_exists",
			status: 409,
		});
	});

	it("allows active Deep Research Jobs in one conversation up to the configured conversation limit", async () => {
		const { db } = await import("$lib/server/db");
		const { refreshConfig } = await import("$lib/server/config-store");
		const { listConversationDeepResearchJobs, startDeepResearchJobShell } =
			await import("./index");
		const now = new Date("2026-05-05T10:00:00.000Z");
		await db.insert(schema.adminConfig).values([
			{
				key: "DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT",
				value: "2",
				updatedAt: now,
				updatedBy: "user-1",
			},
			{
				key: "DEEP_RESEARCH_ACTIVE_USER_LIMIT",
				value: "5",
				updatedAt: now,
				updatedBy: "user-1",
			},
			{
				key: "DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT",
				value: "10",
				updatedAt: now,
				updatedBy: "user-1",
			},
		]);
		await refreshConfig();

		await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Start another research pass",
			depth: "focused",
			now: new Date("2026-05-05T10:02:00.000Z"),
		});

		await expect(
			startDeepResearchJobShell({
				userId: "user-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg-1",
				userRequest: "Start one research pass too many",
				depth: "focused",
				now: new Date("2026-05-05T10:03:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "active_job_exists",
			status: 409,
		});

		const jobs = await listConversationDeepResearchJobs("user-1", "conv-1");
		expect(jobs).toHaveLength(2);
	});

	it("rejects a third active Deep Research Job for one user by default", async () => {
		await seedAdditionalConversation(dbPath, {
			conversationId: "conv-2",
			messageId: "user-msg-2",
		});
		await seedAdditionalConversation(dbPath, {
			conversationId: "conv-3",
			messageId: "user-msg-3",
		});
		const { startDeepResearchJobShell } = await import("./index");

		await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			userRequest: "Research EU AI Act enforcement signals",
			depth: "focused",
			now: new Date("2026-05-05T10:02:00.000Z"),
		});

		await expect(
			startDeepResearchJobShell({
				userId: "user-1",
				conversationId: "conv-3",
				triggerMessageId: "user-msg-3",
				userRequest: "Research US copyright office reports",
				depth: "focused",
				now: new Date("2026-05-05T10:03:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "active_user_limit_exceeded",
			status: 429,
		});
	});

	it("rejects a Deep Research Job in a sealed conversation", async () => {
		const { db } = await import("$lib/server/db");
		const { startDeepResearchJobShell } = await import("./index");
		await db
			.update(schema.conversations)
			.set({
				status: "sealed",
				sealedAt: new Date("2026-05-05T10:00:30.000Z"),
			})
			.where(eq(schema.conversations.id, "conv-1"));

		await expect(
			startDeepResearchJobShell({
				userId: "user-1",
				conversationId: "conv-1",
				triggerMessageId: "user-msg-1",
				userRequest: "Research in a sealed conversation",
				depth: "standard",
				now: new Date("2026-05-05T10:01:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "conversation_sealed",
			status: 409,
		});
	});

	it("cancels an awaiting-approval Deep Research Job before approval", async () => {
		const { db } = await import("$lib/server/db");
		const {
			cancelPrePlanDeepResearchJob,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await db
			.update(schema.deepResearchJobs)
			.set({ status: "awaiting_approval", stage: "plan_drafted" })
			.where(eq(schema.deepResearchJobs.id, created.id));

		const cancelled = await cancelPrePlanDeepResearchJob({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:03:00.000Z"),
		});
		const jobs = await listConversationDeepResearchJobs("user-1", "conv-1");

		expect(cancelled).toMatchObject({
			id: created.id,
			status: "cancelled",
			stage: "cancelled_before_approval",
			cancelledAt: new Date("2026-05-05T10:03:00.000Z").getTime(),
		});
		expect(jobs).toEqual([cancelled]);
	});

	it("does not cancel a running Deep Research Job through the pre-plan cancellation path", async () => {
		const { db } = await import("$lib/server/db");
		const {
			cancelPrePlanDeepResearchJob,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await db
			.update(schema.deepResearchJobs)
			.set({ status: "running", stage: "source_discovery" })
			.where(eq(schema.deepResearchJobs.id, created.id));

		const cancelled = await cancelPrePlanDeepResearchJob({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:03:00.000Z"),
		});
		const [job] = await listConversationDeepResearchJobs("user-1", "conv-1");

		expect(cancelled).toBeNull();
		expect(job).toMatchObject({
			id: created.id,
			status: "running",
			stage: "source_discovery",
			cancelledAt: null,
		});
	});

	it("allows a later Deep Research Job after the previous job was cancelled", async () => {
		const { cancelPrePlanDeepResearchJob, startDeepResearchJobShell } =
			await import("./index");
		const firstJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await cancelPrePlanDeepResearchJob({
			userId: "user-1",
			jobId: firstJob.id,
			now: new Date("2026-05-05T10:02:00.000Z"),
		});

		const nextJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Research follow-up sources",
			depth: "focused",
			now: new Date("2026-05-05T10:04:00.000Z"),
		});

		expect(nextJob).toMatchObject({
			status: "awaiting_approval",
			depth: "focused",
			userRequest: "Research follow-up sources",
		});
		expect(nextJob.id).not.toBe(firstJob.id);
	});

	it("allows a later Deep Research Job after the previous job failed", async () => {
		const { db } = await import("$lib/server/db");
		const { startDeepResearchJobShell } = await import("./index");
		const firstJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await db
			.update(schema.deepResearchJobs)
			.set({
				status: "failed",
				stage: "failed_before_research",
				updatedAt: new Date("2026-05-05T10:02:00.000Z"),
			})
			.where(eq(schema.deepResearchJobs.id, firstJob.id));

		const nextJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Try research again",
			depth: "focused",
			now: new Date("2026-05-05T10:04:00.000Z"),
		});

		expect(nextJob).toMatchObject({
			status: "awaiting_approval",
			depth: "focused",
			userRequest: "Try research again",
		});
		expect(nextJob.id).not.toBe(firstJob.id);
	});

	it("applies a freeform Plan Edit as version 2 without starting source-heavy research", async () => {
		const {
			editDeepResearchPlan,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});

		const edited = await editDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			editInstruction:
				"Focus more on practical startup compliance risks and exclude policy blogs.",
			reportIntent: "recommendation",
			now: new Date("2026-05-05T10:05:00.000Z"),
		});
		if (!edited) {
			throw new Error("Expected edited Research Plan");
		}
		const [reloaded] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);

		expect(edited).toMatchObject({
			id: created.id,
			status: "awaiting_approval",
			stage: "plan_revised",
			currentPlan: {
				version: 2,
				status: "awaiting_approval",
				rawPlan: {
					reportIntent: "recommendation",
				},
			},
		});
		expect(edited.currentPlan?.renderedPlan).toContain(
			"Report intent: Recommendation",
		);
		expect(edited.currentPlan?.renderedPlan).toContain(
			"Focus more on practical startup compliance risks and exclude policy blogs.",
		);
		expect(reloaded).toEqual(edited);
		expect(reloaded.status).not.toBe("running");
	});

	it("approves the current Research Plan and transitions the job into an approved runnable state", async () => {
		const {
			approveDeepResearchPlan,
			editDeepResearchPlan,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await editDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			editInstruction: "Focus more on practical startup compliance risks.",
			now: new Date("2026-05-05T10:05:00.000Z"),
		});

		const approved = await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		const [reloaded] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);

		expect(approved).toMatchObject({
			id: created.id,
			status: "approved",
			stage: "plan_approved",
			currentPlan: {
				version: 2,
				status: "approved",
			},
			updatedAt: new Date("2026-05-05T10:06:00.000Z").getTime(),
		});
		expect(reloaded).toEqual(approved);
	});

	it("adds attached files disclosed in the approved source scope to the Research Source ledger", async () => {
		const { approveDeepResearchPlan, startDeepResearchJobShell } = await import(
			"./index"
		);
		const { countResearchSources, listResearchSources } = await import(
			"./sources"
		);
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest:
				"Compare EU and US AI copyright training data rules using my uploaded memo.",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
			planningContext: [
				{
					type: "attachment",
					artifactId: "artifact-upload-1",
					title: "Uploaded copyright memo.pdf",
					summary: "Internal memo with notes on AI training data disputes.",
				},
			],
		});
		const sourceScope = created.currentPlan?.rawPlan?.sourceScope as {
			includedSources?: Array<Record<string, unknown>>;
		};

		expect(sourceScope.includedSources).toEqual([
			{
				type: "attached_file",
				artifactId: "artifact-upload-1",
				title: "Uploaded copyright memo.pdf",
				summary: "Internal memo with notes on AI training data disputes.",
			},
		]);

		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		const sources = await listResearchSources({
			userId: "user-1",
			jobId: created.id,
		});
		const counts = await countResearchSources({
			userId: "user-1",
			jobId: created.id,
		});

		expect(counts).toEqual({
			discovered: 1,
			reviewed: 0,
			cited: 0,
		});
		expect(sources).toEqual([
			expect.objectContaining({
				jobId: created.id,
				conversationId: "conv-1",
				status: "discovered",
				url: "artifact:artifact-upload-1",
				title: "Uploaded copyright memo.pdf",
				provider: "attached_file",
				snippet: "Internal memo with notes on AI training data disputes.",
			}),
		]);
	});

	it("does not add knowledge context as a Research Source unless the approved plan source scope includes it", async () => {
		const { db } = await import("$lib/server/db");
		const { approveDeepResearchPlan, startDeepResearchJobShell } = await import(
			"./index"
		);
		const { countResearchSources, listResearchSources } = await import(
			"./sources"
		);
		const now = new Date("2026-05-05T10:00:00.000Z");
		await db.insert(schema.conversations).values({
			id: "conv-2",
			userId: "user-1",
			title: "Second research conversation",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.messages).values({
			id: "user-msg-2",
			conversationId: "conv-2",
			role: "user",
			content: "Research using approved knowledge source scope",
			createdAt: now,
		});

		const contextOnlyJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules.",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
			planningContext: [
				{
					type: "knowledge",
					artifactId: "artifact-knowledge-context",
					title: "Knowledge profile note",
					summary: "The user prefers concise compliance summaries.",
				},
			],
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: contextOnlyJob.id,
			now: new Date("2026-05-05T10:02:00.000Z"),
		});

		const explicitlyScopedJob = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-2",
			triggerMessageId: "user-msg-2",
			userRequest: "Research using the selected library source.",
			depth: "focused",
			now: new Date("2026-05-05T10:03:00.000Z"),
			planningContext: [
				{
					type: "knowledge",
					artifactId: "artifact-knowledge-source",
					title: "Library source brief",
					summary:
						"A user-selected library item approved as evidence for this research.",
					includeAsResearchSource: true,
				},
			],
		});

		expect(
			explicitlyScopedJob.currentPlan?.rawPlan?.sourceScope.includedSources,
		).toEqual([
			{
				type: "knowledge_artifact",
				artifactId: "artifact-knowledge-source",
				title: "Library source brief",
				summary:
					"A user-selected library item approved as evidence for this research.",
			},
		]);

		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: explicitlyScopedJob.id,
			now: new Date("2026-05-05T10:04:00.000Z"),
		});
		const contextOnlyCounts = await countResearchSources({
			userId: "user-1",
			jobId: contextOnlyJob.id,
		});
		const explicitlyScopedSources = await listResearchSources({
			userId: "user-1",
			jobId: explicitlyScopedJob.id,
		});

		expect(contextOnlyCounts).toEqual({
			discovered: 0,
			reviewed: 0,
			cited: 0,
		});
		expect(explicitlyScopedSources).toEqual([
			expect.objectContaining({
				jobId: explicitlyScopedJob.id,
				conversationId: "conv-2",
				status: "discovered",
				url: "artifact:artifact-knowledge-source",
				title: "Library source brief",
				provider: "knowledge_artifact",
				snippet:
					"A user-selected library item approved as evidence for this research.",
			}),
		]);
	});

	it("rejects Plan Edits after the Research Plan is approved", async () => {
		const {
			approveDeepResearchPlan,
			editDeepResearchPlan,
			startDeepResearchJobShell,
		} = await import("./index");
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});

		await expect(
			editDeepResearchPlan({
				userId: "user-1",
				jobId: created.id,
				editInstruction: "Now add a new scope after approval.",
				now: new Date("2026-05-05T10:07:00.000Z"),
			}),
		).rejects.toMatchObject({
			code: "plan_already_approved",
			status: 409,
		});
	});

	it("treats repeated Research Plan approval as idempotent", async () => {
		const { approveDeepResearchPlan, startDeepResearchJobShell } = await import(
			"./index"
		);
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		const firstApproval = await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});

		const secondApproval = await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:07:00.000Z"),
		});

		expect(secondApproval).toEqual(firstApproval);
	});

	it("approves a corrected plan revision on the same completed job with clean execution state", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithPlanRevisionNeeded,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDiscoveredResearchSource, listResearchSources } = await import(
			"./sources"
		);
		const {
			listResearchCoverageGaps,
			saveCoverageGapsForPass,
			upsertResearchPassCheckpoint,
		} = await import("./pass-state");
		const { createResearchTasksFromCoverageGaps, listResearchTasks } =
			await import("./tasks");
		const userRequest =
			"What is the most reliable architecture for building an enterprise deep research assistant in 2026? Compare at least three architecture patterns, identify failure modes, recommend one design, and include an implementation roadmap.";
		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest,
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		const firstApproval = await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		const diagnosticSource = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://vehicles.example.test/off-topic",
			title: "Off-topic vehicle listing",
			provider: "public_web",
			snippet: "Dealer listing kept as diagnostic history.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 2,
			searchIntent: "Poisoned follow-up coverage",
			reviewedSourceIds: [diagnosticSource.id],
			now: new Date("2026-05-05T10:08:00.000Z"),
		});
		const [gap] = await saveCoverageGapsForPass({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			gaps: [
				{
					keyQuestion: "Which manufacturers and trim differences matter most?",
					reason: "Poisoned product question from the bad plan.",
					reviewedSourceCount: 75,
					severity: "critical",
					recommendedNextAction:
						"Review additional vehicle listing sources for the bad plan.",
				},
			],
			now: new Date("2026-05-05T10:08:30.000Z"),
		});
		await createResearchTasksFromCoverageGaps({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 2,
			gaps: [
				{
					id: gap.id,
					keyQuestion: gap.keyQuestion,
					summary: gap.recommendedNextAction,
					severity: gap.severity,
				},
			],
			now: new Date("2026-05-05T10:09:00.000Z"),
		});

		const revisionNeeded = await completeDeepResearchJobWithPlanRevisionNeeded({
			userId: "user-1",
			jobId: created.id,
			reason:
				"The Research Plan appears to have framed the request incorrectly.",
			signals: [
				"Abstract architecture recommendation was treated as a strict entity comparison.",
			],
			sourceCounts: {
				discovered: 75,
				reviewed: 75,
				cited: 0,
			},
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const approvedCorrected = await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:25:00.000Z"),
		});
		const sources = await listResearchSources({
			userId: "user-1",
			jobId: created.id,
		});
		const tasks = await listResearchTasks({
			userId: "user-1",
			jobId: created.id,
		});
		const gaps = await listResearchCoverageGaps({
			userId: "user-1",
			jobId: created.id,
		});

		expect(revisionNeeded).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "plan_revision_needed",
			reportArtifactId: null,
			currentPlan: {
				version: (firstApproval?.currentPlan?.version ?? 1) + 1,
				status: "awaiting_approval",
			},
		});
		expect(approvedCorrected).toMatchObject({
			id: created.id,
			status: "approved",
			stage: "plan_approved",
			reportArtifactId: null,
			completedAt: null,
			currentPlan: {
				version: revisionNeeded?.currentPlan?.version,
				status: "approved",
				rawPlan: {
					reportIntent: "recommendation",
				},
			},
		});
		expect(
			approvedCorrected?.currentPlan?.rawPlan?.comparedEntities,
		).toBeUndefined();
		expect(sources).toEqual([
			expect.objectContaining({
				id: diagnosticSource.id,
				jobId: created.id,
				url: "https://vehicles.example.test/off-topic",
			}),
		]);
		expect(tasks).toEqual([
			expect.objectContaining({
				coverageGapId: gap.id,
				passNumber: expect.any(Number),
				status: "cancelled",
				failureReason:
					"Retired because a corrected Research Plan was approved for the same job.",
			}),
		]);
		expect(tasks[0].passNumber).toBeLessThan(0);
		expect(gaps).toEqual([
			expect.objectContaining({
				id: gap.id,
				lifecycleState: "resolved",
				resolutionSummary:
					"Retired because a corrected Research Plan was approved for the same job.",
			}),
		]);
	});

	it("does not expose the legacy fake report completion path", async () => {
		const deepResearchService = await import("./index");

		expect(deepResearchService).not.toHaveProperty(
			"completeDeepResearchJobWithFakeReport",
		);
	});

	it("starts a new Normal Chat from a completed Research Report without reopening the sealed conversation", async () => {
		const { db } = await import("$lib/server/db");
		const { discussDeepResearchReport } = await import("./index");
		const { created, completed } = await completeApprovedJobWithAuditedReport();
		await assignConversationToResearchProject(dbPath);

		const action = await discussDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:25:00.000Z"),
		});
		const [sourceConversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));
		const [seedMessage] = await db
			.select({
				role: schema.messages.role,
				content: schema.messages.content,
				metadataJson: schema.messages.metadataJson,
			})
			.from(schema.messages)
			.where(eq(schema.messages.conversationId, action?.conversation.id ?? ""));
		const links = await db
			.select({
				artifactId: schema.artifactLinks.artifactId,
				conversationId: schema.artifactLinks.conversationId,
				messageId: schema.artifactLinks.messageId,
				linkType: schema.artifactLinks.linkType,
			})
			.from(schema.artifactLinks)
			.where(
				eq(schema.artifactLinks.conversationId, action?.conversation.id ?? ""),
			);
		const followupJobs = await db
			.select({ id: schema.deepResearchJobs.id })
			.from(schema.deepResearchJobs)
			.where(
				eq(
					schema.deepResearchJobs.conversationId,
					action?.conversation.id ?? "",
				),
			);

		expect(action).toMatchObject({
			sourceJobId: created.id,
			reportArtifactId: completed?.reportArtifactId,
			conversation: {
				title: "Discuss: Compare EU and US AI copyright training data rules",
				projectId: "project-1",
			},
		});
		expect(action?.conversation.id).not.toBe("conv-1");
		expect(sourceConversation).toEqual({
			status: "sealed",
			sealedAt: new Date("2026-05-05T10:20:00.000Z"),
		});
		expect(seedMessage).toBeUndefined();
		expect(action?.seedMessage).toContain("Discuss this Research Report");
		expect(links).toEqual([
			{
				artifactId: completed?.reportArtifactId,
				conversationId: action?.conversation.id,
				messageId: null,
				linkType: "attached_to_conversation",
			},
		]);
		expect(followupJobs).toEqual([]);
	});

	it("starts a new Deep Research Job from a completed Research Report and leaves it awaiting approval", async () => {
		const { db } = await import("$lib/server/db");
		const { researchFurtherFromDeepResearchReport } = await import("./index");
		const { created, completed } = await completeApprovedJobWithAuditedReport();
		await assignConversationToResearchProject(dbPath);

		const action = await researchFurtherFromDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			depth: "focused",
			now: new Date("2026-05-05T10:25:00.000Z"),
		});
		const [sourceConversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));
		const [seedMessage] = await db
			.select({
				role: schema.messages.role,
				content: schema.messages.content,
				metadataJson: schema.messages.metadataJson,
			})
			.from(schema.messages)
			.where(eq(schema.messages.id, action?.messageId ?? ""));
		const links = await db
			.select({
				artifactId: schema.artifactLinks.artifactId,
				conversationId: schema.artifactLinks.conversationId,
				messageId: schema.artifactLinks.messageId,
				linkType: schema.artifactLinks.linkType,
			})
			.from(schema.artifactLinks)
			.where(
				eq(schema.artifactLinks.conversationId, action?.conversation.id ?? ""),
			);

		expect(action).toMatchObject({
			sourceJobId: created.id,
			reportArtifactId: completed?.reportArtifactId,
			conversation: {
				title:
					"Research further: Compare EU and US AI copyright training data rules",
				projectId: "project-1",
			},
			messageId: expect.any(String),
			job: {
				conversationId: action?.conversation.id,
				triggerMessageId: action?.messageId,
				depth: "focused",
				status: "awaiting_approval",
				stage: "plan_drafted",
				plan: {
					contextDisclosure: "Context considered: 1 report item.",
					effortEstimate: {
						selectedDepth: "focused",
						sourceReviewCeiling: 24,
					},
				},
			},
		});
		expect(action?.conversation.id).not.toBe("conv-1");
		expect(action?.job.id).not.toBe(created.id);
		expect(sourceConversation).toEqual({
			status: "sealed",
			sealedAt: new Date("2026-05-05T10:20:00.000Z"),
		});
		expect(seedMessage).toMatchObject({
			role: "user",
			content: expect.stringContaining(
				"Research further from this Research Report",
			),
		});
		expect(JSON.parse(seedMessage?.metadataJson ?? "{}")).toMatchObject({
			deepResearchReportContext: {
				action: "research_further",
				sourceJobId: created.id,
				sourceConversationId: "conv-1",
				reportArtifactId: completed?.reportArtifactId,
			},
		});
		expect(links).toEqual([
			{
				artifactId: completed?.reportArtifactId,
				conversationId: action?.conversation.id,
				messageId: action?.messageId,
				linkType: "attached_to_conversation",
			},
		]);
	});

	it("reuses an existing Evidence Limitation Memo discussion for repeated recovery clicks", async () => {
		const { db } = await import("$lib/server/db");
		const { discussDeepResearchReport } = await import("./index");
		const { created, completed } =
			await completeApprovedJobWithEvidenceLimitationMemo();

		const firstAction = await discussDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:25:00.000Z"),
		});
		const secondAction = await discussDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:26:00.000Z"),
		});
		const followupConversations = await db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(
				eq(
					schema.conversations.title,
					"Discuss: Assess unverified battery recycling claims",
				),
			);
		const discussionLinks = await db
			.select({
				artifactId: schema.artifactLinks.artifactId,
				conversationId: schema.artifactLinks.conversationId,
				messageId: schema.artifactLinks.messageId,
			})
			.from(schema.artifactLinks)
			.where(
				eq(schema.artifactLinks.artifactId, completed?.reportArtifactId ?? ""),
			);

		expect(secondAction?.conversation.id).toBe(firstAction?.conversation.id);
		expect(secondAction?.messageId).toBeUndefined();
		expect(followupConversations).toHaveLength(1);
		expect(discussionLinks).toEqual([
			{
				artifactId: completed?.reportArtifactId,
				conversationId: firstAction?.conversation.id,
				messageId: null,
			},
		]);
	});

	it("reuses an existing Evidence Limitation Memo research-further job for repeated recovery clicks", async () => {
		const { db } = await import("$lib/server/db");
		const { researchFurtherFromDeepResearchReport } = await import("./index");
		const { created, completed } =
			await completeApprovedJobWithEvidenceLimitationMemo();

		const firstAction = await researchFurtherFromDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			depth: "standard",
			now: new Date("2026-05-05T10:25:00.000Z"),
		});
		const secondAction = await researchFurtherFromDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			depth: "standard",
			now: new Date("2026-05-05T10:26:00.000Z"),
		});
		const followupConversations = await db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(
				eq(
					schema.conversations.title,
					"Research further: Assess unverified battery recycling claims",
				),
			);
		const researchJobs = await db
			.select({
				id: schema.deepResearchJobs.id,
				conversationId: schema.deepResearchJobs.conversationId,
				triggerMessageId: schema.deepResearchJobs.triggerMessageId,
			})
			.from(schema.deepResearchJobs);
		const seedMessages = await db
			.select({
				id: schema.messages.id,
				metadataJson: schema.messages.metadataJson,
			})
			.from(schema.messages)
			.where(
				eq(schema.messages.conversationId, firstAction?.conversation.id ?? ""),
			);

		expect(secondAction?.conversation.id).toBe(firstAction?.conversation.id);
		expect(secondAction?.messageId).toBe(firstAction?.messageId);
		expect(secondAction?.job.id).toBe(firstAction?.job.id);
		expect(followupConversations).toHaveLength(1);
		expect(researchJobs).toHaveLength(2);
		expect(seedMessages).toHaveLength(1);
		expect(JSON.parse(seedMessages[0]?.metadataJson ?? "{}")).toMatchObject({
			deepResearchReportContext: {
				action: "research_further_from_memo",
				sourceJobId: created.id,
				reportArtifactId: completed?.reportArtifactId,
				requestedDepth: "standard",
			},
		});
	});
});
