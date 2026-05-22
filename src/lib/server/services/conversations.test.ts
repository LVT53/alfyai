import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedUserFolderConversation(input?: {
	projectId?: string | null;
	objective?: string;
}) {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-14T09:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "folder-continuity@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.projects)
		.values({
			id: "folder-1",
			userId: "user-1",
			name: "Launch folder",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Launch brief conversation",
			projectId: input?.projectId ?? null,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationTaskStates)
		.values({
			taskId: "task-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "active",
			objective: input?.objective ?? "Draft the launch brief",
			confidence: 88,
			locked: 0,
			nextStepsJson: JSON.stringify(["Send the first draft"]),
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function seedOtherUserFolder() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-14T09:03:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-2",
			email: "other-folder-owner@example.com",
			passwordHash: "hash",
		})
		.run();
	db.insert(schema.projects)
		.values({
			id: "folder-2",
			userId: "user-2",
			name: "Other user folder",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function readProjectFolder(id = "folder-1") {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const project = db
		.select()
		.from(schema.projects)
		.where(eq(schema.projects.id, id))
		.get();
	sqlite.close();
	return project;
}

function readMemoryProject(projectId: string) {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const project = db
		.select()
		.from(schema.memoryProjects)
		.where(eq(schema.memoryProjects.projectId, projectId))
		.get();
	sqlite.close();
	return project;
}

function readTaskLink(taskId = "task-1") {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const link = db
		.select()
		.from(schema.memoryProjectTaskLinks)
		.where(eq(schema.memoryProjectTaskLinks.taskId, taskId))
		.get();
	sqlite.close();
	return link;
}

describe("conversation project folder moves", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-folder-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
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

	it("assigns a meaningful conversation task to the folder canonical continuity immediately", async () => {
		seedUserFolderConversation();
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject(
			"user-1",
			"conv-1",
			"folder-1",
		);

		expect(moved?.projectId).toBe("folder-1");
		const projectFolder = readProjectFolder();
		expect(projectFolder?.canonicalMemoryProjectId).toEqual(expect.any(String));
		const canonicalMemoryProjectId = projectFolder?.canonicalMemoryProjectId;
		if (!canonicalMemoryProjectId) {
			throw new Error("Expected folder canonical continuity id");
		}
		const memoryProject = readMemoryProject(canonicalMemoryProjectId);
		expect(memoryProject?.name).toBe("Launch folder");
		const taskLink = readTaskLink();
		expect(taskLink?.projectId).toBe(projectFolder?.canonicalMemoryProjectId);
		expect(taskLink?.conversationId).toBe("conv-1");
	});

	it("re-homes a conversation task to an existing folder canonical continuity", async () => {
		seedUserFolderConversation();
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:05:00.000Z");
		db.insert(schema.memoryProjects)
			.values([
				{
					projectId: "folder-canonical-continuity",
					userId: "user-1",
					name: "Old folder name",
					createdAt: now,
					updatedAt: now,
				},
				{
					projectId: "inferred-continuity",
					userId: "user-1",
					name: "Inferred continuity",
					createdAt: now,
					updatedAt: now,
				},
			])
			.run();
		db.update(schema.projects)
			.set({ canonicalMemoryProjectId: "folder-canonical-continuity" })
			.where(eq(schema.projects.id, "folder-1"))
			.run();
		db.insert(schema.memoryProjectTaskLinks)
			.values({
				id: "existing-link-1",
				projectId: "inferred-continuity",
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();
		const { moveConversationToProject } = await import("./conversations");

		await moveConversationToProject("user-1", "conv-1", "folder-1");

		const projectFolder = readProjectFolder();
		expect(projectFolder?.canonicalMemoryProjectId).toBe(
			"folder-canonical-continuity",
		);
		expect(readTaskLink()?.projectId).toBe("folder-canonical-continuity");
		expect(readMemoryProject("folder-canonical-continuity")?.name).toBe(
			"Launch folder",
		);
	});

	it("reuses existing inferred continuity as the folder canonical continuity on assignment", async () => {
		seedUserFolderConversation();
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:07:00.000Z");
		db.insert(schema.memoryProjects)
			.values({
				projectId: "inferred-continuity",
				userId: "user-1",
				name: "Draft the launch brief",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.insert(schema.memoryProjectTaskLinks)
			.values({
				id: "inferred-link-1",
				projectId: "inferred-continuity",
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();
		const { moveConversationToProject } = await import("./conversations");

		await moveConversationToProject("user-1", "conv-1", "folder-1");

		expect(readProjectFolder()?.canonicalMemoryProjectId).toBe(
			"inferred-continuity",
		);
		expect(readTaskLink()?.projectId).toBe("inferred-continuity");
		expect(readMemoryProject("inferred-continuity")?.name).toBe(
			"Launch folder",
		);
	});

	it("removes folder authority when a conversation is moved out without deleting continuity", async () => {
		seedUserFolderConversation({ projectId: "folder-1" });
		const { sqlite, db } = openSeedDatabase();
		const now = new Date("2026-05-14T09:10:00.000Z");
		db.insert(schema.memoryProjects)
			.values({
				projectId: "folder-canonical-continuity",
				userId: "user-1",
				name: "Launch folder",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		db.update(schema.projects)
			.set({ canonicalMemoryProjectId: "folder-canonical-continuity" })
			.where(eq(schema.projects.id, "folder-1"))
			.run();
		db.insert(schema.memoryProjectTaskLinks)
			.values({
				id: "folder-link-1",
				projectId: "folder-canonical-continuity",
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				createdAt: now,
				updatedAt: now,
			})
			.run();
		sqlite.close();
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject("user-1", "conv-1", null);

		expect(moved?.projectId).toBeNull();
		expect(readTaskLink()).toBeUndefined();
		expect(readMemoryProject("folder-canonical-continuity")).toEqual(
			expect.objectContaining({
				projectId: "folder-canonical-continuity",
				name: "Launch folder",
			}),
		);
	});

	it("rejects moving a conversation into another user's folder without changing assignment", async () => {
		seedUserFolderConversation({ projectId: "folder-1" });
		seedOtherUserFolder();
		const { getConversation, moveConversationToProject } = await import(
			"./conversations"
		);

		const moved = await moveConversationToProject(
			"user-1",
			"conv-1",
			"folder-2",
		);
		const conversation = await getConversation("user-1", "conv-1");

		expect(moved).toBeNull();
		expect(conversation?.projectId).toBe("folder-1");
	});

	it("syncs an already assigned meaningful task into the folder canonical continuity", async () => {
		seedUserFolderConversation({ projectId: "folder-1" });
		const { syncTaskContinuityFromTaskState } = await import(
			"./task-state/continuity"
		);

		const continuityId = await syncTaskContinuityFromTaskState({
			userId: "user-1",
			taskState: {
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "active",
				objective: "Draft the launch brief",
				confidence: 88,
				locked: false,
				lastConfirmedTurnMessageId: null,
				constraints: [],
				factsToPreserve: [],
				decisions: [],
				openQuestions: [],
				activeArtifactIds: [],
				nextSteps: ["Send the first draft"],
				lastCheckpointAt: null,
				createdAt: Date.parse("2026-05-14T09:00:00.000Z"),
				updatedAt: Date.parse("2026-05-14T09:00:00.000Z"),
			},
		});

		const projectFolder = readProjectFolder();
		expect(continuityId).toBe(projectFolder?.canonicalMemoryProjectId);
		if (!continuityId) {
			throw new Error("Expected folder continuity id");
		}
		expect(readMemoryProject(continuityId)?.name).toBe("Launch folder");
		expect(readTaskLink()?.projectId).toBe(continuityId);
	});

	it("leaves a folder organization-only when the conversation task is still a placeholder", async () => {
		seedUserFolderConversation({ objective: "New task" });
		const { moveConversationToProject } = await import("./conversations");

		await moveConversationToProject("user-1", "conv-1", "folder-1");

		expect(readProjectFolder()?.canonicalMemoryProjectId).toBeNull();
		expect(readTaskLink()).toBeUndefined();
	});

	it("keeps inferred continuity behavior for unorganized conversations", async () => {
		seedUserFolderConversation();
		const { syncTaskContinuityFromTaskState } = await import(
			"./task-state/continuity"
		);

		const continuityId = await syncTaskContinuityFromTaskState({
			userId: "user-1",
			taskState: {
				taskId: "task-1",
				userId: "user-1",
				conversationId: "conv-1",
				status: "active",
				objective: "Draft the launch brief",
				confidence: 88,
				locked: false,
				lastConfirmedTurnMessageId: null,
				constraints: [],
				factsToPreserve: [],
				decisions: [],
				openQuestions: [],
				activeArtifactIds: [],
				nextSteps: ["Send the first draft"],
				lastCheckpointAt: null,
				createdAt: Date.parse("2026-05-14T09:00:00.000Z"),
				updatedAt: Date.parse("2026-05-14T09:00:00.000Z"),
			},
		});

		expect(continuityId).toEqual(expect.any(String));
		expect(readProjectFolder()?.canonicalMemoryProjectId).toBeNull();
		if (!continuityId) {
			throw new Error("Expected inferred continuity id");
		}
		expect(readMemoryProject(continuityId)?.name).toBe(
			"Draft the launch brief",
		);
		expect(readTaskLink()?.projectId).toBe(continuityId);
	});
});

function seedSidebarConversationScenario() {
	const { sqlite, db } = openSeedDatabase();
	const base = new Date("2026-05-14T10:00:00.000Z");

	db.insert(schema.users)
		.values([
			{
				id: "sidebar-user",
				email: "sidebar@example.com",
				passwordHash: "hash",
			},
			{
				id: "other-sidebar-user",
				email: "other-sidebar@example.com",
				passwordHash: "hash",
			},
		])
		.run();
	db.insert(schema.conversations)
		.values([
			{
				id: "recent-conv",
				userId: "sidebar-user",
				title: "Recent unpinned",
				createdAt: base,
				updatedAt: new Date(base.getTime() + 3_000),
			},
			{
				id: "older-conv",
				userId: "sidebar-user",
				title: "Older unpinned",
				createdAt: base,
				updatedAt: new Date(base.getTime() + 1_000),
			},
			{
				id: "other-user-conv",
				userId: "other-sidebar-user",
				title: "Other user conversation",
				createdAt: base,
				updatedAt: new Date(base.getTime() + 2_000),
			},
		])
		.run();
	db.insert(schema.messages)
		.values([
			{
				id: "recent-message",
				conversationId: "recent-conv",
				role: "user",
				content: "visible",
				createdAt: base,
			},
			{
				id: "older-message",
				conversationId: "older-conv",
				role: "user",
				content: "visible",
				createdAt: base,
			},
			{
				id: "other-message",
				conversationId: "other-user-conv",
				role: "user",
				content: "visible",
				createdAt: base,
			},
		])
		.run();

	sqlite.close();
}

describe("conversation sidebar pinning", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-sidebar-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
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

	it("inserts a newly pinned conversation at the top of the visible sidebar list", async () => {
		seedSidebarConversationScenario();
		const { listConversations, setConversationSidebarPinned } = await import(
			"./conversations"
		);

		const pinned = await setConversationSidebarPinned(
			"sidebar-user",
			"older-conv",
			true,
		);
		const listed = await listConversations("sidebar-user");

		expect(pinned).toMatchObject({
			id: "older-conv",
			sidebarPinned: true,
			sidebarSortOrder: 0,
		});
		expect(listed.map((conversation) => conversation.id)).toEqual([
			"older-conv",
			"recent-conv",
		]);
		expect(listed[0]).toMatchObject({
			sidebarPinned: true,
			sidebarSortOrder: 0,
		});
		expect(listed[1]).toMatchObject({
			sidebarPinned: false,
			sidebarSortOrder: null,
		});
	});

	it("persists pinned conversation order only for owned pinned conversations", async () => {
		seedSidebarConversationScenario();
		const {
			listConversations,
			savePinnedConversationSidebarOrder,
			setConversationSidebarPinned,
		} = await import("./conversations");

		await setConversationSidebarPinned("sidebar-user", "recent-conv", true);
		await setConversationSidebarPinned("sidebar-user", "older-conv", true);

		await savePinnedConversationSidebarOrder("sidebar-user", [
			"recent-conv",
			"older-conv",
		]);
		const listed = await listConversations("sidebar-user");

		expect(listed.map((conversation) => conversation.id)).toEqual([
			"recent-conv",
			"older-conv",
		]);
		expect(listed.map((conversation) => conversation.sidebarSortOrder)).toEqual(
			[0, 1],
		);
		await expect(
			savePinnedConversationSidebarOrder("sidebar-user", ["other-user-conv"]),
		).rejects.toThrow(
			"orderedIds must contain only owned pinned conversations",
		);
	});

	it("clears manual order on unpin and returns conversations to recent-activity sorting", async () => {
		seedSidebarConversationScenario();
		const { listConversations, setConversationSidebarPinned } = await import(
			"./conversations"
		);

		await setConversationSidebarPinned("sidebar-user", "older-conv", true);
		const unpinned = await setConversationSidebarPinned(
			"sidebar-user",
			"older-conv",
			false,
		);
		const listed = await listConversations("sidebar-user");

		expect(unpinned).toMatchObject({
			id: "older-conv",
			sidebarPinned: false,
			sidebarSortOrder: null,
		});
		expect(listed.map((conversation) => conversation.id)).toEqual([
			"recent-conv",
			"older-conv",
		]);
	});
});
