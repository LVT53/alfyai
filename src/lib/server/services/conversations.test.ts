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

	// Owner-reported bug: moving a chat into (or out of) a folder is an
	// organizational change, not conversation activity. Bumping `updatedAt`
	// here made a month-old chat look brand new on the home page's "recent"
	// rail and in the sidebar's recency sort, both of which order by this same
	// column. `touchConversation` (called at real turn completion in
	// send/stream) is the sole intentional "activity" bump; a move must not
	// duplicate that.
	it("does not bump updatedAt when a conversation is moved into a folder", async () => {
		seedUserFolderConversation();
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject(
			"user-1",
			"conv-1",
			"folder-1",
		);

		expect(moved?.projectId).toBe("folder-1");
		expect(moved?.updatedAt).toBe(
			new Date("2026-05-14T09:00:00.000Z").getTime() / 1000,
		);
	});

	it("does not bump updatedAt when a conversation is moved out of a folder", async () => {
		seedUserFolderConversation({ projectId: "folder-1" });
		const { moveConversationToProject } = await import("./conversations");

		const moved = await moveConversationToProject("user-1", "conv-1", null);

		expect(moved?.projectId).toBeNull();
		expect(moved?.updatedAt).toBe(
			new Date("2026-05-14T09:00:00.000Z").getTime() / 1000,
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

// Owner-reported bug: `listConversations` (the sidebar's own recency sort)
// and the home page's "recent" rail (`home-summary.ts` readRecent) both order
// by `conversations.updatedAt`. A move must not let an organizational action
// jump a month-old chat ahead of one with genuinely more recent message
// activity.
describe("conversation recency ordering is unaffected by folder moves", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-recency-${randomUUID()}.db`;
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

	function seedRecencyScenario() {
		const { sqlite, db } = openSeedDatabase();
		const monthAgo = new Date("2026-04-14T09:00:00.000Z");
		const today = new Date("2026-05-14T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "recency-user",
				email: "recency@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.projects)
			.values({
				id: "recency-folder",
				userId: "recency-user",
				name: "Archive",
				createdAt: today,
				updatedAt: today,
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "genuinely-recent",
					userId: "recency-user",
					title: "Sent today",
					createdAt: today,
					updatedAt: today,
				},
				{
					id: "month-old",
					userId: "recency-user",
					title: "Sent a month ago",
					createdAt: monthAgo,
					updatedAt: monthAgo,
				},
			])
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "genuinely-recent-message",
					conversationId: "genuinely-recent",
					role: "user",
					content: "visible",
					createdAt: today,
				},
				{
					id: "month-old-message",
					conversationId: "month-old",
					role: "user",
					content: "visible",
					createdAt: monthAgo,
				},
			])
			.run();

		sqlite.close();
		return { monthAgo, today };
	}

	it("keeps a month-old conversation below a genuinely recent one after it is moved into a folder", async () => {
		const { monthAgo } = seedRecencyScenario();
		const { listConversations, moveConversationToProject } = await import(
			"./conversations"
		);

		const moved = await moveConversationToProject(
			"recency-user",
			"month-old",
			"recency-folder",
		);
		const listed = await listConversations("recency-user");

		expect(moved?.projectId).toBe("recency-folder");
		expect(moved?.updatedAt).toBe(monthAgo.getTime() / 1000);
		expect(listed.map((conversation) => conversation.id)).toEqual([
			"genuinely-recent",
			"month-old",
		]);
	});
});

// Owner-reported bug: a manual rename (and the automatic post-turn title
// generation call, which reuses the same `updateConversationTitle`) bumped
// `updatedAt`, so renaming an old chat jumped it to the top of the sidebar
// and the home page's "recent" rail even though nothing was actually said in
// it. `touchConversation` (called at real turn completion in send/stream) is
// the sole intentional activity bump; a rename must not duplicate it.
describe("conversation recency ordering is unaffected by renames", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-conversation-rename-recency-${randomUUID()}.db`;
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

	function seedRenameRecencyScenario() {
		const { sqlite, db } = openSeedDatabase();
		const monthAgo = new Date("2026-04-14T09:00:00.000Z");
		const today = new Date("2026-05-14T09:00:00.000Z");

		db.insert(schema.users)
			.values({
				id: "rename-user",
				email: "rename@example.com",
				passwordHash: "hash",
			})
			.run();
		db.insert(schema.conversations)
			.values([
				{
					id: "genuinely-recent",
					userId: "rename-user",
					title: "Sent today",
					createdAt: today,
					updatedAt: today,
				},
				{
					id: "month-old",
					userId: "rename-user",
					title: "Sent a month ago",
					createdAt: monthAgo,
					updatedAt: monthAgo,
				},
			])
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "genuinely-recent-message",
					conversationId: "genuinely-recent",
					role: "user",
					content: "visible",
					createdAt: today,
				},
				{
					id: "month-old-message",
					conversationId: "month-old",
					role: "user",
					content: "visible",
					createdAt: monthAgo,
				},
			])
			.run();

		sqlite.close();
		return { monthAgo, today };
	}

	it("does not bump updatedAt when a conversation is manually renamed", async () => {
		const { monthAgo } = seedRenameRecencyScenario();
		const { updateConversationTitle } = await import("./conversations");

		const renamed = await updateConversationTitle(
			"rename-user",
			"month-old",
			"Renamed chat",
		);

		expect(renamed?.title).toBe("Renamed chat");
		expect(renamed?.updatedAt).toBe(monthAgo.getTime() / 1000);
	});

	it("keeps a month-old conversation below a genuinely recent one after it is renamed", async () => {
		const { monthAgo } = seedRenameRecencyScenario();
		const { listConversations, updateConversationTitle } = await import(
			"./conversations"
		);

		const renamed = await updateConversationTitle(
			"rename-user",
			"month-old",
			"Renamed chat",
		);
		const listed = await listConversations("rename-user");

		expect(renamed?.updatedAt).toBe(monthAgo.getTime() / 1000);
		expect(listed.map((conversation) => conversation.id)).toEqual([
			"genuinely-recent",
			"month-old",
		]);
	});

	// Automatic title generation (api/conversations/[id]/title) runs after the
	// turn that produced it already called `touchConversation` at completion,
	// so a brand-new chat is already the most recent conversation by the time
	// its generated title lands. Confirms the shared no-bump code path does not
	// accidentally hide that new chat from the top of the list.
	it("still surfaces a brand-new chat at the top after its title is auto-generated", async () => {
		const { today } = seedRenameRecencyScenario();
		const { listConversations, touchConversation, updateConversationTitle } =
			await import("./conversations");
		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.conversations)
			.values({
				id: "brand-new",
				userId: "rename-user",
				title: "New conversation",
				createdAt: today,
				updatedAt: today,
			})
			.run();
		db.insert(schema.messages)
			.values({
				id: "brand-new-message",
				conversationId: "brand-new",
				role: "user",
				content: "visible",
				createdAt: today,
			})
			.run();
		sqlite.close();

		// The turn's own completion touch fires before the browser's
		// post-stream title request lands.
		await touchConversation("rename-user", "brand-new");
		const generated = await updateConversationTitle(
			"rename-user",
			"brand-new",
			"Generated title",
		);
		const listed = await listConversations("rename-user");

		expect(generated?.title).toBe("Generated title");
		expect(listed[0]?.id).toBe("brand-new");
	});
});
