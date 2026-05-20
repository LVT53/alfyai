import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const {
	mockArtifactHasReferencesOutsideConversation,
	mockCancelRunningResearchTasks,
	mockDeleteAllChatFilesForConversation,
	mockDeleteConversationHonchoState,
	mockGetSourceArtifactIdForNormalizedArtifact,
	mockHardDeleteArtifactsForUser,
	mockListConversationOwnedArtifacts,
} = vi.hoisted(() => ({
	mockArtifactHasReferencesOutsideConversation: vi.fn(),
	mockCancelRunningResearchTasks: vi.fn(),
	mockDeleteAllChatFilesForConversation: vi.fn(),
	mockDeleteConversationHonchoState: vi.fn(),
	mockGetSourceArtifactIdForNormalizedArtifact: vi.fn(),
	mockHardDeleteArtifactsForUser: vi.fn(),
	mockListConversationOwnedArtifacts: vi.fn(),
}));

vi.mock("../chat-files", () => ({
	deleteAllChatFilesForConversation: mockDeleteAllChatFilesForConversation,
}));

vi.mock("../honcho", () => ({
	deleteConversationHonchoState: mockDeleteConversationHonchoState,
}));

vi.mock("../knowledge", () => ({
	artifactHasReferencesOutsideConversation:
		mockArtifactHasReferencesOutsideConversation,
	getSourceArtifactIdForNormalizedArtifact:
		mockGetSourceArtifactIdForNormalizedArtifact,
	hardDeleteArtifactsForUser: mockHardDeleteArtifactsForUser,
	listConversationOwnedArtifacts: mockListConversationOwnedArtifacts,
}));

vi.mock("../deep-research/tasks", () => ({
	cancelRunningResearchTasks: mockCancelRunningResearchTasks,
}));

let dbPath: string;

function seedConversation(job?: {
	id: string;
	status: string;
	stage: string | null;
}) {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-06T10:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conversation-1",
			userId: "user-1",
			title: "Research conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	if (job) {
		db.insert(schema.deepResearchJobs)
			.values({
				id: job.id,
				userId: "user-1",
				conversationId: "conversation-1",
				depth: "standard",
				status: job.status,
				stage: job.stage,
				title: "Research conversation",
				userRequest: "Research this",
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	sqlite.close();
}

describe("deleteConversationWithCleanup", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-cleanup-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockListConversationOwnedArtifacts.mockResolvedValue([]);
		mockHardDeleteArtifactsForUser.mockResolvedValue(undefined);
		mockDeleteAllChatFilesForConversation.mockResolvedValue(undefined);
		mockDeleteConversationHonchoState.mockResolvedValue(undefined);
		mockCancelRunningResearchTasks.mockResolvedValue([]);
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

	it("cancels active Deep Research jobs before deleting the conversation", async () => {
		seedConversation({
			id: "job-1",
			status: "running",
			stage: "citation_audit",
		});

		const { deleteConversationWithCleanup } = await import(
			"./conversation-cleanup"
		);

		const result = await deleteConversationWithCleanup(
			"user-1",
			"conversation-1",
		);

		const { db } = await import("$lib/server/db");
		const conversations = await db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conversation-1"));
		const jobs = await db
			.select({
				id: schema.deepResearchJobs.id,
				status: schema.deepResearchJobs.status,
			})
			.from(schema.deepResearchJobs)
			.where(eq(schema.deepResearchJobs.id, "job-1"));

		expect(result).toEqual({
			deletedArtifactIds: [],
			preservedArtifactIds: [],
		});
		expect(conversations).toEqual([]);
		expect(jobs).toEqual([]);
		expect(mockCancelRunningResearchTasks).toHaveBeenCalledWith({
			userId: "user-1",
			jobId: "job-1",
			reason: "Conversation deleted while Deep Research job was active.",
			now: expect.any(Date),
		});
		expect(mockDeleteConversationHonchoState).toHaveBeenCalledWith(
			"user-1",
			"conversation-1",
		);
		expect(mockDeleteAllChatFilesForConversation).toHaveBeenCalledWith(
			"conversation-1",
		);
	});

	it("allows conversation deletion after the Deep Research job is cancelled", async () => {
		seedConversation({
			id: "job-1",
			status: "cancelled",
			stage: "plan_drafted",
		});

		const { deleteConversationWithCleanup } = await import(
			"./conversation-cleanup"
		);

		const result = await deleteConversationWithCleanup(
			"user-1",
			"conversation-1",
		);

		expect(result).toEqual({
			deletedArtifactIds: [],
			preservedArtifactIds: [],
		});

		const { db } = await import("$lib/server/db");
		const conversations = await db
			.select({ id: schema.conversations.id })
			.from(schema.conversations)
			.where(eq(schema.conversations.id, "conversation-1"));
		const jobs = await db
			.select({ id: schema.deepResearchJobs.id })
			.from(schema.deepResearchJobs)
			.where(eq(schema.deepResearchJobs.id, "job-1"));

		expect(conversations).toEqual([]);
		expect(jobs).toEqual([]);
		expect(mockDeleteConversationHonchoState).toHaveBeenCalledWith(
			"user-1",
			"conversation-1",
		);
		expect(mockDeleteAllChatFilesForConversation).toHaveBeenCalledWith(
			"conversation-1",
		);
	});
});
