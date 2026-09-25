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

function seedProjectDeletionScenario() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-14T09:00:00.000Z");

	db.insert(schema.users)
		.values([
			{
				id: "owner-user",
				email: "owner@example.com",
				passwordHash: "hash",
			},
			{
				id: "other-user",
				email: "other@example.com",
				passwordHash: "hash",
			},
		])
		.run();
	db.insert(schema.projects)
		.values({
			id: "folder-1",
			userId: "owner-user",
			name: "Launch folder",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "owner-user",
			title: "Launch brief conversation",
			projectId: "folder-1",
			sidebarPinned: true,
			sidebarSortOrder: 7,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversationTaskStates)
		.values({
			taskId: "task-1",
			userId: "owner-user",
			conversationId: "conv-1",
			status: "active",
			objective: "Draft the launch brief",
			confidence: 88,
			locked: 0,
			nextStepsJson: JSON.stringify(["Send the first draft"]),
			createdAt: now,
			updatedAt: now,
		})
		.run();

	sqlite.close();
}

function readConversation(conversationId = "conv-1") {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const conversation = db
		.select()
		.from(schema.conversations)
		.where(eq(schema.conversations.id, conversationId))
		.get();
	sqlite.close();
	return conversation;
}

function readProjectFolder(projectId = "folder-1") {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const project = db
		.select()
		.from(schema.projects)
		.where(eq(schema.projects.id, projectId))
		.get();
	sqlite.close();
	return project;
}

describe("deleteProject", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-delete-${randomUUID()}.db`;
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

	it("does not unassign conversations when the folder belongs to another user", async () => {
		seedProjectDeletionScenario();
		const { deleteProject } = await import("./projects");

		const deleted = await deleteProject("other-user", "folder-1");

		expect(deleted).toBe(false);
		expect(readProjectFolder()?.userId).toBe("owner-user");
		expect(readConversation()?.projectId).toBe("folder-1");
	});

	it("removes the owned folder while preserving conversations", async () => {
		seedProjectDeletionScenario();
		const { deleteProject } = await import("./projects");

		const deleted = await deleteProject("owner-user", "folder-1");

		expect(deleted).toBe(true);
		expect(readProjectFolder()).toBeUndefined();
		expect(readConversation()).toEqual(
			expect.objectContaining({
				id: "conv-1",
				userId: "owner-user",
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 7,
			}),
		);
	});

	it("keeps a project's chat's artifact and its versions, comments and kv rows", async () => {
		seedProjectDeletionScenario();
		const now = new Date("2026-05-14T09:00:00.000Z");
		{
			const { sqlite, db } = openSeedDatabase();
			db.insert(schema.artifacts)
				.values({
					id: "artifact-1",
					userId: "owner-user",
					conversationId: "conv-1",
					type: "artifact",
					name: "Launch checklist",
					contentText: "- [ ] Ship it",
					metadataJson: JSON.stringify({
						artifactType: "document",
						title: "Launch checklist",
					}),
					createdAt: now,
					updatedAt: now,
				})
				.run();
			db.insert(schema.artifactVersions)
				.values({
					id: "version-1",
					artifactId: "artifact-1",
					userId: "owner-user",
					versionNumber: 1,
					author: "user",
					summary: "First draft",
					body: "- [ ] Ship it",
					bodyHash: "hash",
					createdAt: now,
				})
				.run();
			db.insert(schema.artifactComments)
				.values({
					id: "comment-1",
					artifactId: "artifact-1",
					userId: "owner-user",
					parentId: null,
					anchorJson: JSON.stringify({ kind: "node", nodeId: "node-1" }),
					author: "user",
					body: "Ship by Friday?",
					status: "open",
					createdAt: now,
				})
				.run();
			db.insert(schema.artifactKv)
				.values({
					id: "kv-1",
					artifactId: "artifact-1",
					key: "progress",
					valueJson: '"in_review"',
					updatedAt: now,
				})
				.run();
			sqlite.close();
		}
		const { deleteProject } = await import("./projects");

		const deleted = await deleteProject("owner-user", "folder-1");

		expect(deleted).toBe(true);
		const { sqlite, db } = openSeedDatabase();
		const artifact = db
			.select()
			.from(schema.artifacts)
			.where(eq(schema.artifacts.id, "artifact-1"))
			.get();
		const versionCount = db
			.select()
			.from(schema.artifactVersions)
			.where(eq(schema.artifactVersions.artifactId, "artifact-1"))
			.all().length;
		const commentCount = db
			.select()
			.from(schema.artifactComments)
			.where(eq(schema.artifactComments.artifactId, "artifact-1"))
			.all().length;
		const kvCount = db
			.select()
			.from(schema.artifactKv)
			.where(eq(schema.artifactKv.artifactId, "artifact-1"))
			.all().length;
		sqlite.close();

		// deleteProject only unassigns conv-1's projectId; the conversation, and
		// everything it owns, survives — the artifact family included.
		expect(artifact?.id).toBe("artifact-1");
		expect(versionCount).toBe(1);
		expect(commentCount).toBe(1);
		expect(kvCount).toBe(1);
	});
});

/**
 * One owner with a project that has real chats, a project whose only
 * conversation has never carried a message (a prepared-but-unused landing
 * draft), and another user's project — so eligibility, ordering and ownership
 * can all be asserted against the same rows.
 */
function seedProjectPageScenario() {
	const { sqlite, db } = openSeedDatabase();
	const base = new Date("2026-06-01T10:00:00.000Z");
	const at = (minutes: number) => new Date(base.getTime() + minutes * 60_000);

	db.insert(schema.users)
		.values([
			{
				id: "page-user",
				email: "page@example.com",
				passwordHash: "hash",
			},
			{
				id: "page-other-user",
				email: "page-other@example.com",
				passwordHash: "hash",
			},
		])
		.run();

	db.insert(schema.projects)
		.values([
			{
				id: "page-project",
				userId: "page-user",
				name: "Vienna trip",
				sortOrder: 0,
				createdAt: base,
				updatedAt: base,
			},
			{
				id: "page-empty-project",
				userId: "page-user",
				name: "Empty project",
				sortOrder: 1,
				createdAt: base,
				updatedAt: base,
			},
			{
				id: "page-other-project",
				userId: "page-other-user",
				name: "Someone else's project",
				sortOrder: 0,
				createdAt: base,
				updatedAt: base,
			},
		])
		.run();

	db.insert(schema.conversations)
		.values([
			{
				id: "conv-newest",
				userId: "page-user",
				title: "Train options Budapest to Vienna",
				projectId: "page-project",
				createdAt: at(0),
				updatedAt: at(120),
			},
			{
				id: "conv-older",
				userId: "page-user",
				title: "Museums open on Sunday",
				projectId: "page-project",
				createdAt: at(0),
				updatedAt: at(60),
			},
			{
				// Newest of all, but it has never carried a message, so it is a
				// landing draft rather than a chat the user had.
				id: "conv-unused-draft",
				userId: "page-user",
				title: "New Conversation",
				projectId: "page-project",
				createdAt: at(0),
				updatedAt: at(180),
			},
			{
				id: "conv-empty-project-draft",
				userId: "page-user",
				title: "New Conversation",
				projectId: "page-empty-project",
				createdAt: at(0),
				updatedAt: at(240),
			},
			{
				id: "conv-other-user",
				userId: "page-other-user",
				title: "Other user's chat",
				projectId: "page-other-project",
				createdAt: at(0),
				updatedAt: at(600),
			},
		])
		.run();

	db.insert(schema.messages)
		.values([
			{
				id: "msg-1",
				conversationId: "conv-newest",
				role: "user",
				content: "How do I get to Vienna?",
				createdAt: at(118),
			},
			{
				id: "msg-2",
				conversationId: "conv-newest",
				role: "assistant",
				content: "By railjet.",
				createdAt: at(120),
			},
			{
				id: "msg-3",
				conversationId: "conv-older",
				role: "user",
				content: "Which museums are open?",
				createdAt: at(60),
			},
			{
				id: "msg-4",
				conversationId: "conv-other-user",
				role: "user",
				content: "Somebody else's turn",
				createdAt: at(600),
			},
		])
		.run();

	sqlite.close();
}

function unixSeconds(value: Date): number {
	return value.getTime() / 1000;
}

describe("project instructions", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-instructions-${randomUUID()}.db`;
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

	it("stores instructions and reports hasInstructions without exposing the text in the list", async () => {
		seedProjectDeletionScenario();
		const { listProjects, updateProject } = await import("./projects");

		await updateProject("owner-user", "folder-1", {
			instructions: "Always answer in Hungarian.",
		});
		const [project] = await listProjects("owner-user");

		expect(project.hasInstructions).toBe(true);
		expect(project).not.toHaveProperty("instructions");
	});

	it("reports hasInstructions false for a project with none, and for whitespace only", async () => {
		seedProjectDeletionScenario();
		const { getProject, listProjects, updateProject } = await import(
			"./projects"
		);

		await expect(getProject("owner-user", "folder-1")).resolves.toMatchObject({
			hasInstructions: false,
		});

		// "" and NULL are the same stored state: clearing the box and never
		// having set it must not be distinguishable afterwards.
		await updateProject("owner-user", "folder-1", { instructions: "   " });
		expect(readProjectFolder()?.instructions).toBeNull();

		await updateProject("owner-user", "folder-1", { instructions: "x" });
		await updateProject("owner-user", "folder-1", { instructions: null });
		expect(readProjectFolder()?.instructions).toBeNull();

		const [project] = await listProjects("owner-user");
		expect(project.hasInstructions).toBe(false);
	});

	it("keeps the name when only the instructions are patched, and the reverse", async () => {
		seedProjectDeletionScenario();
		const { getProject, updateProject } = await import("./projects");

		await updateProject("owner-user", "folder-1", {
			instructions: "Trip is 10-12 October.",
		});
		await expect(getProject("owner-user", "folder-1")).resolves.toMatchObject({
			name: "Launch folder",
		});

		await updateProject("owner-user", "folder-1", { name: "Renamed" });
		expect(readProjectFolder()?.instructions).toBe("Trip is 10-12 October.");
	});

	it("deletes the instructions with the project", async () => {
		seedProjectDeletionScenario();
		const { deleteProject, listProjects, updateProject } = await import(
			"./projects"
		);

		await updateProject("owner-user", "folder-1", {
			instructions: "Gone soon.",
		});
		await deleteProject("owner-user", "folder-1");

		expect(readProjectFolder()).toBeUndefined();
		await expect(listProjects("owner-user")).resolves.toEqual([]);
	});

	it("changes no other user's project", async () => {
		seedProjectDeletionScenario();
		const { getProject, updateProject } = await import("./projects");

		await expect(
			updateProject("other-user", "folder-1", { instructions: "Mine now." }),
		).resolves.toBeNull();
		expect(readProjectFolder()?.instructions).toBeNull();
		await expect(getProject("other-user", "folder-1")).resolves.toBeNull();
	});
});

// The read that prompt assembly and the archive depend on. The resolution
// around it (which project, in what order, per turn) is covered by
// instructions.test.ts with the project service mocked; the ownership check is
// the lookup's own, so it is asserted here against a real database.
describe("getProjectInstructions", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-instructions-read-${randomUUID()}.db`;
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

	it("returns the project's instructions with the name that labels them", async () => {
		seedProjectDeletionScenario();
		const { getProjectInstructions, updateProject } = await import(
			"./projects"
		);

		await updateProject("owner-user", "folder-1", {
			instructions: "  Always answer in Hungarian.\n",
		});

		await expect(
			getProjectInstructions("owner-user", "folder-1"),
		).resolves.toEqual({
			id: "folder-1",
			name: "Launch folder",
			text: "Always answer in Hungarian.",
		});
	});

	it("returns null text for a project that carries none, and for whitespace only", async () => {
		seedProjectDeletionScenario();
		const { getProjectInstructions, updateProject } = await import(
			"./projects"
		);

		const unset = await getProjectInstructions("owner-user", "folder-1");
		expect(unset).toMatchObject({ text: null });

		await updateProject("owner-user", "folder-1", { instructions: "   \n " });
		const blank = await getProjectInstructions("owner-user", "folder-1");
		expect(blank?.text).toBeNull();
	});

	it("returns null for another user's project, and for a missing one", async () => {
		seedProjectDeletionScenario();
		const { getProjectInstructions, updateProject } = await import(
			"./projects"
		);

		await updateProject("owner-user", "folder-1", {
			instructions: "Only the owner reads this.",
		});

		// Somebody else's project is indistinguishable from a missing one: a
		// caller that guessed an id learns nothing about whether it exists.
		await expect(
			getProjectInstructions("other-user", "folder-1"),
		).resolves.toBeNull();
		await expect(
			getProjectInstructions("owner-user", "no-such-project"),
		).resolves.toBeNull();
	});

	it("reads what the last update wrote, for every turn that asks", async () => {
		seedProjectDeletionScenario();
		const { getProjectInstructions, updateProject } = await import(
			"./projects"
		);

		await updateProject("owner-user", "folder-1", {
			instructions: "First version.",
		});
		expect((await getProjectInstructions("owner-user", "folder-1"))?.text).toBe(
			"First version.",
		);

		await updateProject("owner-user", "folder-1", {
			instructions: "Second version.",
		});
		expect((await getProjectInstructions("owner-user", "folder-1"))?.text).toBe(
			"Second version.",
		);

		await updateProject("owner-user", "folder-1", { instructions: null });
		expect((await getProjectInstructions("owner-user", "folder-1"))?.text).toBe(
			null,
		);
	});
});

describe("getProjectPageData", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-page-${randomUUID()}.db`;
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

	it("returns the project's own text, its chats and its newest activity", async () => {
		seedProjectPageScenario();
		const { getProjectPageData, updateProject } = await import("./projects");

		await updateProject("page-user", "page-project", {
			instructions: "We travel by train.",
		});
		const page = await getProjectPageData({
			userId: "page-user",
			projectId: "page-project",
			limit: 10,
		});
		const base = new Date("2026-06-01T10:00:00.000Z").getTime() / 1000;

		expect(page).toEqual({
			project: {
				id: "page-project",
				name: "Vienna trip",
				instructions: "We travel by train.",
				hasInstructions: true,
			},
			chats: [
				{
					id: "conv-newest",
					title: "Train options Budapest to Vienna",
					updatedAt: base + 120 * 60,
					messageCount: 2,
				},
				{
					id: "conv-older",
					title: "Museums open on Sunday",
					updatedAt: base + 60 * 60,
					messageCount: 1,
				},
			],
			chatCount: 2,
			lastActivityAt: base + 120 * 60,
		});
	});

	it("leaves out a conversation that has never carried a message", async () => {
		seedProjectPageScenario();
		const { getProjectPageData } = await import("./projects");

		const page = await getProjectPageData({
			userId: "page-user",
			projectId: "page-project",
			limit: 10,
		});

		// conv-unused-draft is the newest row in the project, so a plain
		// recency read would put a phantom chat at the top of the list.
		expect(page?.chats.map((chat) => chat.id)).toEqual([
			"conv-newest",
			"conv-older",
		]);
		expect(page?.chatCount).toBe(2);
	});

	it("caps the chat list without lying about the count", async () => {
		seedProjectPageScenario();
		const { getProjectPageData } = await import("./projects");

		const page = await getProjectPageData({
			userId: "page-user",
			projectId: "page-project",
			limit: 1,
		});

		expect(page?.chats.map((chat) => chat.id)).toEqual(["conv-newest"]);
		expect(page?.chatCount).toBe(2);
	});

	it("reports an empty project as empty rather than missing", async () => {
		seedProjectPageScenario();
		const { getProjectPageData } = await import("./projects");

		await expect(
			getProjectPageData({
				userId: "page-user",
				projectId: "page-empty-project",
				limit: 10,
			}),
		).resolves.toEqual({
			project: {
				id: "page-empty-project",
				name: "Empty project",
				instructions: null,
				hasInstructions: false,
			},
			chats: [],
			chatCount: 0,
			lastActivityAt: null,
		});
	});

	it("treats another user's project as missing", async () => {
		seedProjectPageScenario();
		const { getProjectPageData } = await import("./projects");

		await expect(
			getProjectPageData({
				userId: "page-user",
				projectId: "page-other-project",
				limit: 10,
			}),
		).resolves.toBeNull();
		await expect(
			getProjectPageData({
				userId: "page-other-user",
				projectId: "page-project",
				limit: 10,
			}),
		).resolves.toBeNull();
	});
});

describe("listRecentlyActiveProjects", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-recent-${randomUUID()}.db`;
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

	it("counts only a project with at least one conversation that has messages", async () => {
		seedProjectPageScenario();
		const { listRecentlyActiveProjects, updateProject } = await import(
			"./projects"
		);

		await updateProject("page-user", "page-empty-project", {
			instructions: "Not enough on its own.",
		});
		const projects = await listRecentlyActiveProjects({
			userId: "page-user",
			limit: 10,
		});

		expect(projects).toEqual([
			{
				id: "page-project",
				name: "Vienna trip",
				color: null,
				chatCount: 2,
				lastActivityAt: unixSeconds(new Date("2026-06-01T12:00:00.000Z")),
				hasInstructions: false,
			},
		]);
	});

	it("orders by newest chat activity and never lists another user's project", async () => {
		seedProjectPageScenario();
		const { listRecentlyActiveProjects } = await import("./projects");

		const projects = await listRecentlyActiveProjects({
			userId: "page-other-user",
			limit: 10,
		});

		expect(projects.map((project) => project.id)).toEqual([
			"page-other-project",
		]);
	});

	it("honours the limit", async () => {
		seedProjectPageScenario();
		const { listRecentlyActiveProjects } = await import("./projects");

		await expect(
			listRecentlyActiveProjects({ userId: "page-user", limit: 0 }),
		).resolves.toEqual([]);
	});
});

function seedProjectSidebarScenario() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-14T11:00:00.000Z");

	db.insert(schema.users)
		.values([
			{
				id: "project-sidebar-user",
				email: "project-sidebar@example.com",
				passwordHash: "hash",
			},
			{
				id: "other-project-sidebar-user",
				email: "other-project-sidebar@example.com",
				passwordHash: "hash",
			},
		])
		.run();
	db.insert(schema.projects)
		.values([
			{
				id: "first-folder",
				userId: "project-sidebar-user",
				name: "First folder",
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "second-folder",
				userId: "project-sidebar-user",
				name: "Second folder",
				sortOrder: 1,
				createdAt: new Date(now.getTime() + 1_000),
				updatedAt: new Date(now.getTime() + 1_000),
			},
			{
				id: "other-user-folder",
				userId: "other-project-sidebar-user",
				name: "Other user folder",
				sortOrder: 0,
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();

	sqlite.close();
}

describe("project sidebar ordering", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-sidebar-${randomUUID()}.db`;
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

	it("lists projects by persisted sidebar order", async () => {
		seedProjectSidebarScenario();
		const { listProjects } = await import("./projects");
		const listed = await listProjects("project-sidebar-user");

		expect(listed.map((project) => project.id)).toEqual([
			"first-folder",
			"second-folder",
		]);
	});

	it("persists sidebar order across all owned project folders", async () => {
		seedProjectSidebarScenario();
		const { listProjects, saveProjectSidebarOrder } = await import(
			"./projects"
		);

		await saveProjectSidebarOrder("project-sidebar-user", {
			ids: ["second-folder", "first-folder"],
		});
		const listed = await listProjects("project-sidebar-user");

		expect(listed.map((project) => [project.id, project.sortOrder])).toEqual([
			["second-folder", 0],
			["first-folder", 1],
		]);
		await expect(
			saveProjectSidebarOrder("project-sidebar-user", {
				ids: ["other-user-folder"],
			}),
		).rejects.toThrow("ids must contain only owned projects");
	});
});

describe("conversation project helpers", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-project-label-${randomUUID()}.db`;
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

	it("resolves the current folder label for an owned conversation only", async () => {
		seedProjectDeletionScenario();
		const {
			getConversationProjectId,
			getConversationProjectLabel,
			updateProject,
		} = await import("./projects");

		await expect(
			getConversationProjectId("owner-user", "conv-1"),
		).resolves.toBe("folder-1");
		await expect(
			getConversationProjectId("other-user", "conv-1"),
		).resolves.toBeNull();
		await expect(
			getConversationProjectLabel("owner-user", "conv-1"),
		).resolves.toBe("Launch folder");
		await expect(
			getConversationProjectLabel("other-user", "conv-1"),
		).resolves.toBeNull();

		await updateProject("owner-user", "folder-1", {
			name: "Renamed launch folder",
		});

		await expect(
			getConversationProjectLabel("owner-user", "conv-1"),
		).resolves.toBe("Renamed launch folder");
	});
});
