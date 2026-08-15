import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import * as schema from "$lib/server/db/schema";
import { backfillMessageSequences } from "./backfill-message-sequences";

let tempDir: string | null = null;

function createMigratedDatabase(dbPath: string): void {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	sqlite.close();
}

function seedConversationWithNullSequences(dbPath: string): void {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	const now = new Date("2026-05-19T12:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "backfill@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Backfill target",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// Simulate rows created while a write path skipped sequence assignment:
	// message_sequence is left NULL, out of createdAt order to prove the
	// backfill (not insertion order) determines the final sequence.
	db.insert(schema.messages)
		.values([
			{
				id: "msg-first",
				conversationId: "conv-1",
				role: "user",
				content: "First",
				createdAt: new Date(now.getTime() + 1000),
			},
			{
				id: "msg-second",
				conversationId: "conv-1",
				role: "assistant",
				content: "Second",
				createdAt: new Date(now.getTime() + 2000),
			},
		])
		.run();
	sqlite.close();
}

function readMessageSequences(
	dbPath: string,
): Array<{ id: string; messageSequence: number | null }> {
	const sqlite = new Database(dbPath, { readonly: true });
	try {
		return sqlite
			.prepare(
				"SELECT id, message_sequence AS messageSequence FROM messages ORDER BY created_at ASC",
			)
			.all() as Array<{ id: string; messageSequence: number | null }>;
	} finally {
		sqlite.close();
	}
}

describe("backfillMessageSequences", () => {
	afterEach(() => {
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	it("repairs conversations that still have NULL message sequences", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-backfill-sequences-"));
		const dbPath = join(tempDir, "chat.db");
		createMigratedDatabase(dbPath);
		seedConversationWithNullSequences(dbPath);

		expect(readMessageSequences(dbPath)).toEqual([
			{ id: "msg-first", messageSequence: null },
			{ id: "msg-second", messageSequence: null },
		]);

		const result = backfillMessageSequences(dbPath);

		expect(result.conversationIds).toEqual(["conv-1"]);
		expect(readMessageSequences(dbPath)).toEqual([
			{ id: "msg-first", messageSequence: 1 },
			{ id: "msg-second", messageSequence: 2 },
		]);
	});

	it("is a no-op on a second run over an already-repaired database", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-backfill-sequences-"));
		const dbPath = join(tempDir, "chat.db");
		createMigratedDatabase(dbPath);
		seedConversationWithNullSequences(dbPath);

		const firstRun = backfillMessageSequences(dbPath);
		expect(firstRun.conversationIds).toEqual(["conv-1"]);

		const secondRun = backfillMessageSequences(dbPath);

		expect(secondRun.conversationIds).toEqual([]);
		expect(readMessageSequences(dbPath)).toEqual([
			{ id: "msg-first", messageSequence: 1 },
			{ id: "msg-second", messageSequence: 2 },
		]);
	});

	it("leaves conversations with no NULL sequence untouched", () => {
		tempDir = mkdtempSync(join(tmpdir(), "alfyai-backfill-sequences-"));
		const dbPath = join(tempDir, "chat.db");
		createMigratedDatabase(dbPath);

		const result = backfillMessageSequences(dbPath);

		expect(result.conversationIds).toEqual([]);
	});
});
