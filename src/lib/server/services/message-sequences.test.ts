import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

vi.mock("./knowledge", () => ({
	listMessageAttachments: vi.fn(async () => new Map()),
}));

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

function seedConversationWithNullSequenceMessages() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-19T12:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "sequence-repair@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Repair-off-reads regression",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	// message_sequence is intentionally left NULL, as if the row was created
	// while write-side repair was skipped (see scripts/backfill-message-sequences.ts).
	db.insert(schema.messages)
		.values([
			{
				id: "msg-1",
				conversationId: "conv-1",
				role: "user",
				content: "Question",
				createdAt: now,
			},
			{
				id: "msg-2",
				conversationId: "conv-1",
				role: "assistant",
				content: "Answer",
				createdAt: new Date(now.getTime() + 1000),
			},
		])
		.run();
	sqlite.close();
}

function readMessageSequences(): Array<{
	id: string;
	messageSequence: number | null;
}> {
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

describe("message sequence repair stays off the read path", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-message-sequences-${Date.now()}-${Math.random()}.db`;
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

	it("issues zero UPDATE statements when listing messages, even with NULL sequences present", async () => {
		seedConversationWithNullSequenceMessages();
		expect(readMessageSequences()).toEqual([
			{ id: "msg-1", messageSequence: null },
			{ id: "msg-2", messageSequence: null },
		]);

		const prepareSpy = vi.spyOn(Database.prototype, "prepare");
		try {
			const { listMessages } = await import("./messages");
			const listed = await listMessages("conv-1");

			expect(listed.map((message) => message.id)).toEqual(["msg-1", "msg-2"]);

			const updateStatements = prepareSpy.mock.calls.filter(([sql]) =>
				/UPDATE\s+messages\s+SET\s+message_sequence/i.test(String(sql)),
			);
			expect(updateStatements).toEqual([]);
		} finally {
			prepareSpy.mockRestore();
		}

		// The read must not have repaired the gap it observed.
		expect(readMessageSequences()).toEqual([
			{ id: "msg-1", messageSequence: null },
			{ id: "msg-2", messageSequence: null },
		]);
	});

	it("issues zero UPDATE statements when exporting messages, even with NULL sequences present", async () => {
		seedConversationWithNullSequenceMessages();

		const prepareSpy = vi.spyOn(Database.prototype, "prepare");
		try {
			const { listConversationMessagesForExport } = await import("./messages");
			await listConversationMessagesForExport({ conversationId: "conv-1" });

			const updateStatements = prepareSpy.mock.calls.filter(([sql]) =>
				/UPDATE\s+messages\s+SET\s+message_sequence/i.test(String(sql)),
			);
			expect(updateStatements).toEqual([]);
		} finally {
			prepareSpy.mockRestore();
		}

		expect(readMessageSequences()).toEqual([
			{ id: "msg-1", messageSequence: null },
			{ id: "msg-2", messageSequence: null },
		]);
	});

	it("still repairs NULL sequences on the next write", async () => {
		seedConversationWithNullSequenceMessages();
		const { createMessage } = await import("./messages");

		const nextMessage = await createMessage("conv-1", "user", "Follow-up");

		expect(readMessageSequences()).toEqual([
			{ id: "msg-1", messageSequence: 1 },
			{ id: "msg-2", messageSequence: 2 },
			{ id: nextMessage.id, messageSequence: 3 },
		]);
	});
});
