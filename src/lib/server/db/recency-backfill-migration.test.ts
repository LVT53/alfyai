import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema";

// One-off owner-approved data migration: past project-folder moves and
// conversation renames bumped `conversations.updated_at` before the code
// fixes landed in this same change (moveConversationToProject /
// updateConversationTitle in src/lib/server/services/conversations.ts). This
// migration resets `updated_at` back to each conversation's own last real
// message time so the sidebar recency sort and the home "recent" rail (both
// order by that column) stop showing an organizationally-touched old chat as
// if it were freshly active. The migration runs once through drizzle on an
// empty schema here, so the test seeds prod-shaped rows afterwards and
// applies the migration's SQL directly — twice, to prove it is idempotent.

const MIGRATION_FILE =
	"./drizzle/1777140000105_recency_backfill_last_message_time.sql";

function applyMigrationSql(sqlite: Database.Database) {
	const sql = readFileSync(MIGRATION_FILE, "utf8");
	sqlite.exec(sql);
}

describe("recency backfill last-message-time migration", () => {
	let dbPath: string;
	let sqlite: Database.Database;
	let db: ReturnType<typeof drizzle<typeof schema>>;

	beforeEach(() => {
		dbPath = `/tmp/alfyai-recency-backfill-${randomUUID()}.db`;
		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		db = drizzle(sqlite, { schema });
		migrate(db, { migrationsFolder: "./drizzle" });

		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "recency-backfill@example.com",
				passwordHash: "hash",
			})
			.run();
	});

	afterEach(() => {
		sqlite?.close();
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	function readUpdatedAt(conversationId: string): number | undefined {
		const row = sqlite
			.prepare("SELECT updated_at FROM conversations WHERE id = ?")
			.get(conversationId) as { updated_at: number } | undefined;
		return row?.updated_at;
	}

	it("resets an old chat inflated by a rename/move back to its last real message time", () => {
		const lastMessageAt = new Date("2026-08-01T12:00:00Z");
		const inflatedAt = new Date("2026-09-20T09:00:00Z"); // a later rename/move bump

		db.insert(schema.conversations)
			.values({
				id: "moved-or-renamed",
				userId: "user-1",
				title: "Renamed chat",
				createdAt: new Date("2026-07-30T12:00:00Z"),
				updatedAt: inflatedAt,
			})
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: "msg-1",
					conversationId: "moved-or-renamed",
					role: "user",
					content: "hi",
					createdAt: new Date("2026-07-30T12:00:00Z"),
				},
				{
					id: "msg-2",
					conversationId: "moved-or-renamed",
					role: "assistant",
					content: "hello",
					createdAt: lastMessageAt,
				},
			])
			.run();

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("moved-or-renamed")).toBe(
			Math.floor(lastMessageAt.getTime() / 1000),
		);
	});

	function seedChatTouchedAfterLastMessage(
		conversationId: string,
		lastMessageAt: Date,
		updatedAt: Date,
	) {
		db.insert(schema.conversations)
			.values({
				id: conversationId,
				userId: "user-1",
				title: "Chat",
				createdAt: new Date(lastMessageAt.getTime() - 60_000),
				updatedAt,
			})
			.run();
		db.insert(schema.messages)
			.values([
				{
					id: `${conversationId}-user`,
					conversationId,
					role: "user",
					content: "hi",
					createdAt: new Date(lastMessageAt.getTime() - 5_000),
				},
				{
					id: `${conversationId}-assistant`,
					conversationId,
					role: "assistant",
					content: "hello",
					createdAt: lastMessageAt,
				},
			])
			.run();
	}

	// A normal turn leaves updated_at a few seconds after the assistant
	// message (touchConversation runs at turn completion, after the message
	// row is created). The prod dry run found most conversations in that
	// shape; they are not inflated and must not be rewritten.
	it("leaves a chat touched 30 seconds after its last message untouched", () => {
		const lastMessageAt = new Date("2026-09-24T09:00:00Z");
		const touchedAt = new Date(lastMessageAt.getTime() + 30_000);
		seedChatTouchedAfterLastMessage("normal-turn", lastMessageAt, touchedAt);

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("normal-turn")).toBe(
			Math.floor(touchedAt.getTime() / 1000),
		);
	});

	it("leaves a chat touched 10 minutes after its last message untouched", () => {
		const lastMessageAt = new Date("2026-09-24T09:00:00Z");
		const touchedAt = new Date(lastMessageAt.getTime() + 10 * 60_000);
		seedChatTouchedAfterLastMessage("slow-turn", lastMessageAt, touchedAt);

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("slow-turn")).toBe(
			Math.floor(touchedAt.getTime() / 1000),
		);
	});

	it("resets a chat touched just past the 15-minute threshold", () => {
		const lastMessageAt = new Date("2026-09-24T09:00:00Z");
		const touchedAt = new Date(lastMessageAt.getTime() + 16 * 60_000);
		seedChatTouchedAfterLastMessage("past-threshold", lastMessageAt, touchedAt);

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("past-threshold")).toBe(
			Math.floor(lastMessageAt.getTime() / 1000),
		);
	});

	it("leaves a chat whose updated_at already equals its last message unchanged", () => {
		const sentAt = new Date("2026-09-24T09:00:00Z");
		seedChatTouchedAfterLastMessage("exact", sentAt, sentAt);

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("exact")).toBe(Math.floor(sentAt.getTime() / 1000));
	});

	it("leaves an empty prepared conversation with no messages untouched", () => {
		const preparedAt = new Date("2026-09-24T09:00:00Z");
		db.insert(schema.conversations)
			.values({
				id: "empty-prepared",
				userId: "user-1",
				title: "New Conversation",
				createdAt: preparedAt,
				updatedAt: preparedAt,
			})
			.run();

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("empty-prepared")).toBe(
			Math.floor(preparedAt.getTime() / 1000),
		);
	});

	it("does not count non-user/assistant message rows and does not null out updated_at", () => {
		// Defense-in-depth: even though createMessage() never persists a role
		// outside "user" | "assistant", a stray row of another role must not be
		// treated as a real turn, and must not make the MAX(...) subquery hand a
		// NULL to this NOT NULL column.
		const inflatedAt = new Date("2026-09-20T09:00:00Z");
		db.insert(schema.conversations)
			.values({
				id: "only-system-rows",
				userId: "user-1",
				title: "Odd conversation",
				createdAt: new Date("2026-07-01T00:00:00Z"),
				updatedAt: inflatedAt,
			})
			.run();
		db.insert(schema.messages)
			.values({
				id: "msg-system",
				conversationId: "only-system-rows",
				role: "system",
				content: "internal",
				createdAt: new Date("2026-08-15T00:00:00Z"),
			})
			.run();

		applyMigrationSql(sqlite);

		expect(readUpdatedAt("only-system-rows")).toBe(
			Math.floor(inflatedAt.getTime() / 1000),
		);
	});

	it("is a no-op when re-run", () => {
		const lastMessageAt = new Date("2026-08-01T12:00:00Z");
		db.insert(schema.conversations)
			.values({
				id: "moved-or-renamed",
				userId: "user-1",
				title: "Renamed chat",
				createdAt: new Date("2026-07-30T12:00:00Z"),
				updatedAt: new Date("2026-09-20T09:00:00Z"),
			})
			.run();
		db.insert(schema.messages)
			.values({
				id: "msg-1",
				conversationId: "moved-or-renamed",
				role: "user",
				content: "hi",
				createdAt: lastMessageAt,
			})
			.run();

		seedChatTouchedAfterLastMessage(
			"normal-turn",
			new Date("2026-09-24T09:00:00Z"),
			new Date("2026-09-24T09:00:30Z"),
		);

		applyMigrationSql(sqlite);
		expect(readUpdatedAt("moved-or-renamed")).toBe(
			Math.floor(lastMessageAt.getTime() / 1000),
		);
		const snapshot = () =>
			sqlite
				.prepare("SELECT id, updated_at FROM conversations ORDER BY id")
				.all();
		const afterFirst = snapshot();

		applyMigrationSql(sqlite);

		expect(snapshot()).toEqual(afterFirst);
	});
});
