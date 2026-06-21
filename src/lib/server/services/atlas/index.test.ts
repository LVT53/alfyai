import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

async function seedConversation() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-06-19T12:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "atlas@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Atlas conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

describe("Atlas persistence foundation", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-atlas-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		await seedConversation();
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

	it("creates or reuses queued jobs by the Atlas idempotency scope", async () => {
		const { submitAtlasJobIntake } = await import("./index");
		const first = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "in-depth",
			query: "  Compare AI search vendors for enterprise RAG.  ",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:01:00.000Z"),
		});
		const second = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "in-depth",
			query: "compare ai search vendors for enterprise rag",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:02:00.000Z"),
		});

		expect(first.reused).toBe(false);
		expect(second.reused).toBe(true);
		expect(second.job.id).toBe(first.job.id);
		expect(second.job).toMatchObject({
			conversationId: "conv-1",
			status: "queued",
			profile: "in-depth",
			action: "create",
			progress: {
				percent: 0,
				stage: "queued",
			},
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.atlasJobs);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			clientAtlasTurnId: "client-turn-1",
			status: "queued",
		});
		expect(rows[0]?.idempotencyKey).toContain("atlas:v1:");
		expect(rows[0]?.idempotencyKey).not.toContain("AI search vendors");
	});

	it("creates an instant deterministic visible title from the user query", async () => {
		const { submitAtlasJobIntake } = await import("./index");

		const result = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "in-depth",
			query:
				"  Compare AI search vendors for enterprise RAG adoption in regulated banks. Include risks.  ",
			clientAtlasTurnId: "client-turn-title",
			now: new Date("2026-06-19T12:01:00.000Z"),
		});

		expect(result.job.title).toBe(
			"Compare AI search vendors for enterprise RAG adoption in regulated banks",
		);
		expect(result.job.title).not.toBe("Atlas research");
	});

	it("applies a model-generated Atlas title through the job ledger and read model", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:05:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-generated-title",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-generated-title",
			clientAtlasTurnId: "client-generated-title",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:overview:hash-generated-title:client-generated-title",
			title: "Query Derived Fallback",
			status: "running",
			stage: "assemble",
			workerId: "worker-title",
			heartbeatAt: now,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});

		const { applyAtlasGeneratedTitle, listConversationAtlasJobs } =
			await import("./index");
		const updated = await applyAtlasGeneratedTitle({
			jobId: "atlas-generated-title",
			workerId: "worker-title",
			title: "  Generated Enterprise RAG Strategy  ",
			now: new Date("2026-06-19T12:06:00.000Z"),
		});
		const jobs = await listConversationAtlasJobs("user-1", "conv-1");

		expect(updated?.title).toBe("Generated Enterprise RAG Strategy");
		expect(jobs[0]).toMatchObject({
			id: "atlas-generated-title",
			title: "Generated Enterprise RAG Strategy",
		});
	});

	it("repairs a reused legacy default Atlas title from the user query", async () => {
		const { submitAtlasJobIntake } = await import("./index");
		const input = {
			userId: "user-1",
			conversationId: "conv-1",
			action: "create" as const,
			parentAtlasJobId: null,
			profile: "overview" as const,
			query: "Map durable memory architectures for enterprise assistants.",
			clientAtlasTurnId: "client-turn-legacy-title",
		};
		const stale = await submitAtlasJobIntake({
			...input,
			title: "Atlas research",
			now: new Date("2026-06-19T12:01:00.000Z"),
		});

		const reused = await submitAtlasJobIntake({
			...input,
			now: new Date("2026-06-19T12:02:00.000Z"),
		});

		expect(reused.reused).toBe(true);
		expect(reused.job.id).toBe(stale.job.id);
		expect(reused.job.title).toBe(
			"Map durable memory architectures for enterprise assistants",
		);
	});

	it("creates a new job when one idempotency scope field changes", async () => {
		const { submitAtlasJobIntake } = await import("./index");
		const baseInput = {
			userId: "user-1",
			conversationId: "conv-1",
			action: "create" as const,
			parentAtlasJobId: null,
			query: "Compare AI search vendors",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:01:00.000Z"),
		};

		const overview = await submitAtlasJobIntake({
			...baseInput,
			profile: "overview",
		});
		const exhaustive = await submitAtlasJobIntake({
			...baseInput,
			profile: "exhaustive",
		});

		expect(exhaustive.reused).toBe(false);
		expect(exhaustive.job.id).not.toBe(overview.job.id);

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.atlasJobs);
		expect(rows).toHaveLength(2);
	});

	it("scopes Atlas idempotency by lifecycle action and parent job", async () => {
		const { submitAtlasJobIntake } = await import("./index");
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:02:00.000Z");
		await db.insert(schema.atlasJobs).values([
			{
				id: "parent-atlas-1",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-parent-1",
				clientAtlasTurnId: "parent-turn-1",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-parent-1:parent-turn-1",
				title: "Parent Atlas 1",
				status: "succeeded",
				stage: "audit",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "parent-atlas-2",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-parent-2",
				clientAtlasTurnId: "parent-turn-2",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-parent-2:parent-turn-2",
				title: "Parent Atlas 2",
				status: "succeeded",
				stage: "audit",
				createdAt: now,
				updatedAt: now,
			},
		]);
		const baseInput = {
			userId: "user-1",
			conversationId: "conv-1",
			profile: "overview" as const,
			query: "Extend the Atlas report",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:02:30.000Z"),
		};

		const continued = await submitAtlasJobIntake({
			...baseInput,
			action: "continue",
			parentAtlasJobId: "parent-atlas-1",
		});
		const revisedSameParent = await submitAtlasJobIntake({
			...baseInput,
			action: "revise",
			parentAtlasJobId: "parent-atlas-1",
		});
		const continuedOtherParent = await submitAtlasJobIntake({
			...baseInput,
			action: "continue",
			parentAtlasJobId: "parent-atlas-2",
		});
		const reused = await submitAtlasJobIntake({
			...baseInput,
			action: "continue",
			parentAtlasJobId: "parent-atlas-1",
		});

		expect(reused.reused).toBe(true);
		expect(reused.job.id).toBe(continued.job.id);
		expect(revisedSameParent.job.id).not.toBe(continued.job.id);
		expect(continuedOtherParent.job.id).not.toBe(continued.job.id);

		const rows = await db.select().from(schema.atlasJobs);
		expect(rows).toHaveLength(5);
	});

	it("derives same-family and fork lifecycle seeds from the parent checkpoint", async () => {
		const { submitAtlasJobIntake } = await import("./index");
		const { buildAtlasLifecycleContext, writeAtlasRoundCheckpoint } =
			await import("./checkpoints");
		const parent = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "Original Atlas report",
			clientAtlasTurnId: "parent-turn",
			now: new Date("2026-06-19T12:03:00.000Z"),
		});
		await writeAtlasRoundCheckpoint({
			jobId: parent.job.id,
			roundNumber: 1,
			stage: "audit",
			checkpoint: { assembledMarkdown: "Original report" },
			curatedSourcePool: {
				local: [{ id: "local-1", title: "Local source", text: "source text" }],
				web: [{ id: "web-1", title: "Web source" }],
			},
			compressedFindings: { synthesize: "Compressed parent findings" },
			documentSourceSummary: {
				title: "Original Atlas report",
				atlasFamily: {
					familyId: "atlas-family-root",
					mode: "new_family",
					action: "create",
					rootAtlasJobId: parent.job.id,
					currentAtlasJobId: parent.job.id,
					parentAtlasJobId: null,
					forkedFromAtlasJobId: null,
				},
			},
			now: new Date("2026-06-19T12:04:00.000Z"),
		});
		const continued = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "continue",
			parentAtlasJobId: parent.job.id,
			profile: "overview",
			query: "Continue the report",
			clientAtlasTurnId: "continue-turn",
			now: new Date("2026-06-19T12:05:00.000Z"),
		});
		const forked = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "fork",
			parentAtlasJobId: parent.job.id,
			profile: "overview",
			query: "Fork the report",
			clientAtlasTurnId: "fork-turn",
			now: new Date("2026-06-19T12:06:00.000Z"),
		});

		const continueLifecycle = await buildAtlasLifecycleContext({
			jobId: continued.job.id,
			userId: "user-1",
			action: "continue",
			parentAtlasJobId: parent.job.id,
		});
		const forkLifecycle = await buildAtlasLifecycleContext({
			jobId: forked.job.id,
			userId: "user-1",
			action: "fork",
			parentAtlasJobId: parent.job.id,
		});

		expect(continueLifecycle).toMatchObject({
			family: {
				familyId: "atlas-family-root",
				mode: "same_family",
				action: "continue",
				rootAtlasJobId: parent.job.id,
				currentAtlasJobId: continued.job.id,
				parentAtlasJobId: parent.job.id,
				forkedFromAtlasJobId: null,
			},
			seed: {
				parentAtlasJobId: parent.job.id,
				compressedFindings: { synthesize: "Compressed parent findings" },
				curatedSourcePool: {
					local: [
						{ id: "local-1", title: "Local source", text: "source text" },
					],
					web: [{ id: "web-1", title: "Web source" }],
				},
			},
		});
		expect(forkLifecycle).toMatchObject({
			family: {
				familyId: forked.job.id,
				mode: "new_family",
				action: "fork",
				rootAtlasJobId: forked.job.id,
				currentAtlasJobId: forked.job.id,
				parentAtlasJobId: parent.job.id,
				forkedFromAtlasJobId: parent.job.id,
			},
			seed: {
				parentAtlasJobId: parent.job.id,
				compressedFindings: { synthesize: "Compressed parent findings" },
				curatedSourcePool: null,
			},
		});
	});

	it("uses same-family parent curated local sources as worker auto sources", async () => {
		const { resolveAtlasSourcesForJob } = await import("./sources");

		const result = await resolveAtlasSourcesForJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: null,
			lifecycleSeed: {
				parentAtlasJobId: "atlas-parent-1",
				compressedFindings: { synthesize: "Prior findings" },
				curatedSourcePool: {
					local: [
						{
							id: "local-1",
							title: "Parent local source",
							text: "Parent source text",
						},
					],
					web: [{ id: "web-1", title: "Parent web source" }],
				},
				checkpoint: {},
				documentSourceSummary: {},
			},
		});

		expect(result.localSources).toEqual([
			{
				id: "parent:atlas-parent-1:local-1",
				title: "Parent local source",
				authority: "auto",
				text: "Parent source text",
			},
		]);
	});

	it("excludes generated outputs from automatic Atlas working-document sources", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:10:00.000Z");
		await db.insert(schema.messages).values([
			{
				id: "atlas-source-user",
				conversationId: "conv-1",
				messageSequence: 1,
				role: "user",
				content:
					"Use the baseline result and evidence memo for this Atlas run.",
				createdAt: now,
			},
			{
				id: "atlas-source-assistant",
				conversationId: "conv-1",
				messageSequence: 2,
				role: "assistant",
				content: "Starting Atlas.",
				createdAt: new Date("2026-06-19T12:10:01.000Z"),
			},
		]);
		await db.insert(schema.artifacts).values([
			{
				id: "generated-atlas-result",
				userId: "user-1",
				conversationId: "conv-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Baseline result",
				contentText:
					"Prior generated Atlas output that should not be auto-treated as evidence.",
				summary: "Baseline result",
				metadataJson: JSON.stringify({ generatedFile: true }),
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "evidence-memo",
				userId: "user-1",
				conversationId: "conv-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Evidence memo",
				contentText: "Human-provided evidence memo for Atlas grounding.",
				summary: "Evidence memo",
				createdAt: now,
				updatedAt: now,
			},
		]);
		await db.insert(schema.conversationWorkingSetItems).values([
			{
				id: "working-generated-atlas-result",
				userId: "user-1",
				conversationId: "conv-1",
				artifactId: "generated-atlas-result",
				artifactType: "generated_output",
				score: 100,
				state: "active",
				reasonCodesJson: JSON.stringify(["matched_current_turn"]),
				lastActivatedAt: now,
				lastUsedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "working-evidence-memo",
				userId: "user-1",
				conversationId: "conv-1",
				artifactId: "evidence-memo",
				artifactType: "source_document",
				score: 100,
				state: "active",
				reasonCodesJson: JSON.stringify(["matched_current_turn"]),
				lastActivatedAt: now,
				lastUsedAt: now,
				createdAt: now,
				updatedAt: now,
			},
		]);

		const { resolveAtlasSourcesForJob } = await import("./sources");
		const result = await resolveAtlasSourcesForJob({
			userId: "user-1",
			conversationId: "conv-1",
			assistantMessageId: "atlas-source-assistant",
			lifecycleSeed: null,
		});

		expect(result.localSources).toEqual([
			expect.objectContaining({
				id: "evidence-memo",
				title: "Evidence memo",
				authority: "working_document",
			}),
		]);
		expect(result.localSources).not.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: "generated-atlas-result" }),
			]),
		);
	});

	it("returns polling-safe Atlas job cards without raw internal metadata", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:03:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-job-1",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "exhaustive",
			normalizedQueryHash: "hash-1",
			clientAtlasTurnId: "client-turn-1",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:exhaustive:hash-1:client-turn-1",
			title: "Atlas research",
			status: "failed",
			stage: "audit",
			progressPercent: 80,
			localSourceCount: 2,
			webSourceCount: 7,
			acceptedSourceCount: 6,
			rejectedSourceCount: 3,
			inputTokens: 1000,
			outputTokens: 2000,
			totalTokens: 3000,
			costUsdMicros: 4567,
			errorCode: "atlas_audit_failed",
			errorMessage: "Audit failed after bounded retries.",
			errorRetryable: true,
			failureMetadataJson:
				'{"rawPrompt":"SYSTEM_SENTINEL","apiKey":"SECRET_SENTINEL"}',
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.atlasRoundCheckpoints).values({
			id: "checkpoint-1",
			jobId: "atlas-job-1",
			roundNumber: 1,
			checkpointVersion: 1,
			stage: "audit",
			checkpointJson: '{"rawPrompt":"SYSTEM_SENTINEL"}',
			curatedSourcePoolJson: "[]",
			compressedFindingsJson: "{}",
			usageJson: "{}",
			qualityDiagnosticsJson: "{}",
			documentSourceSummaryJson: "{}",
			createdAt: now,
			updatedAt: now,
		});

		const { listConversationAtlasJobs } = await import("./read-model");
		const jobs = await listConversationAtlasJobs("user-1", "conv-1");

		expect(jobs).toEqual([
			{
				id: "atlas-job-1",
				conversationId: "conv-1",
				assistantMessageId: null,
				action: "create",
				parentAtlasJobId: null,
				profile: "exhaustive",
				title: "Atlas research",
				status: "failed",
				stage: "audit",
				progress: {
					percent: 80,
					stage: "audit",
					details: { queries: [] },
				},
				sourceCounts: {
					local: 2,
					web: 7,
					accepted: 6,
					rejected: 3,
				},
				usage: {
					inputTokens: 1000,
					outputTokens: 2000,
					totalTokens: 3000,
					costUsdMicros: 4567,
				},
				outputs: {
					fileProductionJobId: null,
					htmlChatGeneratedFileId: null,
					pdfChatGeneratedFileId: null,
					markdownChatGeneratedFileId: null,
				},
				error: {
					code: "atlas_audit_failed",
					message: "Audit failed after bounded retries.",
					retryable: true,
				},
				createdAt: now.getTime(),
				updatedAt: now.getTime(),
				completedAt: null,
			},
		]);
		expect(JSON.stringify(jobs)).not.toContain("SYSTEM_SENTINEL");
		expect(JSON.stringify(jobs)).not.toContain("SECRET_SENTINEL");
	});

	it("enforces one checkpoint per Atlas job and round number", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:04:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-job-1",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-1",
			clientAtlasTurnId: "client-turn-1",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:overview:hash-1:client-turn-1",
			title: "Atlas research",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.atlasRoundCheckpoints).values({
			id: "checkpoint-1",
			jobId: "atlas-job-1",
			roundNumber: 1,
			checkpointVersion: 1,
			stage: "integrate",
			checkpointJson: "{}",
			curatedSourcePoolJson: "[]",
			compressedFindingsJson: "{}",
			usageJson: "{}",
			qualityDiagnosticsJson: "{}",
			documentSourceSummaryJson: "{}",
			createdAt: now,
			updatedAt: now,
		});

		expect(() =>
			db
				.insert(schema.atlasRoundCheckpoints)
				.values({
					id: "checkpoint-duplicate",
					jobId: "atlas-job-1",
					roundNumber: 1,
					checkpointVersion: 1,
					stage: "integrate",
					checkpointJson: "{}",
					curatedSourcePoolJson: "[]",
					compressedFindingsJson: "{}",
					usageJson: "{}",
					qualityDiagnosticsJson: "{}",
					documentSourceSummaryJson: "{}",
					createdAt: now,
					updatedAt: now,
				})
				.run(),
		).toThrow();
	});

	it("links the finalized assistant message to a reused Atlas job", async () => {
		const { submitAtlasJobIntake, linkAtlasJobAssistantMessage } = await import(
			"./index"
		);
		const first = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "Map the RAG vendor landscape.",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:05:00.000Z"),
		});
		const { db } = await import("$lib/server/db");
		await db.insert(schema.messages).values({
			id: "assistant-msg-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Atlas is queued.",
			createdAt: new Date("2026-06-19T12:05:30.000Z"),
		});

		const linked = await linkAtlasJobAssistantMessage({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: first.job.id,
			assistantMessageId: "assistant-msg-1",
			now: new Date("2026-06-19T12:06:00.000Z"),
		});
		const reused = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "map the rag vendor landscape",
			clientAtlasTurnId: "client-turn-1",
			now: new Date("2026-06-19T12:07:00.000Z"),
		});

		expect(linked.assistantMessageId).toBe("assistant-msg-1");
		expect(reused.reused).toBe(true);
		expect(reused.job.id).toBe(first.job.id);
		expect(reused.job.assistantMessageId).toBe("assistant-msg-1");
	});

	it("claims queued jobs with global and per-user concurrency limits, heartbeats, cancellation, and stale recovery", async () => {
		const { db } = await import("$lib/server/db");
		const {
			cancelAtlasJob,
			claimNextAtlasJob,
			heartbeatAtlasJob,
			linkAtlasJobAssistantMessage,
			listConversationAtlasJobs,
			recoverStaleAtlasJobs,
			submitAtlasJobIntake,
		} = await import("./index");
		await db.insert(schema.conversations).values({
			id: "conv-2",
			userId: "user-1",
			title: "Second Atlas conversation",
			createdAt: new Date("2026-06-19T12:00:00.000Z"),
			updatedAt: new Date("2026-06-19T12:00:00.000Z"),
		});

		const first = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "First query",
			clientAtlasTurnId: "atlas-turn-1",
			now: new Date("2026-06-19T12:01:00.000Z"),
		});
		const secondSameUser = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-2",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "Second query",
			clientAtlasTurnId: "atlas-turn-2",
			now: new Date("2026-06-19T12:02:00.000Z"),
		});
		await db.insert(schema.messages).values([
			{
				id: "atlas-user-1",
				conversationId: "conv-1",
				role: "user",
				content: "First query",
				messageSequence: 1,
				createdAt: new Date("2026-06-19T12:01:00.000Z"),
			},
			{
				id: "atlas-assistant-1",
				conversationId: "conv-1",
				role: "assistant",
				content: "Atlas is queued.",
				messageSequence: 2,
				createdAt: new Date("2026-06-19T12:01:01.000Z"),
			},
			{
				id: "atlas-user-2",
				conversationId: "conv-2",
				role: "user",
				content: "Second query",
				messageSequence: 1,
				createdAt: new Date("2026-06-19T12:02:00.000Z"),
			},
			{
				id: "atlas-assistant-2",
				conversationId: "conv-2",
				role: "assistant",
				content: "Atlas is queued.",
				messageSequence: 2,
				createdAt: new Date("2026-06-19T12:02:01.000Z"),
			},
		]);
		await linkAtlasJobAssistantMessage({
			userId: "user-1",
			conversationId: "conv-1",
			jobId: first.job.id,
			assistantMessageId: "atlas-assistant-1",
		});
		await linkAtlasJobAssistantMessage({
			userId: "user-1",
			conversationId: "conv-2",
			jobId: secondSameUser.job.id,
			assistantMessageId: "atlas-assistant-2",
		});

		const firstClaim = await claimNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T12:03:00.000Z"),
			globalActiveLimit: 2,
			perUserActiveLimit: 1,
		});
		const blockedByPerUserLimit = await claimNextAtlasJob({
			workerId: "atlas-worker-1",
			now: new Date("2026-06-19T12:04:00.000Z"),
			globalActiveLimit: 2,
			perUserActiveLimit: 1,
		});

		expect(firstClaim?.job).toMatchObject({
			id: first.job.id,
			status: "running",
			stage: "decompose",
			progress: { percent: 5, stage: "decompose", details: { queries: [] } },
		});
		expect(blockedByPerUserLimit).toBeNull();

		await heartbeatAtlasJob({
			jobId: first.job.id,
			workerId: "atlas-worker-1",
			stage: "search",
			progressPercent: 20,
			progressDetails: {
				queries: ["enterprise retrieval patterns", "hybrid search evaluation"],
			},
			now: new Date("2026-06-19T12:05:00.000Z"),
		});
		const [jobAfterHeartbeat] = await listConversationAtlasJobs(
			"user-1",
			"conv-1",
		);
		expect(jobAfterHeartbeat.progress).toMatchObject({
			percent: 20,
			stage: "search",
			details: {
				queries: ["enterprise retrieval patterns", "hybrid search evaluation"],
			},
		});
		await cancelAtlasJob({
			userId: "user-1",
			jobId: secondSameUser.job.id,
			now: new Date("2026-06-19T12:06:00.000Z"),
		});
		const recovered = await recoverStaleAtlasJobs({
			staleBefore: new Date("2026-06-19T12:05:30.000Z"),
			now: new Date("2026-06-19T12:16:00.000Z"),
		});

		const rows = await db.select().from(schema.atlasJobs);
		expect(recovered).toEqual({ recovered: 1 });
		expect(rows.find((row) => row.id === first.job.id)).toMatchObject({
			status: "queued",
			stage: "queued",
			workerId: null,
			progressPercent: 0,
			errorCode: "atlas_worker_heartbeat_timeout",
			errorRetryable: true,
		});
		expect(rows.find((row) => row.id === secondSameUser.job.id)).toMatchObject({
			status: "cancelled",
			cancelRequestedAt: new Date("2026-06-19T12:06:00.000Z"),
		});
	});

	it("preserves heartbeat stage and percent when omitted while storing sanitized progress details", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:20:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-heartbeat-sanitize",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-heartbeat-sanitize",
			clientAtlasTurnId: "client-heartbeat-sanitize",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:overview:hash-heartbeat-sanitize:client-heartbeat-sanitize",
			title: "Heartbeat Sanitizer",
			status: "running",
			stage: "search",
			progressPercent: 42,
			progressDetailsJson: JSON.stringify({
				queries: ["old query"],
				focus: ["old focus"],
			}),
			workerId: "worker-heartbeat",
			heartbeatAt: now,
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const { heartbeatAtlasJob } = await import("./index");

		const alive = await heartbeatAtlasJob({
			jobId: "atlas-heartbeat-sanitize",
			workerId: "worker-heartbeat",
			progressDetails: {
				queries: [
					"  durable RAG adoption query  ",
					"Fetched page excerpt: raw page text should not persist",
				],
				roundKind: "gap-fill",
				focus: [
					" source reliability gaps ",
					"Evidence pack: raw source text should not persist",
				],
			},
			now: new Date("2026-06-19T12:21:00.000Z"),
		});

		const [row] = await db
			.select()
			.from(schema.atlasJobs)
			.where(eq(schema.atlasJobs.id, "atlas-heartbeat-sanitize"));
		const persistedDetails = JSON.parse(row?.progressDetailsJson ?? "{}");
		expect(alive).toBe(true);
		expect(row).toMatchObject({
			stage: "search",
			progressPercent: 42,
		});
		expect(persistedDetails).toEqual({
			queries: ["durable RAG adoption query"],
			roundKind: "gap-fill",
			focus: ["source reliability gaps"],
		});
		expect(row?.progressDetailsJson).not.toContain("Fetched page excerpt");
		expect(row?.progressDetailsJson).not.toContain("Evidence pack");
	});

	it("defaults missing completion usage and source counters to zero", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T12:30:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-complete-defaults",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-complete-defaults",
			clientAtlasTurnId: "client-complete-defaults",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:overview:hash-complete-defaults:client-complete-defaults",
			title: "Complete Defaults",
			status: "running",
			stage: "synthesize",
			progressPercent: 75,
			workerId: "worker-complete",
			heartbeatAt: now,
			startedAt: now,
			inputTokens: 11,
			outputTokens: 12,
			totalTokens: 23,
			costUsdMicros: 450,
			localSourceCount: 2,
			webSourceCount: 3,
			acceptedSourceCount: 4,
			rejectedSourceCount: 5,
			createdAt: now,
			updatedAt: now,
		});
		const { completeAtlasJob } = await import("./index");

		const completed = await completeAtlasJob({
			jobId: "atlas-complete-defaults",
			workerId: "worker-complete",
			now: new Date("2026-06-19T12:31:00.000Z"),
		});

		expect(completed).toMatchObject({
			status: "succeeded",
			stage: "audit",
			progress: { percent: 100 },
			usage: {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				costUsdMicros: 0,
			},
			sourceCounts: {
				local: 0,
				web: 0,
				accepted: 0,
				rejected: 0,
			},
		});
	});

	it("cancels active Atlas jobs for a user without touching completed jobs", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T13:00:00.000Z");
		await db.insert(schema.atlasJobs).values([
			{
				id: "atlas-queued",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-queued",
				clientAtlasTurnId: "client-queued",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-queued:client-queued",
				title: "Queued Atlas",
				status: "queued",
				stage: "queued",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "atlas-running",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-running",
				clientAtlasTurnId: "client-running",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-running:client-running",
				title: "Running Atlas",
				status: "running",
				stage: "search",
				workerId: "worker-1",
				heartbeatAt: now,
				startedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "atlas-succeeded",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-succeeded",
				clientAtlasTurnId: "client-succeeded",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-succeeded:client-succeeded",
				title: "Completed Atlas",
				status: "succeeded",
				stage: "complete",
				completedAt: now,
				createdAt: now,
				updatedAt: now,
			},
		]);

		const { cancelActiveAtlasJobsForUser } = await import("./index");
		const result = await cancelActiveAtlasJobsForUser("user-1", now);

		expect(result).toEqual({ cancelled: 2 });
		const rows = await db
			.select({
				id: schema.atlasJobs.id,
				status: schema.atlasJobs.status,
				stage: schema.atlasJobs.stage,
				workerId: schema.atlasJobs.workerId,
				cancelRequestedAt: schema.atlasJobs.cancelRequestedAt,
				completedAt: schema.atlasJobs.completedAt,
			})
			.from(schema.atlasJobs)
			.orderBy(schema.atlasJobs.id);
		expect(rows).toEqual([
			{
				id: "atlas-queued",
				status: "cancelled",
				stage: "cancelled",
				workerId: null,
				cancelRequestedAt: now,
				completedAt: now,
			},
			{
				id: "atlas-running",
				status: "cancelled",
				stage: "cancelled",
				workerId: null,
				cancelRequestedAt: now,
				completedAt: now,
			},
			{
				id: "atlas-succeeded",
				status: "succeeded",
				stage: "complete",
				workerId: null,
				cancelRequestedAt: null,
				completedAt: now,
			},
		]);
	});

	it("does not recover a cancelled running job as resumable partial state", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T13:15:00.000Z");
		await db.insert(schema.atlasJobs).values({
			id: "atlas-running-cancel",
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-running-cancel",
			clientAtlasTurnId: "client-running-cancel",
			idempotencyKey:
				"atlas:v1:user-1:conv-1:create:root:overview:hash-running-cancel:client-running-cancel",
			title: "Running Atlas",
			status: "running",
			stage: "synthesize",
			workerId: "worker-1",
			heartbeatAt: new Date("2026-06-19T13:00:00.000Z"),
			startedAt: new Date("2026-06-19T13:00:00.000Z"),
			createdAt: now,
			updatedAt: now,
		});
		const { cancelAtlasJob, recoverStaleAtlasJobs } = await import("./index");

		await cancelAtlasJob({
			userId: "user-1",
			jobId: "atlas-running-cancel",
			now: new Date("2026-06-19T13:16:00.000Z"),
		});
		const recovered = await recoverStaleAtlasJobs({
			staleBefore: new Date("2026-06-19T13:30:00.000Z"),
			now: new Date("2026-06-19T13:31:00.000Z"),
		});

		const [row] = await db
			.select()
			.from(schema.atlasJobs)
			.where(eq(schema.atlasJobs.id, "atlas-running-cancel"));
		expect(recovered).toEqual({ recovered: 0 });
		expect(row).toMatchObject({
			status: "cancelled",
			stage: "cancelled",
			workerId: null,
		});
	});

	it("keeps previous Atlas versions openable through the read model", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T13:20:00.000Z");
		await db.insert(schema.chatGeneratedFiles).values([
			{
				id: "file-parent-md",
				userId: "user-1",
				conversationId: "conv-1",
				filename: "parent.md",
				mimeType: "text/markdown",
				sizeBytes: 10,
				storagePath: "/tmp/parent.md",
				createdAt: now,
			},
			{
				id: "file-child-md",
				userId: "user-1",
				conversationId: "conv-1",
				filename: "child.md",
				mimeType: "text/markdown",
				sizeBytes: 12,
				storagePath: "/tmp/child.md",
				createdAt: now,
			},
		]);
		await db.insert(schema.fileProductionJobs).values([
			{
				id: "fp-parent",
				userId: "user-1",
				conversationId: "conv-1",
				title: "Parent Atlas",
				status: "succeeded",
				origin: "unified_produce",
				idempotencyKey: "atlas-output:atlas-parent",
				sourceMode: "document_source",
				documentIntent: "Atlas research report",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "fp-child",
				userId: "user-1",
				conversationId: "conv-1",
				title: "Child Atlas",
				status: "succeeded",
				origin: "unified_produce",
				idempotencyKey: "atlas-output:atlas-child",
				sourceMode: "document_source",
				documentIntent: "Atlas research report",
				createdAt: now,
				updatedAt: now,
			},
		]);
		await db.insert(schema.atlasJobs).values([
			{
				id: "atlas-parent",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-parent",
				clientAtlasTurnId: "client-parent",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-parent:client-parent",
				title: "Parent Atlas",
				status: "succeeded",
				stage: "audit",
				fileProductionJobId: "fp-parent",
				markdownChatGeneratedFileId: "file-parent-md",
				completedAt: now,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "atlas-child",
				userId: "user-1",
				conversationId: "conv-1",
				action: "continue",
				parentAtlasJobId: "atlas-parent",
				profile: "overview",
				normalizedQueryHash: "hash-child",
				clientAtlasTurnId: "client-child",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:continue:atlas-parent:overview:hash-child:client-child",
				title: "Child Atlas",
				status: "succeeded",
				stage: "audit",
				fileProductionJobId: "fp-child",
				markdownChatGeneratedFileId: "file-child-md",
				completedAt: new Date("2026-06-19T13:21:00.000Z"),
				createdAt: new Date("2026-06-19T13:21:00.000Z"),
				updatedAt: new Date("2026-06-19T13:21:00.000Z"),
			},
		]);

		const { listConversationAtlasJobs } = await import("./read-model");
		const jobs = await listConversationAtlasJobs("user-1", "conv-1");

		expect(jobs.map((job) => job.id)).toEqual(["atlas-child", "atlas-parent"]);
		expect(jobs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "atlas-parent",
					outputs: expect.objectContaining({
						fileProductionJobId: "fp-parent",
						markdownChatGeneratedFileId: "file-parent-md",
					}),
				}),
				expect.objectContaining({
					id: "atlas-child",
					parentAtlasJobId: "atlas-parent",
					outputs: expect.objectContaining({
						fileProductionJobId: "fp-child",
						markdownChatGeneratedFileId: "file-child-md",
					}),
				}),
			]),
		);
	});

	it("deletes Atlas jobs and round checkpoints for one conversation", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T13:30:00.000Z");
		await db.insert(schema.conversations).values({
			id: "conv-2",
			userId: "user-1",
			title: "Other Atlas conversation",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(schema.atlasJobs).values([
			{
				id: "atlas-delete",
				userId: "user-1",
				conversationId: "conv-1",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-delete",
				clientAtlasTurnId: "client-delete",
				idempotencyKey:
					"atlas:v1:user-1:conv-1:create:root:overview:hash-delete:client-delete",
				title: "Delete Atlas",
				status: "running",
				stage: "search",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "atlas-keep",
				userId: "user-1",
				conversationId: "conv-2",
				action: "create",
				profile: "overview",
				normalizedQueryHash: "hash-keep",
				clientAtlasTurnId: "client-keep",
				idempotencyKey:
					"atlas:v1:user-1:conv-2:create:root:overview:hash-keep:client-keep",
				title: "Keep Atlas",
				status: "queued",
				stage: "queued",
				createdAt: now,
				updatedAt: now,
			},
		]);
		await db.insert(schema.atlasRoundCheckpoints).values({
			id: "checkpoint-delete",
			jobId: "atlas-delete",
			roundNumber: 1,
			stage: "synthesize",
			checkpointJson: '{"raw":"private checkpoint"}',
			createdAt: now,
			updatedAt: now,
		});

		const { deleteAtlasJobsForConversation } = await import("./index");
		const result = await deleteAtlasJobsForConversation({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(result).toEqual({ deleted: 1 });
		const jobs = await db
			.select({ id: schema.atlasJobs.id })
			.from(schema.atlasJobs)
			.orderBy(schema.atlasJobs.id);
		const checkpoints = await db
			.select({ id: schema.atlasRoundCheckpoints.id })
			.from(schema.atlasRoundCheckpoints);
		expect(jobs).toEqual([{ id: "atlas-keep" }]);
		expect(checkpoints).toEqual([]);
	});
});
