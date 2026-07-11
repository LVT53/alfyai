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

	// ADR-0051: continuity is folder membership itself. Moving a conversation
	// into a folder assigns `projectId`; there is no inferred canonical-memory
	// bucket to converge, and the folder row stays a plain organizational record.
	it("assigns a conversation into a project folder", async () => {
		seedUserFolderConversation();
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject(
			"user-1",
			"conv-1",
			"folder-1",
		);

		expect(moved?.projectId).toBe("folder-1");
		expect(readProjectFolder()).toMatchObject({
			id: "folder-1",
			name: "Launch folder",
		});
	});

	it("moves a conversation out of a folder", async () => {
		seedUserFolderConversation({ projectId: "folder-1" });
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject("user-1", "conv-1", null);

		expect(moved?.projectId).toBeNull();
		expect(readProjectFolder()).toMatchObject({ id: "folder-1" });
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

	it("projects the latest completed Atlas badge identity for visible conversations", async () => {
		seedSidebarConversationScenario();
		const { sqlite, db } = openSeedDatabase();
		const base = new Date("2026-05-14T10:00:00.000Z");
		db.insert(schema.atlasJobs)
			.values([
				{
					id: "atlas-older",
					userId: "sidebar-user",
					conversationId: "recent-conv",
					action: "create",
					profile: "overview",
					normalizedQueryHash: "hash-older",
					clientAtlasTurnId: "client-older",
					idempotencyKey: "atlas:v1:older",
					title: "Older Atlas report",
					status: "succeeded",
					stage: "audit",
					completedAt: new Date(base.getTime() + 4_000),
					createdAt: new Date(base.getTime() + 1_000),
					updatedAt: new Date(base.getTime() + 4_000),
				},
				{
					id: "atlas-latest",
					userId: "sidebar-user",
					conversationId: "recent-conv",
					action: "create",
					profile: "overview",
					normalizedQueryHash: "hash-latest",
					clientAtlasTurnId: "client-latest",
					idempotencyKey: "atlas:v1:latest",
					title: "Latest Atlas report",
					status: "succeeded",
					stage: "audit",
					completedAt: new Date(base.getTime() + 8_000),
					createdAt: new Date(base.getTime() + 2_000),
					updatedAt: new Date(base.getTime() + 8_000),
				},
				{
					id: "atlas-running",
					userId: "sidebar-user",
					conversationId: "older-conv",
					action: "create",
					profile: "overview",
					normalizedQueryHash: "hash-running",
					clientAtlasTurnId: "client-running",
					idempotencyKey: "atlas:v1:running",
					title: "Running Atlas report",
					status: "running",
					stage: "search",
					createdAt: new Date(base.getTime() + 9_000),
					updatedAt: new Date(base.getTime() + 9_000),
				},
			])
			.run();
		sqlite.close();
		const { listConversations } = await import("./conversations");

		const listed = await listConversations("sidebar-user");
		const recent = listed.find(
			(conversation) => conversation.id === "recent-conv",
		);
		const older = listed.find(
			(conversation) => conversation.id === "older-conv",
		);

		expect(recent?.atlasBadge).toEqual({
			jobId: "atlas-latest",
			status: "succeeded",
			label: "Latest Atlas report",
			completedAt: (base.getTime() + 8_000) / 1000,
			updatedAt: (base.getTime() + 8_000) / 1000,
		});
		expect(older?.atlasBadge).toBeUndefined();
	});
});
