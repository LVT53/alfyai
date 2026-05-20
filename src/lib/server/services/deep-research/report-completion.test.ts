import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";
import { evaluateDeepResearchRun } from "./evaluation";
import type { SynthesisNotes } from "./synthesis";

let dbPath: string;

async function seedConversation() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-05T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "user-msg-1",
			conversationId: "conv-1",
			role: "user",
			content: "Compare EU and US AI copyright training data rules",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function seedCompletedMeaningfulPasses(
	jobId: string,
	count: number,
	startPassNumber = 1,
) {
	const { upsertResearchPassCheckpoint, completeResearchPassCheckpoint } =
		await import("./pass-state");
	for (let index = 0; index < count; index += 1) {
		const passNumber = startPassNumber + index;
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId,
			conversationId: "conv-1",
			passNumber,
			searchIntent:
				passNumber === 1
					? "Initial approved-plan source review"
					: `Targeted follow-up for pass ${passNumber - 1} Coverage Gaps`,
			reviewedSourceIds: [],
			now: new Date(`2026-05-05T10:${10 + index}:00.000Z`),
		});
		await completeResearchPassCheckpoint({
			userId: "user-1",
			checkpointId: checkpoint.id,
			nextDecision: "synthesize_report",
			decisionSummary: "Fixture completed meaningful research pass.",
			now: new Date(`2026-05-05T10:${10 + index}:30.000Z`),
		});
	}
}

describe("audited Deep Research report completion", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-deep-research-report-completion-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedConversation();
	});

	afterEach(async () => {
		vi.doUnmock("./llm-steps");
		vi.doUnmock("./report-writer");
		vi.restoreAllMocks();
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

	it("writes an audited Research Report artifact from supported findings and seals the conversation", async () => {
		const { db } = await import("$lib/server/db");
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			listConversationDeepResearchJobs,
			startDeepResearchJobShell,
		} = await import("./index");
		const {
			listResearchSources,
			markResearchSourceReviewed,
			saveDiscoveredResearchSource,
		} = await import("./sources");
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

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
		await seedCompletedMeaningfulPasses(created.id, 3);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://agency.example.test/ai-copyright-training-data",
			title: "Agency AI copyright training data briefing",
			provider: "public_web",
			snippet: "Agency briefing on AI copyright training data rules.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote:
				"EU and US AI copyright training data rules require provenance records and rights-risk review.",
		});
		const synthesisNotes: SynthesisNotes = {
			jobId: created.id,
			findings: [
				{
					kind: "supported",
					statement:
						"EU and US AI copyright training data rules require provenance records and rights-risk review.",
					sourceRefs: [
						{
							reviewedSourceId: reviewedSource.id,
							discoveredSourceId: reviewedSource.id,
							canonicalUrl: reviewedSource.url,
							title: reviewedSource.title ?? "Agency briefing",
						},
					],
				},
			],
			supportedFindings: [
				{
					kind: "supported",
					statement:
						"EU and US AI copyright training data rules require provenance records and rights-risk review.",
					sourceRefs: [
						{
							reviewedSourceId: reviewedSource.id,
							discoveredSourceId: reviewedSource.id,
							canonicalUrl: reviewedSource.url,
							title: reviewedSource.title ?? "Agency briefing",
						},
					],
				},
			],
			conflicts: [],
			assumptions: [],
			reportLimitations: [],
		};

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes,
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;
		const [conversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));
		const sources = await listResearchSources({
			userId: "user-1",
			jobId: created.id,
		});

		expect(completed).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "report_ready",
			completedAt: new Date("2026-05-05T10:20:00.000Z").getTime(),
		});
		expect(reportArtifact).toMatchObject({
			id: completed?.reportArtifactId,
			userId: "user-1",
			conversationId: "conv-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: "Research Report - Compare EU and US AI copyright training data rules.md",
			mimeType: "text/markdown",
			extension: "md",
			metadata: {
				deepResearchJobId: created.id,
				deepResearchReport: true,
				deepResearchReportKind: "audited",
				deepResearchSourceLedgerSnapshot: expect.objectContaining({
					markdown: expect.stringContaining("### Cited Sources"),
					sources: [
						expect.objectContaining({
							id: source.id,
							title: "Agency AI copyright training data briefing",
						}),
					],
				}),
				documentRole: "research_report",
				originConversationId: "conv-1",
			},
		});
		expect(reportArtifact?.contentText).toContain(
			"# Research Report: Compare EU and US AI copyright training data rules",
		);
		expect(reportArtifact?.contentText).toContain("## Methodology");
		expect(reportArtifact?.contentText).toContain("## Comparison");
		expect(reportArtifact?.contentText).toContain(
			"EU and US AI copyright training data rules require provenance records and rights-risk review.",
		);
		expect(reportArtifact?.contentText).not.toContain(
			"The citation audit retained this core finding",
		);
		expect(reportArtifact?.contentText).toContain("## Sources");
		expect(reportArtifact?.contentText).toContain(
			"[1] Agency AI copyright training data briefing - https://agency.example.test/ai-copyright-training-data",
		);
		expect(conversation).toEqual({
			status: "sealed",
			sealedAt: new Date("2026-05-05T10:20:00.000Z"),
		});
		expect(sources).toEqual([
			expect.objectContaining({
				id: source.id,
				status: "cited",
				reviewedAt: "2026-05-05T10:08:00.000Z",
				citedAt: "2026-05-05T10:20:00.000Z",
			}),
		]);

		const lateReviewedSource = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://late.example.test/mutable-live-source",
			title: "Late mutable live source",
			provider: "public_web",
		});
		await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: lateReviewedSource.id,
			reviewedNote: "This row was added after the report was completed.",
		});
		const [reopened] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);

		expect(reopened.sourceCounts).toEqual({
			discovered: 1,
			reviewed: 1,
			cited: 1,
		});
		expect(reopened.sources?.map((source) => source.title)).toEqual([
			"Agency AI copyright training data briefing",
		]);
	});

	it("turns unsupported claims into visible limitations and still completes when supported findings remain", async () => {
		const { db } = await import("$lib/server/db");
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Assess battery cost and supply risk trends",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://market.example.test/battery-costs",
			title: "Battery cost tracker",
			provider: "public_web",
			snippet: "Battery cost tracker summary.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote:
				"Battery costs decreased in 2025, while supply risk remained a separate open issue.",
		});
		const synthesisNotes = buildSynthesisNotes(created.id, [
			{
				statement: "Battery costs decreased in 2025.",
				sourceId: reviewedSource.id,
				url: reviewedSource.url,
				title: reviewedSource.title ?? "Battery cost tracker",
			},
			{
				statement: "Battery recycling eliminated all supply risk in 2025.",
				sourceId: reviewedSource.id,
				url: reviewedSource.url,
				title: reviewedSource.title ?? "Battery cost tracker",
			},
		]);

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes,
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;
		const [conversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));

		expect(completed).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "report_ready",
		});
		expect(reportArtifact?.contentText).toContain(
			"Battery costs decreased in 2025.",
		);
		expect(reportArtifact?.contentText).toContain("## Report Limitations");
		expect(reportArtifact?.contentText).toContain(
			"Removed unsupported core claim after citation audit: Battery recycling eliminated all supply risk in 2025.",
		);
		expect(conversation).toEqual({
			status: "sealed",
			sealedAt: new Date("2026-05-05T10:20:00.000Z"),
		});
	});

	it("writes a Limited Research Report artifact from partial cited central claims and seals the conversation", async () => {
		const { db } = await import("$lib/server/db");
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare private AI coding assistants",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify repository workflow support",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://vendor.example.test/private-ai-coding-workflow",
			title: "Private AI coding workflow docs",
			provider: "public_web",
			snippet: "Repository workflow support for private AI coding assistants.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote:
				"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
			topicRelevant: true,
			supportedKeyQuestions: [
				"Which products have the strongest repository-aware coding workflow?",
			],
			extractedClaims: [
				"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
			],
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			sourceId: reviewedSource.id,
			notes: [
				{
					supportedKeyQuestion:
						"Which products have the strongest repository-aware coding workflow?",
					findingText:
						"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
					sourceSupport: { sourceId: reviewedSource.id },
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement:
						"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
					claimType: "general",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement:
						"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
					sourceId: reviewedSource.id,
					url: reviewedSource.url,
					title: reviewedSource.title ?? "Private AI coding workflow docs",
				},
			]),
			reportOutcome: "limited_research_report",
			limitations: [
				"Pricing and compliance coverage were unsupported and omitted from the report body.",
			],
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;
		const [conversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));

		expect(completed).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "limited_research_report_ready",
		});
		expect(reportArtifact).toMatchObject({
			name: "Limited Research Report - Compare private AI coding assistants.md",
			metadata: {
				deepResearchReport: true,
				deepResearchReportOutcome: "limited_research_report",
				documentRole: "limited_research_report",
				citationAuditStatus: expect.any(String),
			},
		});
		expect(reportArtifact?.contentText).toContain(
			"# Limited Research Report: Compare private AI coding assistants",
		);
		expect(reportArtifact?.contentText).toContain(
			"Private AI coding assistants can support repository-aware workflow when permission controls are documented.",
		);
		expect(reportArtifact?.contentText).toContain("## Report Limitations");
		expect(reportArtifact?.contentText).toContain(
			"Pricing and compliance coverage were unsupported and omitted from the report body.",
		);
		expect(reportArtifact?.contentText).not.toContain(
			"fully comparable pricing and compliance coverage",
		);
		expect(reportArtifact?.contentText).toContain("## Appendix: Sources");
		expect(conversation).toEqual({
			status: "sealed",
			sealedAt: new Date("2026-05-05T10:20:00.000Z"),
		});
	});

	it("assembles the completed report from verified Synthesis Claims instead of source-note synthesis text", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare private AI coding assistants",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://vendor.example.test/private-ai-coding-security",
			title: "Private AI coding security docs",
			provider: "public_web",
			snippet: "Security docs for private AI coding assistants.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote:
				"Private AI coding assistants vary by repository index freshness and permission controls.",
		});
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify private AI coding assistant controls",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			notes: [
				{
					sourceId: reviewedSource.id,
					findingText:
						"Private AI coding assistants vary by repository index freshness and permission controls.",
					supportedKeyQuestion:
						"Which products have the strongest repository-aware coding workflow?",
					sourceSupport: {
						sourceId: reviewedSource.id,
						reviewedSourceId: reviewedSource.id,
					},
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement:
						"Private AI coding assistants vary by repository index freshness and permission controls.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement: "Private AI coding security docs",
					sourceId: reviewedSource.id,
					url: reviewedSource.url,
					title: reviewedSource.title ?? "Private AI coding security docs",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;

		expect(completed).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "report_ready",
		});
		expect(reportArtifact?.contentText).toContain(
			"Private AI coding assistants vary by repository index freshness and permission controls.",
		);
		expect(reportArtifact?.contentText).not.toContain(
			"- Private AI coding security docs [1]",
		);
		expect(reportArtifact?.contentText).toContain(
			"## Appendix: Source Ledger Snapshot",
		);
	});

	it("publishes an Evidence Limitation Memo instead of throwing when audited claims are source-note titles", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare Cube Nulane and Cube Kathmandu bikes",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify bike source-note title regression",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const sourceTitles = [
			"2025 CUBE Bikes Nulane One - Bike Insights",
			"2026 CUBE Bikes Kathmandu One - Bike Insights",
			"Compare CUBE NULANE PRO 2024 vs CUBE KATHMANDU, PRO 2025",
		];
		const reviewedSources = [];
		for (const [index, title] of sourceTitles.entries()) {
			const source = await saveDiscoveredResearchSource({
				userId: "user-1",
				conversationId: "conv-1",
				jobId: created.id,
				url: `https://bike.example.test/source-${index + 1}`,
				title,
				provider: "public_web",
				snippet: title,
				discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
			});
			reviewedSources.push(
				await markResearchSourceReviewed({
					userId: "user-1",
					sourceId: source.id,
					reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
					reviewedNote: title,
					extractedClaims: [title],
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				}),
			);
		}
		const evidenceNotes = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			notes: reviewedSources.map((source) => ({
				sourceId: source.id,
				findingText: source.title ?? source.url,
				supportedKeyQuestion: "Which bike sources support the comparison?",
				sourceSupport: {
					sourceId: source.id,
					reviewedSourceId: source.id,
					title: source.title ?? source.url,
				},
				sourceQualitySignals: {
					sourceType: "official_vendor",
					independence: "primary",
					freshness: "current",
					directness: "direct",
					extractionConfidence: "high",
					claimFit: "strong",
				},
			})),
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: evidenceNotes.map((note) => ({
				statement: note.findingText,
				claimType: "official_specification",
				central: true,
				status: "accepted",
				evidenceLinks: [
					{
						evidenceNoteId: note.id,
						relation: "support",
					},
				],
			})),
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(
				created.id,
				reviewedSources.map((source) => ({
					statement: source.title ?? source.url,
					sourceId: source.id,
					url: source.url,
					title: source.title ?? source.url,
				})),
			),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const memoArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;

		expect(completed).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "evidence_limitation_memo_ready",
		});
		expect(memoArtifact?.metadata).toMatchObject({
			deepResearchEvidenceLimitationMemo: true,
			documentRole: "evidence_limitation_memo",
		});
		expect(memoArtifact?.contentText).toContain(
			"Report assembly could not publish a readable research report because retained claims repeated source-note titles.",
		);
		expect(memoArtifact?.contentText).not.toContain("# Research Report:");
	});

	it("preserves structured comparison matrix markdown after audited finalization", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const {
			listResearchSources,
			markResearchSourceReviewed,
			saveDiscoveredResearchSource,
		} = await import("./sources");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { listDeepResearchSynthesisClaims, saveDeepResearchSynthesisClaims } =
			await import("./synthesis-claims");
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare Product A and Product B",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		const approvedPlan = created.currentPlan?.rawPlan;
		expect(approvedPlan).toBeTruthy();
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3);
		const sourceA = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://product.example.test/a",
			title: "Product A official specifications",
			provider: "public_web",
		});
		const sourceB = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://product-b.example.test/specs",
			title: "Product B official specifications",
			provider: "public_web",
		});
		const reviewedSourceA = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: sourceA.id,
			reviewedNote: "Product A has a 400Wh battery for commuter range.",
			supportedKeyQuestions: approvedPlan?.keyQuestions ?? [],
			topicRelevant: true,
			comparedEntity: "Product A",
			comparisonAxis: "Range",
			extractedClaims: ["Product A has a 400Wh battery for commuter range."],
			sourceQualitySignals: {
				sourceType: "official_vendor",
				independence: "primary",
				freshness: "current",
				directness: "direct",
				extractionConfidence: "high",
				claimFit: "strong",
			},
		});
		const reviewedSourceB = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: sourceB.id,
			reviewedNote: "Product B uses a Bosch SX motor with 55Nm torque.",
			supportedKeyQuestions: approvedPlan?.keyQuestions ?? [],
			topicRelevant: true,
			comparedEntity: "Product B",
			comparisonAxis: "Motor support",
			extractedClaims: ["Product B uses a Bosch SX motor with 55Nm torque."],
			sourceQualitySignals: {
				sourceType: "official_vendor",
				independence: "primary",
				freshness: "current",
				directness: "direct",
				extractionConfidence: "high",
				claimFit: "strong",
			},
		});
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 4,
			searchIntent:
				"Verify Product A and Product B entity-axis comparison evidence",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [productARangeNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			sourceId: reviewedSourceA.id,
			notes: [
				{
					findingText: "Product A has a 400Wh battery for commuter range.",
					supportedKeyQuestion: approvedPlan?.keyQuestions[0] ?? null,
					comparedEntity: "Product A",
					comparisonAxis: "Range",
					sourceSupport: {
						sourceId: reviewedSourceA.id,
						reviewedSourceId: reviewedSourceA.id,
						url: reviewedSourceA.url,
						title: reviewedSourceA.title,
					},
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		const [productBMotorNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			sourceId: reviewedSourceB.id,
			notes: [
				{
					findingText: "Product B uses a Bosch SX motor with 55Nm torque.",
					supportedKeyQuestion: approvedPlan?.keyQuestions[1] ?? null,
					comparedEntity: "Product B",
					comparisonAxis: "Motor support",
					sourceSupport: {
						sourceId: reviewedSourceB.id,
						reviewedSourceId: reviewedSourceB.id,
						url: reviewedSourceB.url,
						title: reviewedSourceB.title,
					},
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
			],
			now: new Date("2026-05-05T10:11:30.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Product A has a 400Wh battery for commuter range.",
					planQuestion: approvedPlan?.keyQuestions[0] ?? null,
					reportSection: "Range",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: productARangeNote.id,
							relation: "support",
						},
					],
				},
				{
					statement: "Product B uses a Bosch SX motor with 55Nm torque.",
					planQuestion: approvedPlan?.keyQuestions[1] ?? null,
					reportSection: "Motor support",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: productBMotorNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement: "Product A has a 400Wh battery for commuter range.",
					sourceId: reviewedSourceA.id,
					url: reviewedSourceA.url,
					title: reviewedSourceA.title ?? "Product A specifications",
				},
				{
					statement: "Product B uses a Bosch SX motor with 55Nm torque.",
					sourceId: reviewedSourceB.id,
					url: reviewedSourceB.url,
					title: reviewedSourceB.title ?? "Product B specifications",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;
		const [sources, synthesisClaims] = await Promise.all([
			listResearchSources({
				userId: "user-1",
				jobId: created.id,
			}),
			listDeepResearchSynthesisClaims({
				userId: "user-1",
				jobId: created.id,
			}),
		]);
		const evaluation = await evaluateDeepResearchRun({
			id: created.id,
			title: "DB-backed comparison completion fixture",
			plan: approvedPlan as Parameters<
				typeof evaluateDeepResearchRun
			>[0]["plan"],
			reviewedSources: sources.map((source) => ({
				id: source.id,
				title: source.title ?? source.url,
				canonicalUrl: source.url,
				supportedKeyQuestions: approvedPlan?.keyQuestions ?? [],
				keyFindings: source.extractedClaims ?? [],
				qualityScore: 90,
				topicRelevant: source.topicRelevant ?? true,
				comparedEntity: source.comparedEntity,
				comparisonAxis: source.comparisonAxis,
			})),
			discoveryRequests: [
				{
					query: "Product A official specifications Range",
					sourcePolicy: "technical",
					comparedEntity: "Product A",
					comparisonAxis: "Range",
				},
				{
					query: "Product B official specifications Motor support",
					sourcePolicy: "technical",
					comparedEntity: "Product B",
					comparisonAxis: "Motor support",
				},
			],
			evidenceNotes: [productARangeNote, productBMotorNote],
			synthesisClaims,
			reportArtifact: reportArtifact
				? {
						id: reportArtifact.id,
						contentText: reportArtifact.contentText,
						metadata: reportArtifact.metadata,
					}
				: null,
			expectedComparisonGrid: [
				{
					comparedEntity: "Product A",
					comparisonAxis: "Range",
					expectedText: "Product A has a 400Wh battery for commuter range.",
				},
				{
					comparedEntity: "Product B",
					comparisonAxis: "Motor support",
					expectedText: "Product B uses a Bosch SX motor with 55Nm torque.",
				},
			],
		});

		expect(reportArtifact?.contentText).toContain("## Comparison Matrix");
		expect(reportArtifact?.contentText).toContain(
			"| Axis | Product A | Product B | Decision Meaning |",
		);
		expect(reportArtifact?.contentText).toMatch(
			/\| Range \| \*\*Official spec\*\* Product A has a 400Wh battery for commuter range\. \[\d+\] \| Not established \|/,
		);
		expect(reportArtifact?.contentText).not.toContain(
			"## Comparison Matrix\n- Product A has a 400Wh battery",
		);
		expect(evaluation.dimensions.comparisonCoverage.passed).toBe(true);
		expect(evaluation.dimensions.searchPolicyFit.passed).toBe(true);
		expect(evaluation.accepted).toBe(true);
	});

	it("uses the configured claim-graph citation reviewer to complete claims that deterministic quality signals would repair", async () => {
		let supportedEvidenceNoteId = "";
		vi.doMock("./llm-steps", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./llm-steps")>();
			return {
				...actual,
				buildClaimGraphCitationReviewerWithLlm:
					async () =>
					({ claim }) => ({
						claimId: claim.id,
						verdict: "supported",
						evidenceNoteIds: [supportedEvidenceNoteId],
						reason:
							"The configured citation-audit model judged the linked Evidence Note sufficient.",
					}),
			};
		});
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Check Model X specifications",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify Model X official specification",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://vendor.example.test/model-x",
			title: "Model X product page",
			provider: "public_web",
			snippet: "Vendor product page for Model X specifications.",
			discoveredAt: new Date("2026-05-05T10:10:30.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:10:45.000Z"),
			reviewedNote: "Model X officially includes 16 GB memory.",
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			sourceId: reviewedSource.id,
			passCheckpointId: checkpoint.id,
			notes: [
				{
					findingText: "Model X officially includes 16 GB memory.",
					supportedKeyQuestion: "What are Model X official specifications?",
					sourceSupport: {
						sourceId: reviewedSource.id,
						reviewedSourceId: reviewedSource.id,
						title: reviewedSource.title,
						url: reviewedSource.url,
					},
					sourceQualitySignals: {
						sourceType: "forum",
						independence: "community",
						freshness: "undated",
						directness: "anecdotal",
						extractionConfidence: "low",
						claimFit: "weak",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		supportedEvidenceNoteId = evidenceNote.id;
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Model X officially includes 16 GB memory.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement: "Model X official specification review",
					sourceId: reviewedSource.id,
					url: reviewedSource.url,
					title: reviewedSource.title ?? "Model X product page",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;

		expect(completed).toMatchObject({
			status: "completed",
			stage: "report_ready",
		});
		expect(reportArtifact?.contentText).toContain(
			"Model X officially includes 16 GB memory.",
		);
	});

	it("creates a repair pass when the configured claim-graph citation reviewer requests repair", async () => {
		let repairEvidenceNoteId = "";
		vi.doMock("./llm-steps", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./llm-steps")>();
			return {
				...actual,
				buildClaimGraphCitationReviewerWithLlm:
					async () =>
					({ claim }) => ({
						claimId: claim.id,
						verdict: "needs_repair",
						evidenceNoteIds: [repairEvidenceNoteId],
						reason: "The configured citation-audit model requested repair.",
					}),
			};
		});
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { listResearchTasks } = await import("./tasks");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Check Model X specifications",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify Model X official specification",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			notes: [
				{
					findingText: "Model X officially includes 16 GB memory.",
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		repairEvidenceNoteId = evidenceNote.id;
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Model X officially includes 16 GB memory.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const result = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, []),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const tasks = await listResearchTasks({
			userId: "user-1",
			jobId: created.id,
		});

		expect(result).toMatchObject({
			status: "running",
			stage: "research_tasks",
			reportArtifactId: null,
		});
		expect(tasks).toContainEqual(
			expect.objectContaining({
				assignment: expect.stringContaining(
					"The configured citation-audit model requested repair.",
				),
			}),
		);
	});

	it("renders an audited report from supported claims when repair budget is exhausted", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare Model X and Model Y specifications",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: (
				await saveDiscoveredResearchSource({
					userId: "user-1",
					conversationId: "conv-1",
					jobId: created.id,
					url: "https://vendor.example.test/model-x/specs",
					title: "Model X official specifications",
					provider: "public_web",
					snippet: "Model X officially includes 16 GB memory.",
					discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
				})
			).id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote: "Model X officially includes 16 GB memory.",
			relevanceScore: 95,
			topicRelevant: true,
			supportedKeyQuestions: ["What are the official Model X specifications?"],
			extractedClaims: ["Model X officially includes 16 GB memory."],
			sourceQualitySignals: {
				sourceType: "official_vendor",
				independence: "primary",
				freshness: "current",
				directness: "direct",
				extractionConfidence: "high",
				claimFit: "strong",
			},
		});
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Initial specification review",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 5,
			searchIntent:
				"Completed Citation audit repair pass for unsupported claims",
			now: new Date("2026-05-05T10:13:00.000Z"),
		});
		await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 6,
			searchIntent:
				"Completed Citation audit repair pass for remaining unsupported claims",
			now: new Date("2026-05-05T10:14:00.000Z"),
		});
		const [supportedNote, weakNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			sourceId: reviewedSource.id,
			notes: [
				{
					findingText: "Model X officially includes 16 GB memory.",
					sourceSupport: {
						sourceId: reviewedSource.id,
						url: reviewedSource.url,
						title: reviewedSource.title,
					},
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
				{
					findingText: "A forum post says Model Y feels durable.",
					sourceQualitySignals: {
						sourceType: "forum",
						independence: "community",
						freshness: "undated",
						directness: "anecdotal",
						extractionConfidence: "low",
						claimFit: "weak",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Model X officially includes 16 GB memory.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{ evidenceNoteId: supportedNote.id, relation: "support" },
					],
				},
				{
					statement: "Model Y officially has proven long-term durability.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [{ evidenceNoteId: weakNote.id, relation: "support" }],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement: "Model X officially includes 16 GB memory.",
					sourceId: reviewedSource.id,
					url: reviewedSource.url,
					title: reviewedSource.title ?? "Model X official specifications",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;

		expect(completed).toMatchObject({
			status: "completed",
			stage: "report_ready",
		});
		expect(reportArtifact?.contentText).toContain(
			"Model X officially includes 16 GB memory.",
		);
		expect(reportArtifact?.contentText).toContain(
			"Removed 1 unsupported or unresolved claim",
		);
		expect(reportArtifact?.contentText).not.toContain(
			"Evidence Limitation Memo",
		);
	});

	it("falls back conservatively when the configured claim-graph citation reviewer is unavailable", async () => {
		vi.doMock("./llm-steps", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./llm-steps")>();
			return {
				...actual,
				buildClaimGraphCitationReviewerWithLlm: async () => null,
			};
		});
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { listResearchTasks } = await import("./tasks");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Check Model X specifications",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Verify Model X official specification",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			notes: [
				{
					findingText: "Model X officially includes 16 GB memory.",
					sourceQualitySignals: {
						sourceType: "forum",
						independence: "community",
						freshness: "undated",
						directness: "anecdotal",
						extractionConfidence: "low",
						claimFit: "weak",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Model X officially includes 16 GB memory.",
					claimType: "official_specification",
					central: true,
					status: "accepted",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const result = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, []),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const tasks = await listResearchTasks({
			userId: "user-1",
			jobId: created.id,
		});

		expect(result).toMatchObject({
			status: "running",
			stage: "research_tasks",
			reportArtifactId: null,
		});
		expect(tasks).toContainEqual(
			expect.objectContaining({
				assignment: expect.stringContaining(
					"Claim Type Evidence Requirements were not met",
				),
			}),
		);
	});

	it("creates a repair pass instead of rendering Markdown when claim-graph audit needs repair", async () => {
		const { db } = await import("$lib/server/db");
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { saveDeepResearchEvidenceNotes } = await import("./evidence-notes");
		const { upsertResearchPassCheckpoint } = await import("./pass-state");
		const { saveDeepResearchSynthesisClaims } = await import(
			"./synthesis-claims"
		);
		const { listResearchTasks } = await import("./tasks");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Check Model X official specifications",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 3, 2);
		const checkpoint = await upsertResearchPassCheckpoint({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passNumber: 1,
			searchIntent: "Initial official specification review",
			now: new Date("2026-05-05T10:10:00.000Z"),
		});
		const [evidenceNote] = await saveDeepResearchEvidenceNotes({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			notes: [
				{
					findingText: "Model X officially includes 16 GB memory.",
					supportedKeyQuestion: "What are Model X official specs?",
					sourceQualitySignals: {
						sourceType: "official_vendor",
						independence: "primary",
						freshness: "current",
						directness: "direct",
						extractionConfidence: "high",
						claimFit: "strong",
					},
				},
			],
			now: new Date("2026-05-05T10:11:00.000Z"),
		});
		await saveDeepResearchSynthesisClaims({
			userId: "user-1",
			jobId: created.id,
			conversationId: "conv-1",
			passCheckpointId: checkpoint.id,
			synthesisPass: "synthesis-pass-1",
			claims: [
				{
					statement: "Model X officially includes 16 GB memory.",
					claimType: "official_specification",
					central: true,
					status: "needs-repair",
					evidenceLinks: [
						{
							evidenceNoteId: evidenceNote.id,
							relation: "support",
						},
					],
				},
			],
			now: new Date("2026-05-05T10:12:00.000Z"),
		});

		const result = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement: "Model X officially includes 16 GB memory.",
					sourceId: "source-1",
					url: "https://vendor.example.test/model-x",
					title: "Model X official specifications",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const tasks = await listResearchTasks({
			userId: "user-1",
			jobId: created.id,
			passNumber: 5,
		});
		const generatedArtifacts = await db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));

		expect(result).toMatchObject({
			id: created.id,
			status: "running",
			stage: "research_tasks",
			reportArtifactId: null,
			passCheckpoints: expect.arrayContaining([
				expect.objectContaining({
					passNumber: 5,
					searchIntent:
						"Citation audit repair pass for unsupported or contradicted Synthesis Claims",
				}),
			]),
		});
		expect(tasks).toEqual([
			expect.objectContaining({
				passNumber: 5,
				status: "pending",
				assignment: expect.stringContaining(
					"Repair claim after citation audit",
				),
			}),
		]);
		expect(generatedArtifacts).toEqual([]);
	});

	it("keeps the final audited report in Hungarian when the research prompt is Hungarian", async () => {
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Kérlek kutass a magyar AI piac 2025-os trendjeiről",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 2);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://kutatas.example.test/magyar-ai-piac",
			title: "Magyar AI piaci attekintes",
			provider: "public_web",
			snippet: "A magyar AI piac 2025-ben novekedett.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote: "A magyar AI piac 2025-ben novekedett.",
		});
		const synthesisNotes = buildSynthesisNotes(created.id, [
			{
				statement: "A magyar AI piac 2025-ben novekedett.",
				sourceId: reviewedSource.id,
				url: reviewedSource.url,
				title: reviewedSource.title ?? "Magyar AI piaci attekintes",
			},
		]);

		const completed = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes,
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const reportArtifact = completed?.reportArtifactId
			? await getArtifactForUser("user-1", completed.reportArtifactId)
			: null;

		expect(created.currentPlan?.rawPlan?.researchLanguage).toBe("hu");
		expect(reportArtifact?.name).toMatch(/^Kutatási jelentés - /);
		expect(reportArtifact?.summary).toContain("Ellenőrzött kutatási jelentés");
		expect(reportArtifact?.contentText).toContain("# Kutatási jelentés:");
		expect(reportArtifact?.contentText).toContain("## Vezetői összefoglaló");
		expect(reportArtifact?.contentText).toContain("## Fő megállapítások");
		expect(reportArtifact?.contentText).toContain("## Források");
		expect(reportArtifact?.contentText).toContain(
			"Rövid válasz: A magyar AI piac 2025-ben novekedett.",
		);
		expect(reportArtifact?.contentText).not.toContain(
			"A hivatkozás-ellenőrzés után megtartott fő megállapítás",
		);
		expect(reportArtifact?.contentText).not.toContain("## Executive Summary");
		expect(reportArtifact?.contentText).not.toContain("## Key Findings");
		expect(reportArtifact?.contentText).not.toContain("## Sources");
	});

	it("publishes an Evidence Limitation Memo without sealing the conversation when no credible supported claims remain", async () => {
		const { db } = await import("$lib/server/db");
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			discussDeepResearchReport,
			listConversationDeepResearchJobs,
			researchFurtherFromDeepResearchReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { listResearchSources, saveDiscoveredResearchSource } = await import(
			"./sources"
		);
		const { getArtifactForUser } = await import(
			"$lib/server/services/knowledge/store"
		);

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Assess unverified battery recycling claims",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await seedCompletedMeaningfulPasses(created.id, 2);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://blog.example.test/battery-recycling-claim",
			title: "Unreviewed battery recycling claim",
			provider: "public_web",
			snippet: "Battery recycling eliminated all supply risk in 2025.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const synthesisNotes = buildSynthesisNotes(created.id, [
			{
				statement: "Battery recycling eliminated all supply risk in 2025.",
				sourceId: source.id,
				url: source.url,
				title: source.title ?? "Unreviewed battery recycling claim",
			},
		]);

		const completedMemo = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes,
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const memoArtifact = completedMemo?.reportArtifactId
			? await getArtifactForUser("user-1", completedMemo.reportArtifactId)
			: null;
		const [conversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));
		const generatedArtifacts = await db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));
		const sources = await listResearchSources({
			userId: "user-1",
			jobId: created.id,
		});
		const [listedMemoJob] = await listConversationDeepResearchJobs(
			"user-1",
			"conv-1",
		);
		const discussResult = await discussDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			persistSeedMessage: true,
			now: new Date("2026-05-05T10:22:00.000Z"),
		});
		const researchFurtherResult = await researchFurtherFromDeepResearchReport({
			userId: "user-1",
			jobId: created.id,
			depth: "max",
			now: new Date("2026-05-05T10:23:00.000Z"),
		});

		expect(completedMemo).toMatchObject({
			id: created.id,
			status: "completed",
			stage: "evidence_limitation_memo_ready",
			reportArtifactId: expect.any(String),
			completedAt: new Date("2026-05-05T10:20:00.000Z").getTime(),
			evidenceLimitationMemo: {
				title:
					"Evidence Limitation Memo: Assess unverified battery recycling claims",
				reviewedScope: {
					discoveredCount: 1,
					reviewedCount: 0,
					topicRelevantCount: 0,
					rejectedOrOffTopicCount: 0,
				},
				recoveryActions: [
					expect.objectContaining({ kind: "revise_plan" }),
					expect.objectContaining({ kind: "add_sources" }),
					expect.objectContaining({ kind: "choose_deeper_depth" }),
					expect.objectContaining({ kind: "targeted_follow_up" }),
				],
			},
		});
		expect(listedMemoJob).toMatchObject({
			id: created.id,
			evidenceLimitationMemo: completedMemo?.evidenceLimitationMemo,
		});
		expect(discussResult).toMatchObject({
			sourceJobId: created.id,
			reportArtifactId: completedMemo?.reportArtifactId,
			conversation: {
				title: "Discuss: Assess unverified battery recycling claims",
			},
			messageId: expect.any(String),
			seedMessage: expect.stringContaining("Evidence Limitation Memo"),
		});
		expect(researchFurtherResult).toMatchObject({
			sourceJobId: created.id,
			reportArtifactId: completedMemo?.reportArtifactId,
			conversation: {
				title: "Research further: Assess unverified battery recycling claims",
			},
			messageId: expect.any(String),
			seedMessage: expect.stringContaining("Evidence Limitation Memo"),
			job: {
				status: "awaiting_approval",
				stage: "plan_drafted",
				depth: "max",
			},
		});
		expect(completedMemo?.timeline).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					stage: "citation_audit",
					kind: "warning",
					summary:
						"Citation audit failed because no credible supported claims remained.",
					warnings: expect.arrayContaining([
						"Removed claim because it cited sources that were not both reviewed and cited: Battery recycling eliminated all supply risk in 2025.",
					]),
				}),
			]),
		);
		expect(memoArtifact).toMatchObject({
			id: completedMemo?.reportArtifactId,
			name: "Evidence Limitation Memo - Assess unverified battery recycling claims.md",
			type: "generated_output",
			retrievalClass: "durable",
			metadata: {
				deepResearchEvidenceLimitationMemo: true,
				deepResearchReport: false,
				deepResearchJobId: created.id,
				documentRole: "evidence_limitation_memo",
				memoRecoveryActions: [
					expect.objectContaining({ kind: "revise_plan" }),
					expect.objectContaining({ kind: "add_sources" }),
					expect.objectContaining({ kind: "choose_deeper_depth" }),
					expect.objectContaining({ kind: "targeted_follow_up" }),
				],
			},
		});
		expect(memoArtifact?.contentText).toContain("# Evidence Limitation Memo:");
		expect(memoArtifact?.contentText).not.toContain("# Research Report:");
		expect(memoArtifact?.contentText).toContain("## Reviewed Scope");
		expect(memoArtifact?.contentText).toContain("| Scope item | Count |");
		expect(memoArtifact?.contentText).toContain("| Discovered sources | 1 |");
		expect(memoArtifact?.contentText).toContain("| Reviewed sources | 0 |");
		expect(memoArtifact?.contentText).toContain(
			"| Topic-relevant reviewed sources | 0 |",
		);
		expect(memoArtifact?.contentText).toContain(
			"## Grounded Limitation Reasons",
		);
		expect(memoArtifact?.contentText).toContain("## Recovery Actions");
		expect(memoArtifact?.contentText).toContain(
			"## Appendix: Source Ledger Detail",
		);
		expect(conversation).toEqual({
			status: "open",
			sealedAt: null,
		});
		expect(generatedArtifacts).toEqual([
			{ id: completedMemo?.reportArtifactId },
		]);
		expect(sources).toEqual([
			expect.objectContaining({
				id: source.id,
				status: "discovered",
				reviewedAt: null,
				citedAt: null,
			}),
		]);
	});

	it("preserves a running job cancellation that lands during audited report finalization", async () => {
		const { db } = await import("$lib/server/db");
		let cancelledDuringReportAssembly = false;
		let activeJobId: string | null = null;
		vi.doMock("./llm-steps", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./llm-steps")>();
			return {
				...actual,
				writeResearchReportWithLlm: async (
					input: Parameters<typeof actual.writeResearchReportWithLlm>[0],
				) => {
					if (activeJobId && !cancelledDuringReportAssembly) {
						cancelledDuringReportAssembly = true;
						await db
							.update(schema.deepResearchJobs)
							.set({
								status: "cancelled",
								stage: "cancelled_by_request",
								cancelledAt: new Date("2026-05-05T10:19:00.000Z"),
								updatedAt: new Date("2026-05-05T10:19:00.000Z"),
							})
							.where(eq(schema.deepResearchJobs.id, activeJobId));
					}
					return actual.writeResearchReportWithLlm(input);
				},
			};
		});
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithAuditedReport,
			startDeepResearchJobShell,
		} = await import("./index");
		const { markResearchSourceReviewed, saveDiscoveredResearchSource } =
			await import("./sources");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Compare EU and US AI copyright training data rules",
			depth: "standard",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		activeJobId = created.id;
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await db
			.update(schema.deepResearchJobs)
			.set({
				status: "running",
				stage: "report_completion",
				updatedAt: new Date("2026-05-05T10:18:00.000Z"),
			})
			.where(eq(schema.deepResearchJobs.id, created.id));
		await seedCompletedMeaningfulPasses(created.id, 3);
		const source = await saveDiscoveredResearchSource({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: created.id,
			url: "https://agency.example.test/ai-copyright-training-data",
			title: "Agency AI copyright training data briefing",
			provider: "public_web",
			snippet: "Agency briefing on AI copyright training data rules.",
			discoveredAt: new Date("2026-05-05T10:07:00.000Z"),
		});
		const reviewedSource = await markResearchSourceReviewed({
			userId: "user-1",
			sourceId: source.id,
			reviewedAt: new Date("2026-05-05T10:08:00.000Z"),
			reviewedNote:
				"EU and US AI copyright training data rules require provenance records and rights-risk review.",
		});

		const result = await completeDeepResearchJobWithAuditedReport({
			userId: "user-1",
			jobId: created.id,
			synthesisNotes: buildSynthesisNotes(created.id, [
				{
					statement:
						"EU and US AI copyright training data rules require provenance records and rights-risk review.",
					sourceId: reviewedSource.id,
					url: reviewedSource.url,
					title: reviewedSource.title ?? "Agency briefing",
				},
			]),
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const [storedJob] = await db
			.select({
				status: schema.deepResearchJobs.status,
				stage: schema.deepResearchJobs.stage,
				reportArtifactId: schema.deepResearchJobs.reportArtifactId,
				completedAt: schema.deepResearchJobs.completedAt,
				cancelledAt: schema.deepResearchJobs.cancelledAt,
			})
			.from(schema.deepResearchJobs)
			.where(eq(schema.deepResearchJobs.id, created.id));
		const [conversation] = await db
			.select({
				status: schema.conversations.status,
				sealedAt: schema.conversations.sealedAt,
			})
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conv-1"));
		const generatedArtifacts = await db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));

		expect(cancelledDuringReportAssembly).toBe(true);
		expect(result).toMatchObject({
			id: created.id,
			status: "cancelled",
			stage: "cancelled_by_request",
			reportArtifactId: null,
			completedAt: null,
			cancelledAt: new Date("2026-05-05T10:19:00.000Z").getTime(),
		});
		expect(storedJob).toEqual({
			status: "cancelled",
			stage: "cancelled_by_request",
			reportArtifactId: null,
			completedAt: null,
			cancelledAt: new Date("2026-05-05T10:19:00.000Z"),
		});
		expect(conversation).toEqual({
			status: "open",
			sealedAt: null,
		});
		expect(generatedArtifacts).toEqual([]);
	});

	it("preserves a running job cancellation that lands during Evidence Limitation Memo finalization", async () => {
		const { db } = await import("$lib/server/db");
		let cancelledDuringMemoAssembly = false;
		let activeJobId: string | null = null;
		vi.doMock("./report-writer", async (importOriginal) => {
			const actual = await importOriginal<typeof import("./report-writer")>();
			return {
				...actual,
				writeEvidenceLimitationMemo: (
					input: Parameters<typeof actual.writeEvidenceLimitationMemo>[0],
				) => {
					if (activeJobId && !cancelledDuringMemoAssembly) {
						cancelledDuringMemoAssembly = true;
						db.update(schema.deepResearchJobs)
							.set({
								status: "cancelled",
								stage: "cancelled_by_request",
								cancelledAt: new Date("2026-05-05T10:19:00.000Z"),
								updatedAt: new Date("2026-05-05T10:19:00.000Z"),
							})
							.where(eq(schema.deepResearchJobs.id, activeJobId))
							.run();
					}
					return actual.writeEvidenceLimitationMemo(input);
				},
			};
		});
		const {
			approveDeepResearchPlan,
			completeDeepResearchJobWithEvidenceLimitationMemo,
			startDeepResearchJobShell,
		} = await import("./index");

		const created = await startDeepResearchJobShell({
			userId: "user-1",
			conversationId: "conv-1",
			triggerMessageId: "user-msg-1",
			userRequest: "Assess unverified battery recycling claims",
			depth: "focused",
			now: new Date("2026-05-05T10:01:00.000Z"),
		});
		activeJobId = created.id;
		await approveDeepResearchPlan({
			userId: "user-1",
			jobId: created.id,
			now: new Date("2026-05-05T10:06:00.000Z"),
		});
		await db
			.update(schema.deepResearchJobs)
			.set({
				status: "running",
				stage: "evidence_limitation_memo",
				updatedAt: new Date("2026-05-05T10:18:00.000Z"),
			})
			.where(eq(schema.deepResearchJobs.id, created.id));

		const result = await completeDeepResearchJobWithEvidenceLimitationMemo({
			userId: "user-1",
			jobId: created.id,
			limitations: ["No reviewed topic-relevant sources remained."],
			now: new Date("2026-05-05T10:20:00.000Z"),
		});
		const [storedJob] = await db
			.select({
				status: schema.deepResearchJobs.status,
				stage: schema.deepResearchJobs.stage,
				reportArtifactId: schema.deepResearchJobs.reportArtifactId,
				completedAt: schema.deepResearchJobs.completedAt,
				cancelledAt: schema.deepResearchJobs.cancelledAt,
			})
			.from(schema.deepResearchJobs)
			.where(eq(schema.deepResearchJobs.id, created.id));
		const generatedArtifacts = await db
			.select({ id: schema.artifacts.id })
			.from(schema.artifacts)
			.where(eq(schema.artifacts.type, "generated_output"));

		expect(cancelledDuringMemoAssembly).toBe(true);
		expect(result).toMatchObject({
			id: created.id,
			status: "cancelled",
			stage: "cancelled_by_request",
			reportArtifactId: null,
			completedAt: null,
			cancelledAt: new Date("2026-05-05T10:19:00.000Z").getTime(),
		});
		expect(storedJob).toEqual({
			status: "cancelled",
			stage: "cancelled_by_request",
			reportArtifactId: null,
			completedAt: null,
			cancelledAt: new Date("2026-05-05T10:19:00.000Z"),
		});
		expect(generatedArtifacts).toEqual([]);
	});
});

function buildSynthesisNotes(
	jobId: string,
	findings: Array<{
		statement: string;
		sourceId: string;
		url: string;
		title: string;
	}>,
): SynthesisNotes {
	const supportedFindings = findings.map((finding) => ({
		kind: "supported" as const,
		statement: finding.statement,
		sourceRefs: [
			{
				reviewedSourceId: finding.sourceId,
				discoveredSourceId: finding.sourceId,
				canonicalUrl: finding.url,
				title: finding.title,
			},
		],
	}));

	return {
		jobId,
		findings: supportedFindings,
		supportedFindings,
		conflicts: [],
		assumptions: [],
		reportLimitations: [],
	};
}
