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
	mockDeleteAllChatFilesForConversation,
	mockGetSourceArtifactIdForNormalizedArtifact,
	mockHardDeleteArtifactsForUser,
	mockListConversationOwnedArtifacts,
} = vi.hoisted(() => ({
	mockArtifactHasReferencesOutsideConversation: vi.fn(),
	mockDeleteAllChatFilesForConversation: vi.fn(),
	mockGetSourceArtifactIdForNormalizedArtifact: vi.fn(),
	mockHardDeleteArtifactsForUser: vi.fn(),
	mockListConversationOwnedArtifacts: vi.fn(),
}));

vi.mock("../chat-files", () => ({
	deleteAllChatFilesForConversation: mockDeleteAllChatFilesForConversation,
}));

vi.mock("../knowledge", () => ({
	artifactHasReferencesOutsideConversation:
		mockArtifactHasReferencesOutsideConversation,
	getSourceArtifactIdForNormalizedArtifact:
		mockGetSourceArtifactIdForNormalizedArtifact,
	hardDeleteArtifactsForUser: mockHardDeleteArtifactsForUser,
	listConversationOwnedArtifacts: mockListConversationOwnedArtifacts,
}));

let dbPath: string;

function seedConversation() {
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

	it("deletes a conversation and runs shared cleanup hooks", async () => {
		seedConversation();

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

		expect(conversations).toEqual([]);
		expect(mockDeleteAllChatFilesForConversation).toHaveBeenCalledWith(
			"conversation-1",
		);
	});

	it("deletes conversation-scoped Atlas jobs, checkpoints, and generated outputs", async () => {
		seedConversation();
		{
			const sqlite = new Database(dbPath);
			sqlite.pragma("foreign_keys = ON");
			const db = drizzle(sqlite, { schema });
			const now = new Date("2026-05-06T11:00:00.000Z");
			db.insert(schema.conversations)
				.values({
					id: "conversation-2",
					userId: "user-1",
					title: "Other research conversation",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			db.insert(schema.chatGeneratedFiles)
				.values([
					{
						id: "atlas-file-delete",
						conversationId: "conversation-1",
						userId: "user-1",
						filename: "atlas-delete.html",
						storagePath: "conversation-1/atlas-delete.html",
						createdAt: now,
					},
					{
						id: "atlas-file-keep",
						conversationId: "conversation-2",
						userId: "user-1",
						filename: "atlas-keep.html",
						storagePath: "conversation-2/atlas-keep.html",
						createdAt: now,
					},
				])
				.run();
			db.insert(schema.atlasJobs)
				.values([
					{
						id: "atlas-delete",
						userId: "user-1",
						conversationId: "conversation-1",
						action: "create",
						profile: "overview",
						normalizedQueryHash: "hash-delete",
						clientAtlasTurnId: "client-delete",
						idempotencyKey:
							"atlas:v1:user-1:conversation-1:create:root:overview:hash-delete:client-delete",
						title: "Delete Atlas",
						status: "running",
						stage: "search",
						htmlChatGeneratedFileId: "atlas-file-delete",
						createdAt: now,
						updatedAt: now,
					},
					{
						id: "atlas-keep",
						userId: "user-1",
						conversationId: "conversation-2",
						action: "create",
						profile: "overview",
						normalizedQueryHash: "hash-keep",
						clientAtlasTurnId: "client-keep",
						idempotencyKey:
							"atlas:v1:user-1:conversation-2:create:root:overview:hash-keep:client-keep",
						title: "Keep Atlas",
						status: "succeeded",
						stage: "complete",
						htmlChatGeneratedFileId: "atlas-file-keep",
						createdAt: now,
						updatedAt: now,
					},
				])
				.run();
			db.insert(schema.atlasRoundCheckpoints)
				.values({
					id: "checkpoint-delete",
					jobId: "atlas-delete",
					roundNumber: 1,
					stage: "synthesize",
					checkpointJson: '{"raw":"private checkpoint"}',
					createdAt: now,
					updatedAt: now,
				})
				.run();
			sqlite.close();
		}

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
		const atlasJobs = await db
			.select({ id: schema.atlasJobs.id })
			.from(schema.atlasJobs)
			.orderBy(schema.atlasJobs.id);
		const checkpoints = await db
			.select({ id: schema.atlasRoundCheckpoints.id })
			.from(schema.atlasRoundCheckpoints);
		const files = await db
			.select({ id: schema.chatGeneratedFiles.id })
			.from(schema.chatGeneratedFiles)
			.orderBy(schema.chatGeneratedFiles.id);

		expect(atlasJobs).toEqual([{ id: "atlas-keep" }]);
		expect(checkpoints).toEqual([]);
		expect(files).toEqual([{ id: "atlas-file-keep" }]);
	});

	// A working artifact cannot outlive its conversation. It is owned ONLY
	// through the conversation link, and `artifacts.conversation_id` is
	// `ON DELETE SET NULL`, so "preserving" one stranded it: invisible in the
	// library, 404 on GET, and a cheerful "already removed" 200 on DELETE, while
	// the row, its file and its parse bundle stayed on disk forever.
	it("deletes generated outputs and work capsules even when referenced elsewhere", async () => {
		seedConversation();

		mockListConversationOwnedArtifacts.mockResolvedValue([
			{ id: "generated-1", type: "generated_output" },
			{ id: "capsule-1", type: "work_capsule" },
			{ id: "source-1", type: "source_document" },
		]);
		// The heuristic that used to spare them. A link confers no ownership, and
		// `conversation_id` holds exactly one conversation, so for these two types
		// there is nothing an outside reference can rescue them into.
		mockArtifactHasReferencesOutsideConversation.mockResolvedValue(true);

		const { deleteConversationWithCleanup } = await import(
			"./conversation-cleanup"
		);

		const result = await deleteConversationWithCleanup(
			"user-1",
			"conversation-1",
		);

		expect(result?.deletedArtifactIds).toEqual(["generated-1", "capsule-1"]);
		// A real document still gets the benefit of the doubt.
		expect(result?.preservedArtifactIds).toEqual(["source-1"]);
		expect(mockHardDeleteArtifactsForUser).toHaveBeenCalledWith("user-1", [
			"generated-1",
			"capsule-1",
		]);
		// The question is never even asked for the two conversation-scoped types.
		expect(
			mockArtifactHasReferencesOutsideConversation.mock.calls.map(
				(call) => call[1],
			),
		).toEqual(["source-1"]);
	});
});
