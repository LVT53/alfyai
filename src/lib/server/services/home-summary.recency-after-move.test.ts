/**
 * Owner-reported bug: the home page's "recent" rail (`readRecent` in
 * home-summary.ts) orders conversations by `conversations.updatedAt`, the
 * same column the sidebar's own recency sort (`listConversations` in
 * conversations.ts) uses. Moving a chat into a folder is an organizational
 * change, not activity — it must not bump that column and jump a month-old
 * chat ahead of one with genuinely more recent messages.
 */
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;

vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));

function orm() {
	return drizzle(sqlite, { schema });
}

function seedUser(userId: string) {
	orm()
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

function seedProject(userId: string, projectId: string) {
	orm()
		.insert(schema.projects)
		.values({
			id: projectId,
			userId,
			name: "Archive",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

function seedConversation(
	userId: string,
	id: string,
	title: string,
	at: Date,
): void {
	orm()
		.insert(schema.conversations)
		.values({
			id,
			userId,
			title,
			createdAt: at,
			updatedAt: at,
		})
		.run();
}

function seedMessage(conversationId: string, at: Date): void {
	orm()
		.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId,
			role: "user",
			content: "x",
			createdAt: at,
		})
		.run();
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-home-summary-recency-${randomUUID()}.db`;
	sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	migrate(orm(), { migrationsFolder: "./drizzle" });
});

afterEach(() => {
	sqlite.close();
	for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
		try {
			unlinkSync(path);
		} catch {
			// Only -wal/-shm are ever legitimately absent.
		}
	}
	vi.resetModules();
});

describe("the home 'recent' rail is unaffected by folder moves", () => {
	it("keeps a month-old conversation below a genuinely recent one after it is moved into a folder", async () => {
		const userId = randomUUID();
		const today = new Date("2026-09-24T09:00:00Z");
		const monthAgo = new Date("2026-08-24T09:00:00Z");
		seedUser(userId);
		seedProject(userId, "folder-1");
		seedConversation(userId, "genuinely-recent", "Sent today", today);
		seedMessage("genuinely-recent", today);
		seedConversation(userId, "month-old", "Sent a month ago", monthAgo);
		seedMessage("month-old", monthAgo);

		const { moveConversationToProject } = await import("./conversations");
		const { clearHomeSummaryCache, getHomeSummary } = await import(
			"./home-summary"
		);

		const moved = await moveConversationToProject(
			userId,
			"month-old",
			"folder-1",
		);
		expect(moved?.updatedAt).toBe(monthAgo.getTime() / 1000);

		clearHomeSummaryCache();
		const summary = await getHomeSummary({ userId, now: today });

		expect(summary.recent.map((conversation) => conversation.id)).toEqual([
			"genuinely-recent",
			"month-old",
		]);
	});
});
