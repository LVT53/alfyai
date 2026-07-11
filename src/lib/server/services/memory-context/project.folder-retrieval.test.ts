import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Real-database integration proof for the C1 hard constraint: after the
// inferred project-memory substrate is retired, the model-facing
// `memory_context` tool must still retrieve project / sibling / history context
// through the substrate-free folder-anchored path. This test seeds a real
// migrated database (which applies the drop-substrate migration) and exercises
// the real retrieval functions — no `getProjectReferenceContext` mock.

vi.mock("$lib/server/config-store", async (importActual) => {
	const actual =
		await importActual<typeof import("$lib/server/config-store")>();
	return {
		...actual,
		getTargetConstructedContext: () => 250_000,
	};
});

let dbPath: string;

const USER = "user-folder-retrieval";
const FOLDER = "folder-alma";
const FOLDER_NAME = "AlmaLinux Server Deployment";
const C0 = "conv-current-folder";
const C1 = "conv-sibling-ssh";
const C2 = "conv-sibling-cockpit";
const C9 = "conv-unorganized-history";

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seed(db: ReturnType<typeof openSeedDatabase>["db"]) {
	const now = new Date("2026-06-01T09:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: USER,
			email: "folder-retrieval@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	db.insert(schema.projects)
		.values({
			id: FOLDER,
			userId: USER,
			name: FOLDER_NAME,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	db.insert(schema.conversations)
		.values([
			{
				id: C0,
				userId: USER,
				title: "Current folder chat",
				projectId: FOLDER,
				createdAt: now,
				updatedAt: new Date("2026-06-01T12:00:00.000Z"),
			},
			{
				id: C1,
				userId: USER,
				title: "SSH hardening",
				projectId: FOLDER,
				createdAt: now,
				updatedAt: new Date("2026-06-01T11:00:00.000Z"),
			},
			{
				id: C2,
				userId: USER,
				title: "Cockpit and updates",
				projectId: FOLDER,
				createdAt: now,
				updatedAt: new Date("2026-06-01T10:00:00.000Z"),
			},
			{
				id: C9,
				userId: USER,
				title: "Unrelated calibration chat",
				projectId: null,
				createdAt: now,
				updatedAt: new Date("2026-06-01T08:00:00.000Z"),
			},
		])
		.run();

	const task1 = "task-ssh";
	const task2 = "task-cockpit";
	db.insert(schema.conversationTaskStates)
		.values([
			{
				taskId: task1,
				userId: USER,
				conversationId: C1,
				status: "active",
				objective: "Lock down SSH access on the AlmaLinux host",
				createdAt: now,
				updatedAt: new Date("2026-06-01T11:00:00.000Z"),
			},
			{
				taskId: task2,
				userId: USER,
				conversationId: C2,
				status: "active",
				objective: "Set up Cockpit and automatic updates",
				createdAt: now,
				updatedAt: new Date("2026-06-01T10:00:00.000Z"),
			},
		])
		.run();

	db.insert(schema.taskCheckpoints)
		.values([
			{
				id: randomUUID(),
				taskId: task1,
				userId: USER,
				conversationId: C1,
				checkpointType: "stable",
				content:
					"Stable: PasswordAuthentication no, key-only SSH, firewall on.",
				createdAt: now,
				updatedAt: new Date("2026-06-01T11:05:00.000Z"),
			},
		])
		.run();

	db.insert(schema.conversationSummaries)
		.values([
			{
				conversationId: C1,
				userId: USER,
				summary: "Discussed SSH port, keys, and firewall policy.",
				createdAt: now,
				updatedAt: new Date("2026-06-01T11:00:00.000Z"),
			},
			{
				conversationId: C2,
				userId: USER,
				summary: "Discussed Cockpit, dnf-automatic, and storage.",
				createdAt: now,
				updatedAt: new Date("2026-06-01T10:00:00.000Z"),
			},
			{
				conversationId: C9,
				userId: USER,
				summary: "Discussed the xyzzy quantum widget calibration procedure.",
				createdAt: now,
				updatedAt: new Date("2026-06-01T08:00:00.000Z"),
			},
		])
		.run();

	db.insert(schema.messages)
		.values([
			{
				id: randomUUID(),
				conversationId: C1,
				messageSequence: 1,
				role: "user",
				content: "Use key-only SSH and disable password login.",
				createdAt: new Date("2026-06-01T11:01:00.000Z"),
			},
			{
				id: randomUUID(),
				conversationId: C1,
				messageSequence: 2,
				role: "assistant",
				content: "Set PasswordAuthentication no and restart sshd.",
				createdAt: new Date("2026-06-01T11:02:00.000Z"),
			},
			{
				id: randomUUID(),
				conversationId: C2,
				messageSequence: 1,
				role: "user",
				content: "Enable Cockpit and unattended security updates.",
				createdAt: new Date("2026-06-01T10:01:00.000Z"),
			},
			{
				id: randomUUID(),
				conversationId: C2,
				messageSequence: 2,
				role: "assistant",
				content: "Use systemctl enable --now cockpit.socket.",
				createdAt: new Date("2026-06-01T10:02:00.000Z"),
			},
			{
				id: randomUUID(),
				conversationId: C9,
				messageSequence: 1,
				role: "user",
				content: "How do I calibrate the xyzzy quantum widget?",
				createdAt: new Date("2026-06-01T08:01:00.000Z"),
			},
			{
				id: randomUUID(),
				conversationId: C9,
				messageSequence: 2,
				role: "assistant",
				content: "Run the xyzzy quantum widget calibration wizard twice.",
				createdAt: new Date("2026-06-01T08:02:00.000Z"),
			},
		])
		.run();
}

describe("memory_context tool retrieval after retiring the inferred substrate", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-folder-retrieval-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB module only loaded when a test hits server services.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort temp cleanup.
		}
	});

	it("resolves folder-anchored reference context for a folder conversation and null for a non-folder one", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { getProjectReferenceContext } = await import(
			"$lib/server/services/task-state"
		);

		const folderReference = await getProjectReferenceContext({
			userId: USER,
			conversationId: C0,
		});
		expect(folderReference).not.toBeNull();
		expect(folderReference?.source).toBe("project_folder");
		expect(folderReference?.projectId).toBe(FOLDER);
		expect(
			folderReference?.entries.map((entry) => entry.conversationId).sort(),
		).toEqual([C1, C2].sort());

		// Non-folder conversation has no inferred continuity anymore.
		const nonFolderReference = await getProjectReferenceContext({
			userId: USER,
			conversationId: C9,
		});
		expect(nonFolderReference).toBeNull();
	});

	it("retrieves folder siblings via the memory_context tool in summary, report, and detail modes", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { getProjectContext } = await import(
			"$lib/server/services/memory-context/project"
		);

		const summary = await getProjectContext({
			userId: USER,
			conversationId: C0,
			mode: "summary",
		});
		expect(summary.hasProjectContext).toBe(true);
		expect(summary.source).toBe("project_folder");
		expect(summary.project?.id).toBe(FOLDER);
		expect(
			summary.siblings.map((sibling) => sibling.conversationId).sort(),
		).toEqual([C1, C2].sort());

		const report = await getProjectContext({
			userId: USER,
			conversationId: C0,
			mode: "report",
			maxMessages: 4,
		});
		expect(report.hasProjectContext).toBe(true);
		const reportSibling = report.reportSiblings?.find(
			(sibling) => sibling.conversationId === C1,
		);
		expect(reportSibling?.messages.map((message) => message.content)).toEqual([
			"Use key-only SSH and disable password login.",
			"Set PasswordAuthentication no and restart sshd.",
		]);

		const detail = await getProjectContext({
			userId: USER,
			conversationId: C0,
			mode: "detail",
			siblingConversationId: C1,
			maxMessages: 10,
		});
		expect(detail.hasProjectContext).toBe(true);
		expect(detail.selectedSibling?.conversationId).toBe(C1);
		expect(
			detail.selectedSibling?.messages.map((message) => message.content),
		).toEqual([
			"Use key-only SSH and disable password login.",
			"Set PasswordAuthentication no and restart sshd.",
		]);
	});

	it("falls back to a folder-name query match from an unrelated conversation", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { getProjectContext } = await import(
			"$lib/server/services/memory-context/project"
		);

		const result = await getProjectContext({
			userId: USER,
			conversationId: C9,
			mode: "summary",
			query: `Pull the content from the ${FOLDER_NAME} project folder`,
		});
		expect(result.hasProjectContext).toBe(true);
		expect(result.source).toBe("project_folder");
		expect(result.project?.id).toBe(FOLDER);
	});

	it("recalls unorganized conversations through history search", async () => {
		const { sqlite, db } = openSeedDatabase();
		seed(db);
		sqlite.close();

		const { getHistoryMemoryContext } = await import(
			"$lib/server/services/memory-context/history"
		);

		const history = await getHistoryMemoryContext({
			userId: USER,
			conversationId: C0,
			query: "xyzzy quantum widget calibration",
		});
		expect(
			history.conversations.map((conversation) => conversation.conversationId),
		).toContain(C9);
	});
});
