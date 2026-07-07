import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import bcrypt from "bcryptjs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const {
	mockQuiesceUserMemoryMaintenance,
	mockRequestActiveChatStreamsStopForUser,
} = vi.hoisted(() => ({
	mockQuiesceUserMemoryMaintenance: vi.fn(),
	mockRequestActiveChatStreamsStopForUser: vi.fn(),
}));

vi.mock("../memory-maintenance", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../memory-maintenance")>();
	return {
		...actual,
		quiesceUserMemoryMaintenance: mockQuiesceUserMemoryMaintenance,
	};
});

vi.mock("../chat-turn/active-streams", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../chat-turn/active-streams")>();
	return {
		...actual,
		requestActiveChatStreamsStopForUser:
			mockRequestActiveChatStreamsStopForUser,
	};
});

let dbPath: string;

function openMigratedDb() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedPrivacyUser() {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T10:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			name: "Privacy User",
			passwordHash: bcrypt.hashSync("correct-password", 4),
			role: "admin",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conversation-1",
			userId: "user-1",
			title: "Private chat",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "message-1",
			conversationId: "conversation-1",
			messageSequence: 1,
			role: "assistant",
			content: "Answer",
			metadataJson: JSON.stringify({
				evidenceStatus: "ready",
				evidenceSummary: { groups: [] },
			}),
			createdAt: now,
		})
		.run();
	db.insert(schema.conversationSummaries)
		.values({
			conversationId: "conversation-1",
			userId: "user-1",
			summary: "Private durable conversation summary.",
			source: "deterministic",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.artifacts)
		.values([
			{
				id: "knowledge-1",
				userId: "user-1",
				type: "source_document",
				retrievalClass: "durable",
				name: "Knowledge.pdf",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "normalized-1",
				userId: "user-1",
				type: "normalized_document",
				retrievalClass: "durable",
				name: "Knowledge text",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "skill-note-1",
				userId: "user-1",
				conversationId: "conversation-1",
				type: "skill_note",
				retrievalClass: "durable",
				name: "Skill note",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "work-capsule-1",
				userId: "user-1",
				conversationId: "conversation-1",
				type: "work_capsule",
				retrievalClass: "durable",
				name: "Work capsule",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "generated-1",
				userId: "user-1",
				conversationId: "conversation-1",
				type: "generated_output",
				retrievalClass: "durable",
				name: "Generated report",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	db.insert(schema.chatGeneratedFiles)
		.values({
			id: "file-1",
			conversationId: "conversation-1",
			assistantMessageId: "message-1",
			userId: "user-1",
			filename: "report.pdf",
			storagePath: "data/generated/report.pdf",
			createdAt: now,
		})
		.run();
	db.insert(schema.analyticsConversations)
		.values({
			id: "analytics-conversation-1",
			conversationId: "conversation-1",
			userId: "user-1",
			userEmail: "user@example.com",
			userName: "Privacy User",
			title: "Private chat",
			billingMonth: "2026-06",
			conversationCreatedAt: now,
			createdAt: now,
		})
		.run();
	db.insert(schema.usageEvents)
		.values({
			id: "usage-1",
			userId: "user-1",
			userEmail: "user@example.com",
			userName: "Privacy User",
			conversationId: "conversation-1",
			conversationTitle: "Private chat",
			messageId: "message-1",
			modelId: "model1",
			promptTokens: 10,
			completionTokens: 20,
			totalTokens: 30,
			billingMonth: "2026-06",
			costUsdMicros: 123,
			createdAt: now,
		})
		.run();
	db.insert(schema.conversationTaskStates)
		.values({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conversation-1",
			objective: "Remember context",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.taskStateEvidenceLinks)
		.values({
			id: "evidence-link-1",
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conversation-1",
			artifactId: "knowledge-1",
			role: "supporting",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.taskCheckpoints)
		.values({
			id: "checkpoint-1",
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conversation-1",
			checkpointType: "stable",
			content: "Remembered context",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProjects)
		.values({
			projectId: "memory-project-1",
			userId: "user-1",
			name: "Memory project",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProjectTaskLinks)
		.values({
			id: "memory-link-1",
			projectId: "memory-project-1",
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conversation-1",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryEvents)
		.values({
			id: "memory-event-1",
			eventKey: "memory-event-1",
			userId: "user-1",
			conversationId: "conversation-1",
			messageId: "message-1",
			domain: "task",
			eventType: "remembered",
			observedAt: now,
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({
			userId: "user-1",
			resetGeneration: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProjectionState)
		.values({
			id: "memory-projection-1",
			userId: "user-1",
			resetGeneration: 0,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProfileItems)
		.values({
			id: "memory-profile-item-1",
			userId: "user-1",
			projectionStateId: "memory-projection-1",
			resetGeneration: 0,
			itemKey:
				"memory-profile-item:v1:about_you:global:global:fixture-private-remembered-fact",
			category: "about_you",
			statement: "Private remembered fact.",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProfileItems)
		.values({
			id: "memory-profile-item-preserved-legacy",
			userId: "user-1",
			projectionStateId: "memory-projection-1",
			resetGeneration: 0,
			itemKey:
				"memory-profile-item:v1:about_you:global:global:fixture-preserved-legacy",
			category: "about_you",
			statement: "Preserved legacy memory.",
			status: "preserved_legacy",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryProfileItemProvenance)
		.values({
			id: "memory-provenance-1",
			itemId: "memory-profile-item-1",
			userId: "user-1",
			resetGeneration: 0,
			sourceType: "user_statement",
			sourceId: "message-1",
			label: "Chat",
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryReviewItems)
		.values({
			id: "memory-review-1",
			userId: "user-1",
			resetGeneration: 0,
			subjectKey: "private-subject",
			subjectLabel: "private subject",
			question: "What should be remembered?",
			reason: "Conflicting evidence.",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryReviewResolutions)
		.values({
			id: "memory-resolution-1",
			reviewItemId: "memory-review-1",
			userId: "user-1",
			resetGeneration: 0,
			resolutionType: "use_fact",
			createdAt: now,
		})
		.run();
	db.insert(schema.memoryDirtyLedger)
		.values({
			id: "memory-dirty-1",
			userId: "user-1",
			resetGeneration: 0,
			reason: "possible_conflict",
			firstMarkedAt: now,
			lastMarkedAt: now,
		})
		.run();
	db.insert(schema.memoryReworkTelemetry)
		.values({
			id: "memory-telemetry-1",
			userId: "user-1",
			resetGeneration: 0,
			eventFamily: "guided_review",
			eventName: "created",
			createdAt: now,
		})
		.run();
	db.insert(schema.conversationWorkingSetItems)
		.values({
			id: "working-set-1",
			userId: "user-1",
			conversationId: "conversation-1",
			artifactId: "knowledge-1",
			artifactType: "source_document",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationContextStatus)
		.values({
			conversationId: "conversation-1",
			userId: "user-1",
			updatedAt: now,
		})
		.run();
	db.insert(schema.semanticEmbeddings)
		.values({
			id: "embedding-1",
			userId: "user-1",
			subjectType: "artifact",
			subjectId: "knowledge-1",
			modelName: "tei",
			sourceTextHash: "hash",
			dimensions: 1,
			embeddingJson: "[0.1]",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function seedSharedContentOwnedByUser() {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T11:00:00.000Z");

	db.insert(schema.campaignAssets)
		.values({
			id: "asset-1",
			uploadedByUserId: "user-1",
			assetKind: "image",
			status: "ready",
			originalFilename: "hero.png",
			mimeType: "image/png",
			sizeBytes: 100,
			storagePath: "data/campaign-assets/hero.png",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.announcementCampaigns)
		.values({
			id: "campaign-1",
			type: "feature",
			status: "published",
			identityKey: "feature:2026-06",
			name: "Feature campaign",
			campaignVersion: "2026.06",
			revision: 1,
			createdByUserId: "user-1",
			publishedByUserId: "user-1",
			createdAt: now,
			updatedAt: now,
			publishedAt: now,
		})
		.run();
	db.insert(schema.announcementCampaignSnapshots)
		.values({
			id: "snapshot-1",
			campaignId: "campaign-1",
			identityKey: "feature:2026-06:published",
			type: "feature",
			name: "Feature campaign",
			campaignVersion: "2026.06",
			revision: 1,
			publishedByUserId: "user-1",
			publishedAt: now,
		})
		.run();
	db.insert(schema.userSkillDefinitions)
		.values({
			id: "system-skill-1",
			userId: "user-1",
			ownership: "system",
			skillKind: "user_skill",
			displayName: "System Skill",
			description: "Shared skill",
			instructions: "Do shared work.",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function seedOtherRealUser() {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T11:30:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-2",
			email: "other@example.com",
			name: "Other Real User",
			passwordHash: "hash",
			role: "user",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function seedRunningFileProductionWork() {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T12:00:00.000Z");

	db.insert(schema.fileProductionJobs)
		.values({
			id: "file-job-1",
			conversationId: "conversation-1",
			assistantMessageId: "message-1",
			userId: "user-1",
			title: "Private file",
			status: "running",
			currentAttemptId: "file-attempt-1",
			origin: "produce_file",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.fileProductionJobAttempts)
		.values({
			id: "file-attempt-1",
			jobId: "file-job-1",
			attemptNumber: 1,
			status: "running",
			workerId: "worker-1",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function seedAtlasLifecycleData(status: "running" | "succeeded" = "succeeded") {
	const { sqlite, db } = openMigratedDb();
	const now = new Date("2026-06-15T12:30:00.000Z");

	db.insert(schema.artifacts)
		.values({
			id: "atlas-generated-artifact-1",
			userId: "user-1",
			conversationId: "conversation-1",
			type: "generated_output",
			retrievalClass: "durable",
			name: "Atlas report source",
			contentText: "Readable Atlas report source.",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.chatGeneratedFiles)
		.values({
			id: "atlas-file-html-1",
			conversationId: "conversation-1",
			assistantMessageId: "message-1",
			userId: "user-1",
			filename: "atlas-report.html",
			mimeType: "text/html",
			sizeBytes: 42,
			storagePath: "conversation-1/atlas-report.html",
			createdAt: now,
		})
		.run();
	db.insert(schema.atlasJobs)
		.values({
			id: "atlas-job-1",
			userId: "user-1",
			conversationId: "conversation-1",
			assistantMessageId: "message-1",
			action: "create",
			profile: "overview",
			normalizedQueryHash: "hash-atlas",
			clientAtlasTurnId: "client-atlas-1",
			idempotencyKey:
				"atlas:v1:user-1:conversation-1:create:root:overview:hash-atlas:client-atlas-1",
			title: "Atlas report",
			status,
			stage: status === "running" ? "search" : "complete",
			workerId: status === "running" ? "worker-1" : null,
			startedAt: status === "running" ? now : null,
			completedAt: status === "succeeded" ? now : null,
			htmlChatGeneratedFileId: "atlas-file-html-1",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.atlasRoundCheckpoints)
		.values({
			id: "atlas-checkpoint-1",
			jobId: "atlas-job-1",
			roundNumber: 1,
			stage: "synthesize",
			checkpointJson: '{"raw":"private Atlas checkpoint"}',
			curatedSourcePoolJson: '[{"raw":"private source"}]',
			compressedFindingsJson: '{"raw":"private findings"}',
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

async function getPrivacySnapshot() {
	const { db } = await import("$lib/server/db");
	const artifacts = await db
		.select({ id: schema.artifacts.id })
		.from(schema.artifacts);
	const embeddings = await db
		.select({ id: schema.semanticEmbeddings.id })
		.from(schema.semanticEmbeddings);
	const conversations = await db
		.select({ id: schema.conversations.id })
		.from(schema.conversations);
	const conversationSummaries = await db
		.select({ id: schema.conversationSummaries.conversationId })
		.from(schema.conversationSummaries);
	const chatFiles = await db
		.select({ id: schema.chatGeneratedFiles.id })
		.from(schema.chatGeneratedFiles);
	const atlasJobs = await db
		.select({
			id: schema.atlasJobs.id,
			status: schema.atlasJobs.status,
			stage: schema.atlasJobs.stage,
		})
		.from(schema.atlasJobs);
	const atlasCheckpoints = await db
		.select({ id: schema.atlasRoundCheckpoints.id })
		.from(schema.atlasRoundCheckpoints);
	const taskStates = await db
		.select({ id: schema.conversationTaskStates.taskId })
		.from(schema.conversationTaskStates);
	const workingSet = await db
		.select({ id: schema.conversationWorkingSetItems.id })
		.from(schema.conversationWorkingSetItems);
	const contextStatus = await db
		.select({ id: schema.conversationContextStatus.conversationId })
		.from(schema.conversationContextStatus);
	const memoryEvents = await db
		.select({ id: schema.memoryEvents.id })
		.from(schema.memoryEvents);
	const resetGenerations = await db
		.select({
			userId: schema.memoryResetGenerations.userId,
			resetGeneration: schema.memoryResetGenerations.resetGeneration,
		})
		.from(schema.memoryResetGenerations);
	const projectionStates = await db
		.select({ id: schema.memoryProjectionState.id })
		.from(schema.memoryProjectionState);
	const profileItems = await db
		.select({ id: schema.memoryProfileItems.id })
		.from(schema.memoryProfileItems);
	const profileProvenance = await db
		.select({ id: schema.memoryProfileItemProvenance.id })
		.from(schema.memoryProfileItemProvenance);
	const reviewItems = await db
		.select({ id: schema.memoryReviewItems.id })
		.from(schema.memoryReviewItems);
	const reviewResolutions = await db
		.select({ id: schema.memoryReviewResolutions.id })
		.from(schema.memoryReviewResolutions);
	const dirtyEntries = await db
		.select({ id: schema.memoryDirtyLedger.id })
		.from(schema.memoryDirtyLedger);
	const telemetryEvents = await db
		.select({ id: schema.memoryReworkTelemetry.id })
		.from(schema.memoryReworkTelemetry);
	const [message] = await db
		.select({ metadataJson: schema.messages.metadataJson })
		.from(schema.messages)
		.where(eq(schema.messages.id, "message-1"));
	const users = await db
		.select({
			id: schema.users.id,
			email: schema.users.email,
			name: schema.users.name,
			role: schema.users.role,
			passwordHash: schema.users.passwordHash,
		})
		.from(schema.users);
	const usageEvents = await db
		.select({ id: schema.usageEvents.id })
		.from(schema.usageEvents);
	const analyticsConversations = await db
		.select({ id: schema.analyticsConversations.id })
		.from(schema.analyticsConversations);
	const campaignAssets = await db
		.select({
			id: schema.campaignAssets.id,
			uploadedByUserId: schema.campaignAssets.uploadedByUserId,
		})
		.from(schema.campaignAssets);
	const campaigns = await db
		.select({
			id: schema.announcementCampaigns.id,
			createdByUserId: schema.announcementCampaigns.createdByUserId,
			publishedByUserId: schema.announcementCampaigns.publishedByUserId,
		})
		.from(schema.announcementCampaigns);
	const snapshots = await db
		.select({
			id: schema.announcementCampaignSnapshots.id,
			publishedByUserId: schema.announcementCampaignSnapshots.publishedByUserId,
		})
		.from(schema.announcementCampaignSnapshots);
	const systemSkills = await db
		.select({
			id: schema.userSkillDefinitions.id,
			userId: schema.userSkillDefinitions.userId,
			ownership: schema.userSkillDefinitions.ownership,
		})
		.from(schema.userSkillDefinitions)
		.where(eq(schema.userSkillDefinitions.ownership, "system"));
	return {
		userIds: users.map((row) => row.id).sort(),
		users: users.sort((left, right) => left.id.localeCompare(right.id)),
		artifactIds: artifacts.map((row) => row.id).sort(),
		embeddingIds: embeddings.map((row) => row.id).sort(),
		conversationIds: conversations.map((row) => row.id).sort(),
		conversationSummaryIds: conversationSummaries.map((row) => row.id).sort(),
		chatFileIds: chatFiles.map((row) => row.id).sort(),
		atlasJobs: atlasJobs.sort((left, right) => left.id.localeCompare(right.id)),
		atlasCheckpointIds: atlasCheckpoints.map((row) => row.id).sort(),
		taskStateIds: taskStates.map((row) => row.id).sort(),
		workingSetIds: workingSet.map((row) => row.id).sort(),
		contextStatusIds: contextStatus.map((row) => row.id).sort(),
		memoryEventIds: memoryEvents.map((row) => row.id).sort(),
		resetGenerations,
		projectionStateIds: projectionStates.map((row) => row.id).sort(),
		profileItemIds: profileItems.map((row) => row.id).sort(),
		profileProvenanceIds: profileProvenance.map((row) => row.id).sort(),
		reviewItemIds: reviewItems.map((row) => row.id).sort(),
		reviewResolutionIds: reviewResolutions.map((row) => row.id).sort(),
		dirtyEntryIds: dirtyEntries.map((row) => row.id).sort(),
		telemetryEventIds: telemetryEvents.map((row) => row.id).sort(),
		usageEventIds: usageEvents.map((row) => row.id).sort(),
		analyticsConversationIds: analyticsConversations
			.map((row) => row.id)
			.sort(),
		campaignAssets,
		campaigns,
		snapshots,
		systemSkills,
		messageMetadata: message?.metadataJson ?? null,
	};
}

describe("privacy controls service", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-privacy-controls-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockQuiesceUserMemoryMaintenance.mockResolvedValue(undefined);
		mockRequestActiveChatStreamsStopForUser.mockReturnValue({ stopped: 0 });
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

	it("does not clear memory or knowledge when the password is incorrect", async () => {
		seedPrivacyUser();
		const { clearMemoryAndKnowledge } = await import("./index");

		const result = await clearMemoryAndKnowledge("user-1", "wrong-password");

		expect(result).toEqual({ status: "incorrect_password" });
		await expect(getPrivacySnapshot()).resolves.toMatchObject({
			artifactIds: [
				"generated-1",
				"knowledge-1",
				"normalized-1",
				"skill-note-1",
				"work-capsule-1",
			],
			embeddingIds: ["embedding-1"],
			conversationIds: ["conversation-1"],
			conversationSummaryIds: ["conversation-1"],
			chatFileIds: ["file-1"],
			usageEventIds: ["usage-1"],
			analyticsConversationIds: ["analytics-conversation-1"],
		});
	});

	it("clears memory and knowledge while preserving chats and generated chat outputs", async () => {
		seedPrivacyUser();
		seedAtlasLifecycleData("succeeded");
		const { clearMemoryAndKnowledge } = await import("./index");

		const result = await clearMemoryAndKnowledge("user-1", "correct-password");

		expect(result).toEqual({
			status: "cleared",
			deletedArtifactIds: [
				"knowledge-1",
				"normalized-1",
				"skill-note-1",
				"work-capsule-1",
			],
		});
		await expect(getPrivacySnapshot()).resolves.toMatchObject({
			userIds: ["user-1"],
			artifactIds: ["atlas-generated-artifact-1", "generated-1"],
			embeddingIds: [],
			conversationIds: ["conversation-1"],
			conversationSummaryIds: [],
			chatFileIds: ["atlas-file-html-1", "file-1"],
			atlasJobs: [
				{
					id: "atlas-job-1",
					status: "succeeded",
					stage: "complete",
				},
			],
			atlasCheckpointIds: ["atlas-checkpoint-1"],
			taskStateIds: [],
			workingSetIds: [],
			contextStatusIds: [],
			memoryEventIds: [],
			resetGenerations: [{ userId: "user-1", resetGeneration: 1 }],
			projectionStateIds: [],
			profileItemIds: [],
			profileProvenanceIds: [],
			reviewItemIds: [],
			reviewResolutionIds: [],
			dirtyEntryIds: [],
			telemetryEventIds: [],
			usageEventIds: ["usage-1"],
			analyticsConversationIds: ["analytics-conversation-1"],
			messageMetadata: null,
		});
	});

	it("clears workspace data while preserving the account and historical analytics", async () => {
		seedPrivacyUser();
		seedAtlasLifecycleData("running");
		const { clearWorkspaceData } = await import("./index");

		const result = await clearWorkspaceData("user-1", "correct-password");

		expect(result).toEqual({ status: "reset" });
		await expect(getPrivacySnapshot()).resolves.toMatchObject({
			userIds: ["user-1"],
			artifactIds: [],
			embeddingIds: [],
			conversationIds: [],
			chatFileIds: [],
			atlasJobs: [],
			atlasCheckpointIds: [],
			taskStateIds: [],
			workingSetIds: [],
			contextStatusIds: [],
			memoryEventIds: [],
			usageEventIds: ["usage-1"],
			analyticsConversationIds: ["analytics-conversation-1"],
		});
		expect(mockRequestActiveChatStreamsStopForUser).toHaveBeenCalledWith(
			"user-1",
		);
	});

	it("erases a last-admin self-service account and removes person-linked analytics", async () => {
		seedPrivacyUser();
		seedRunningFileProductionWork();
		seedAtlasLifecycleData("running");
		const { eraseUserAccount } = await import("./index");

		const result = await eraseUserAccount("user-1", "correct-password");

		expect(result).toEqual({ status: "deleted" });
		await expect(getPrivacySnapshot()).resolves.toMatchObject({
			userIds: [],
			artifactIds: [],
			embeddingIds: [],
			conversationIds: [],
			chatFileIds: [],
			atlasJobs: [],
			atlasCheckpointIds: [],
			usageEventIds: [],
			analyticsConversationIds: [],
		});
		expect(mockRequestActiveChatStreamsStopForUser).toHaveBeenCalledWith(
			"user-1",
		);
		expect(mockQuiesceUserMemoryMaintenance).toHaveBeenCalledWith("user-1");
	});

	it("preserves shared admin content with detached authorship during admin erasure", async () => {
		seedPrivacyUser();
		seedOtherRealUser();
		seedSharedContentOwnedByUser();
		const { eraseUserAccountAsAdmin } = await import("./index");

		const result = await eraseUserAccountAsAdmin("user-1");

		expect(result).toBe(true);
		const snapshot = await getPrivacySnapshot();
		expect(snapshot.userIds).not.toContain("user-1");
		expect(snapshot.userIds).toContain("user-2");
		expect(snapshot.userIds).toContain("detached-shared-content-owner");
		expect(snapshot.campaignAssets).toEqual([
			{
				id: "asset-1",
				uploadedByUserId: "detached-shared-content-owner",
			},
		]);
		expect(snapshot.campaigns).toEqual([
			{
				id: "campaign-1",
				createdByUserId: null,
				publishedByUserId: null,
			},
		]);
		expect(snapshot.snapshots).toEqual([
			{
				id: "snapshot-1",
				publishedByUserId: null,
			},
		]);
		expect(snapshot.systemSkills).toEqual([
			{
				id: "system-skill-1",
				userId: "detached-shared-content-owner",
				ownership: "system",
			},
		]);
		expect(snapshot.users).toContainEqual({
			id: "detached-shared-content-owner",
			email: "detached-shared-content-owner@alfyai.local",
			name: "Detached shared content owner",
			role: "user",
			passwordHash: "",
		});
		expect(snapshot.campaignAssets).not.toContainEqual(
			expect.objectContaining({ uploadedByUserId: "user-2" }),
		);
		expect(snapshot.systemSkills).not.toContainEqual(
			expect.objectContaining({ userId: "user-2" }),
		);
	});
});
