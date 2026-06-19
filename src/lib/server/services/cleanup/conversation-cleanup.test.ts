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
	mockDeleteConversationHonchoState,
	mockGetSourceArtifactIdForNormalizedArtifact,
	mockHardDeleteArtifactsForUser,
	mockListConversationOwnedArtifacts,
} = vi.hoisted(() => ({
	mockArtifactHasReferencesOutsideConversation: vi.fn(),
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
		mockDeleteConversationHonchoState.mockResolvedValue(undefined);
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
		expect(mockDeleteConversationHonchoState).toHaveBeenCalledWith(
			"user-1",
			"conversation-1",
		);
		expect(mockDeleteAllChatFilesForConversation).toHaveBeenCalledWith(
			"conversation-1",
		);
	});
});
