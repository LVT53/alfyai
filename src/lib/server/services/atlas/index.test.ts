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
		vi.useRealTimers();
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
		const { db: serverDb } = await import("$lib/server/db");
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
		await serverDb
			.update(schema.atlasJobs)
			.set({ status: "succeeded", stage: "render" })
			.where(eq(schema.atlasJobs.id, parent.job.id));
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
			retryable: true,
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
				pipelineVersion: 1,
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

	it("cancels a queued Atlas job through the engine and leaves the others alone", async () => {
		const { db } = await import("$lib/server/db");
		const { cancelAtlasJob, submitAtlasJobIntake } = await import("./index");
		const first = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "First query",
			clientAtlasTurnId: "atlas-turn-1",
		});
		const second = await submitAtlasJobIntake({
			userId: "user-1",
			conversationId: "conv-1",
			action: "create",
			parentAtlasJobId: null,
			profile: "overview",
			query: "Second query",
			clientAtlasTurnId: "atlas-turn-2",
		});

		// Another user's Cancel finds nothing.
		expect(
			await cancelAtlasJob({ userId: "user-2", jobId: second.job.id }),
		).toBeNull();

		const cancelled = await cancelAtlasJob({
			userId: "user-1",
			jobId: second.job.id,
		});
		// A second press finds a settled job.
		const again = await cancelAtlasJob({
			userId: "user-1",
			jobId: second.job.id,
		});

		expect(cancelled).toMatchObject({
			id: second.job.id,
			status: "cancelled",
			stage: "cancelled",
			error: null,
		});
		expect(again).toBeNull();
		const rows = await db.select().from(schema.atlasJobs);
		const cancelledRow = rows.find((row) => row.id === second.job.id);
		expect(cancelledRow).toMatchObject({
			status: "cancelled",
			stage: "cancelled",
			workerId: null,
		});
		// The previous release's liveness stamp is the time of the cancel.
		expect(cancelledRow?.heartbeatAt).toEqual(cancelledRow?.updatedAt);
		expect(cancelledRow?.cancelRequestedAt).toBeInstanceOf(Date);
		expect(cancelledRow?.completedAt).toBeInstanceOf(Date);
		expect(rows.find((row) => row.id === first.job.id)).toMatchObject({
			status: "queued",
			stage: "queued",
			cancelRequestedAt: null,
		});
	});

	it("cancels active Atlas jobs for a user without touching completed jobs", async () => {
		const { db } = await import("$lib/server/db");
		const seededAt = new Date("2026-06-19T13:00:00.000Z");
		const cancelledAt = new Date("2026-06-19T13:05:00.000Z");
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
				createdAt: seededAt,
				updatedAt: seededAt,
			},
			{
				// A row the release before the engine left running: a job-level
				// worker id and no attempt. Cancel settles it all the same.
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
				heartbeatAt: seededAt,
				startedAt: seededAt,
				createdAt: seededAt,
				updatedAt: seededAt,
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
				completedAt: seededAt,
				createdAt: seededAt,
				updatedAt: seededAt,
			},
		]);

		const { cancelActiveAtlasJobsForUser } = await import("./index");
		// The engine stamps a cancel with the clock; fix it so the stamps can be read.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(cancelledAt);
		const result = await cancelActiveAtlasJobsForUser("user-1");
		vi.useRealTimers();

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
				cancelRequestedAt: cancelledAt,
				completedAt: cancelledAt,
			},
			{
				id: "atlas-running",
				status: "cancelled",
				stage: "cancelled",
				workerId: null,
				cancelRequestedAt: cancelledAt,
				completedAt: cancelledAt,
			},
			{
				id: "atlas-succeeded",
				status: "succeeded",
				stage: "complete",
				workerId: null,
				cancelRequestedAt: null,
				completedAt: seededAt,
			},
		]);
	});

	it("cancels a conversation's active Atlas jobs and no other conversation's", async () => {
		const { db } = await import("$lib/server/db");
		const now = new Date("2026-06-19T13:10:00.000Z");
		await db.insert(schema.conversations).values({
			id: "conv-2",
			userId: "user-1",
			title: "Second Atlas conversation",
			createdAt: now,
			updatedAt: now,
		});
		const job = (id: string, conversationId: string) => ({
			id,
			userId: "user-1",
			conversationId,
			action: "create",
			profile: "overview",
			normalizedQueryHash: `hash-${id}`,
			clientAtlasTurnId: `client-${id}`,
			idempotencyKey: `atlas:v1:${id}`,
			title: id,
			status: "queued",
			stage: "queued",
			createdAt: now,
			updatedAt: now,
		});
		await db
			.insert(schema.atlasJobs)
			.values([
				job("here-1", "conv-1"),
				job("here-2", "conv-1"),
				job("there", "conv-2"),
			]);

		const { cancelActiveAtlasJobsForConversation } = await import("./index");
		const result = await cancelActiveAtlasJobsForConversation({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(result).toEqual({ cancelled: 2 });
		const rows = await db
			.select({ id: schema.atlasJobs.id, status: schema.atlasJobs.status })
			.from(schema.atlasJobs)
			.orderBy(schema.atlasJobs.id);
		expect(rows).toEqual([
			{ id: "here-1", status: "cancelled" },
			{ id: "here-2", status: "cancelled" },
			{ id: "there", status: "queued" },
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
		const { cancelAtlasJob } = await import("./index");
		const { recover } = await import("$lib/server/services/jobs");
		const { atlasResearchJob } = await import("./research-job");

		await cancelAtlasJob({ userId: "user-1", jobId: "atlas-running-cancel" });
		// The sweep that takes back stale and lost attempts, as far in the future
		// as it can look: a cancelled job is not one of them.
		const recovered = await recover(atlasResearchJob, {
			staleBefore: new Date(Date.now() + 3_600_000),
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
