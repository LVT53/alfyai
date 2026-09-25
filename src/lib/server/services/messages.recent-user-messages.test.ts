import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// listRecentUserMessageTexts is a thin role-filtered/ordered/limited SELECT.
// The hand-rolled mock in messages.test.ts stubs `.where()` as a no-op that
// returns every row regardless of the filter, so it cannot prove role
// filtering, ordering, or the limit actually work — a green test against it
// would be a false positive. This uses a real, migrated SQLite file instead
// (the same pattern conversation-forks.test.ts uses), scoped to only the
// users/conversations/messages tables this function touches.
let dbPath: string;

function openDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedConversationWithMessages() {
	const { sqlite, db } = openDatabase();
	db.insert(schema.users)
		.values({ id: "user-1", email: "lang@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.users)
		.values({ id: "user-2", email: "other@example.com", passwordHash: "hash" })
		.run();
	db.insert(schema.conversations)
		.values({ id: "conv-1", userId: "user-1", title: "Test conversation" })
		.run();
	db.insert(schema.conversations)
		.values({ id: "conv-2", userId: "user-2", title: "Other conversation" })
		.run();

	const at = (offsetSeconds: number) =>
		new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + offsetSeconds * 1000);

	// conv-1: user/assistant turns interleaved, oldest first.
	db.insert(schema.messages)
		.values({
			id: "m1",
			conversationId: "conv-1",
			role: "user",
			content: "first user message",
			createdAt: at(0),
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "m2",
			conversationId: "conv-1",
			role: "assistant",
			content: "first assistant reply",
			createdAt: at(1),
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "m3",
			conversationId: "conv-1",
			role: "user",
			content: "second user message",
			createdAt: at(2),
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "m4",
			conversationId: "conv-1",
			role: "assistant",
			content: "second assistant reply",
			createdAt: at(3),
		})
		.run();
	db.insert(schema.messages)
		.values({
			id: "m5",
			conversationId: "conv-1",
			role: "user",
			content: "third user message",
			createdAt: at(4),
		})
		.run();

	// conv-2: a different conversation entirely, must never leak in.
	db.insert(schema.messages)
		.values({
			id: "m6",
			conversationId: "conv-2",
			role: "user",
			content: "other conversation's user message",
			createdAt: at(5),
		})
		.run();

	sqlite.close();
}

describe("listRecentUserMessageTexts", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-recent-user-messages-${randomUUID()}.db`;
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

	it("returns only user-role messages, newest first, excluding assistant turns and other conversations", async () => {
		seedConversationWithMessages();
		const { listRecentUserMessageTexts } = await import("./messages");

		const result = await listRecentUserMessageTexts("conv-1", 5);

		expect(result).toEqual([
			"third user message",
			"second user message",
			"first user message",
		]);
	});

	it("respects the limit", async () => {
		seedConversationWithMessages();
		const { listRecentUserMessageTexts } = await import("./messages");

		const result = await listRecentUserMessageTexts("conv-1", 2);

		expect(result).toEqual(["third user message", "second user message"]);
	});

	it("returns an empty array for a conversation with no user messages", async () => {
		seedConversationWithMessages();
		const { listRecentUserMessageTexts } = await import("./messages");

		const result = await listRecentUserMessageTexts("no-such-conversation", 5);

		expect(result).toEqual([]);
	});
});
