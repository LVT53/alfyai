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

// More chats on top of `seedConversation()`'s one: `extraUserIds` are made
// first, then each row is inserted for the user it names.
function seedMoreConversations(
	rows: Array<{ id: string; userId: string }>,
	extraUserIds: string[] = [],
) {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	const now = new Date("2026-05-06T10:00:00.000Z");
	for (const userId of extraUserIds) {
		db.insert(schema.users)
			.values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
			})
			.run();
	}
	for (const row of rows) {
		db.insert(schema.conversations)
			.values({
				id: row.id,
				userId: row.userId,
				title: `Chat ${row.id}`,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}
	sqlite.close();
}

async function listConversationIds(): Promise<string[]> {
	const { db } = await import("$lib/server/db");
	const rows = await db
		.select({ id: schema.conversations.id })
		.from(schema.conversations)
		.orderBy(schema.conversations.id);
	return rows.map((row) => row.id);
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

	it("removes the chat's picture files from disk and table", async () => {
		seedConversation();
		const { mkdtemp, rm, readdir } = await import("node:fs/promises");
		const { tmpdir } = await import("node:os");
		const { join } = await import("node:path");
		const sharp = (await import("sharp")).default;
		const workdir = await mkdtemp(join(tmpdir(), "cleanup-images-"));
		vi.spyOn(process, "cwd").mockReturnValue(workdir);
		try {
			const png = await sharp({
				create: { width: 16, height: 16, channels: 3, background: "#fff" },
			})
				.png()
				.toBuffer();
			const { storeImageFile } = await import("../images/files");
			await storeImageFile({
				userId: "user-1",
				conversationId: "conversation-1",
				role: "take",
				png: new Uint8Array(png),
			});
			expect(await readdir(join(workdir, "data", "image-files"))).toEqual([
				"conversation-1",
			]);

			const { deleteConversationWithCleanup } = await import(
				"./conversation-cleanup"
			);
			await deleteConversationWithCleanup("user-1", "conversation-1");

			expect(await readdir(join(workdir, "data", "image-files"))).toEqual([]);
			const { db } = await import("$lib/server/db");
			expect(await db.select().from(schema.imageFiles)).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			await rm(workdir, { recursive: true, force: true });
		}
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

	it("deletes an Image item with its chat even when another chat links to it", async () => {
		seedConversation();

		mockListConversationOwnedArtifacts.mockResolvedValue([
			{
				id: "image-1",
				type: "artifact",
				metadata: { artifactType: "image", title: "Cosy room" },
			},
		]);
		mockArtifactHasReferencesOutsideConversation.mockResolvedValue(true);

		const { deleteConversationWithCleanup } = await import(
			"./conversation-cleanup"
		);

		const result = await deleteConversationWithCleanup(
			"user-1",
			"conversation-1",
		);

		expect(result?.deletedArtifactIds).toEqual(["image-1"]);
		expect(result?.preservedArtifactIds).toEqual([]);
		expect(mockArtifactHasReferencesOutsideConversation).not.toHaveBeenCalled();
	});

	it("removes a normal chat's artifact-family row (with no outside references) and never even asks about another chat's", async () => {
		seedConversation();

		// Only this conversation's own row is ever offered to the loop —
		// listConversationOwnedArtifacts is itself scoped to one conversation,
		// which is what makes "spares another chat's" true by construction.
		mockListConversationOwnedArtifacts.mockResolvedValue([
			{ id: "artifact-1", type: "artifact" },
		]);
		mockArtifactHasReferencesOutsideConversation.mockResolvedValue(false);

		const { deleteConversationWithCleanup } = await import(
			"./conversation-cleanup"
		);

		const result = await deleteConversationWithCleanup(
			"user-1",
			"conversation-1",
		);

		expect(result?.deletedArtifactIds).toEqual(["artifact-1"]);
		expect(result?.preservedArtifactIds).toEqual([]);
		expect(mockHardDeleteArtifactsForUser).toHaveBeenCalledWith("user-1", [
			"artifact-1",
		]);
		expect(mockListConversationOwnedArtifacts).toHaveBeenCalledWith(
			"user-1",
			"conversation-1",
		);
		expect(mockListConversationOwnedArtifacts).not.toHaveBeenCalledWith(
			"user-1",
			"conversation-2",
		);
	});

	// A delete used to leave the server generating into a chat that no longer
	// exists. The stop is the same explicit stop the Stop button sends, so the
	// stream ends the way a person's own Stop ends it.
	it("stops the conversation's streaming reply before deleting it", async () => {
		seedConversation();
		seedMoreConversations([{ id: "conversation-2", userId: "user-1" }]);

		// This file resets modules before every test and imports the code under
		// test dynamically, so the registry has to come from the same fresh
		// module graph: a top-level import is another instance and nothing in it
		// would ever be aborted.
		const { registerActiveChatStream, unregisterActiveChatStream } =
			await import("../chat-turn/active-streams");
		const deletedChatStream = new AbortController();
		const otherChatStream = new AbortController();
		registerActiveChatStream({
			streamId: "stream-1",
			userId: "user-1",
			conversationId: "conversation-1",
			controller: deletedChatStream,
		});
		registerActiveChatStream({
			streamId: "stream-2",
			userId: "user-1",
			conversationId: "conversation-2",
			controller: otherChatStream,
		});

		try {
			const { deleteConversationWithCleanup } = await import(
				"./conversation-cleanup"
			);

			const result = await deleteConversationWithCleanup(
				"user-1",
				"conversation-1",
			);

			expect(result).not.toBeNull();
			expect(deletedChatStream.signal.aborted).toBe(true);
			expect(otherChatStream.signal.aborted).toBe(false);
			expect(await listConversationIds()).toEqual(["conversation-2"]);
		} finally {
			unregisterActiveChatStream("stream-1", deletedChatStream);
			unregisterActiveChatStream("stream-2", otherChatStream);
		}
	});

	it("does not stop another user's stream when it deletes a chat that is not theirs", async () => {
		seedConversation();
		seedMoreConversations(
			[{ id: "conversation-3", userId: "user-2" }],
			["user-2"],
		);
		const { registerActiveChatStream, unregisterActiveChatStream } =
			await import("../chat-turn/active-streams");
		const foreignStream = new AbortController();
		registerActiveChatStream({
			streamId: "stream-3",
			userId: "user-2",
			conversationId: "conversation-3",
			controller: foreignStream,
		});

		try {
			const { deleteConversationWithCleanup } = await import(
				"./conversation-cleanup"
			);

			const result = await deleteConversationWithCleanup(
				"user-1",
				"conversation-3",
			);

			expect(result).toBeNull();
			expect(foreignStream.signal.aborted).toBe(false);
			expect(await listConversationIds()).toContain("conversation-3");
		} finally {
			unregisterActiveChatStream("stream-3", foreignStream);
		}
	});

	describe("deleting several conversations at once", () => {
		it("deletes several conversations and reports each", async () => {
			seedConversation();
			seedMoreConversations(
				[
					{ id: "conversation-2", userId: "user-1" },
					{ id: "conversation-3", userId: "user-2" },
				],
				["user-2"],
			);
			const { deleteConversationsWithCleanup } = await import(
				"./conversation-cleanup"
			);

			const results = await deleteConversationsWithCleanup("user-1", [
				"conversation-1",
				"conversation-2",
				"conversation-3",
				"nope",
			]);

			expect(results).toEqual([
				{ id: "conversation-1", ok: true },
				{ id: "conversation-2", ok: true },
				{ id: "conversation-3", ok: false, error: "not_found" },
				{ id: "nope", ok: false, error: "not_found" },
			]);
			// Another person's chat is only ever reported missing, never touched.
			expect(await listConversationIds()).toEqual(["conversation-3"]);
			expect(mockDeleteAllChatFilesForConversation).not.toHaveBeenCalledWith(
				"conversation-3",
			);
		});

		it("deletes them one after another, in the order given", async () => {
			seedConversation();
			seedMoreConversations([
				{ id: "conversation-2", userId: "user-1" },
				{ id: "conversation-3", userId: "user-1" },
			]);
			let running = 0;
			let mostRunningAtOnce = 0;
			const deleteOrder: string[] = [];
			mockDeleteAllChatFilesForConversation.mockImplementation(
				async (conversationId: string) => {
					running += 1;
					mostRunningAtOnce = Math.max(mostRunningAtOnce, running);
					deleteOrder.push(conversationId);
					// Yield so a parallel implementation would overlap here.
					await new Promise((resolve) => setTimeout(resolve, 5));
					running -= 1;
				},
			);
			const { deleteConversationsWithCleanup } = await import(
				"./conversation-cleanup"
			);

			await deleteConversationsWithCleanup("user-1", [
				"conversation-3",
				"conversation-1",
				"conversation-2",
			]);

			expect(deleteOrder).toEqual([
				"conversation-3",
				"conversation-1",
				"conversation-2",
			]);
			expect(mostRunningAtOnce).toBe(1);
		});

		it("keeps going when one delete throws", async () => {
			seedConversation();
			seedMoreConversations([
				{ id: "conversation-2", userId: "user-1" },
				{ id: "conversation-3", userId: "user-1" },
			]);
			mockListConversationOwnedArtifacts.mockImplementation(
				async (_userId: string, conversationId: string) => {
					if (conversationId === "conversation-2") {
						throw new Error("artifact cleanup failed");
					}
					return [];
				},
			);
			const consoleError = vi
				.spyOn(console, "error")
				.mockImplementation(() => undefined);
			const { deleteConversationsWithCleanup } = await import(
				"./conversation-cleanup"
			);

			try {
				const results = await deleteConversationsWithCleanup("user-1", [
					"conversation-1",
					"conversation-2",
					"conversation-3",
				]);

				expect(results).toEqual([
					{ id: "conversation-1", ok: true },
					{ id: "conversation-2", ok: false, error: "failed" },
					{ id: "conversation-3", ok: true },
				]);
				// The one that threw is still there, so the person can try again.
				expect(await listConversationIds()).toEqual(["conversation-2"]);
				expect(consoleError).toHaveBeenCalledWith(
					expect.stringContaining("[CONVERSATION_BATCH_DELETE]"),
					expect.objectContaining({ conversationId: "conversation-2" }),
				);
			} finally {
				consoleError.mockRestore();
			}
		});
	});
});
