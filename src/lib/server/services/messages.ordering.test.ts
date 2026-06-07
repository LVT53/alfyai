import { readFileSync, unlinkSync } from "node:fs";
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

function seedConversation() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-05-19T12:00:00.000Z");
	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "message-ordering@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Ordering regression",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	sqlite.close();
}

function seedSameSecondMessagesWithUuidOrderOppositeToInsertion() {
	const { sqlite, db } = openSeedDatabase();
	const sameSecond = new Date("2020-01-01T12:00:01.000Z");
	db.insert(schema.messages)
		.values([
			{
				id: "z-user-message",
				conversationId: "conv-1",
				role: "user",
				content: "Question with lexically later id",
				createdAt: sameSecond,
			},
			{
				id: "a-assistant-message",
				conversationId: "conv-1",
				role: "assistant",
				content: "Answer with lexically earlier id",
				createdAt: sameSecond,
			},
		])
		.run();
	sqlite.close();
}

function applyLegacyMessageMigrations(sqlite: Database.Database) {
	const migrationSql = [
		"./drizzle/1777140000042_message_sequence.sql",
		"./drizzle/1777140000049_messages_import_source_import_jobs.sql",
	]
		.map((path) => readFileSync(path, "utf8"))
		.join("\n--> statement-breakpoint\n");
	for (const statement of migrationSql
		.split("--> statement-breakpoint")
		.map((part) => part.trim())
		.filter(Boolean)) {
		sqlite.exec(statement);
	}
}

function seedLegacyConversationDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	sqlite.exec(`
		CREATE TABLE users (
			id text PRIMARY KEY NOT NULL,
			email text NOT NULL,
			password_hash text NOT NULL
		);
		CREATE TABLE conversations (
			id text PRIMARY KEY NOT NULL,
			user_id text NOT NULL,
			title text NOT NULL,
			created_at integer DEFAULT (unixepoch()) NOT NULL,
			updated_at integer DEFAULT (unixepoch()) NOT NULL
		);
		CREATE TABLE messages (
			id text PRIMARY KEY NOT NULL,
			conversation_id text NOT NULL,
			role text NOT NULL,
			content text NOT NULL,
			thinking text,
			tool_calls text,
			metadata_json text,
			created_at integer DEFAULT (unixepoch()) NOT NULL
		);
		CREATE TABLE usage_events (
			id text PRIMARY KEY,
			message_id text,
			model_id text,
			model_display_name text,
			completion_tokens integer DEFAULT 0 NOT NULL,
			reasoning_tokens integer DEFAULT 0 NOT NULL,
			total_tokens integer DEFAULT 0 NOT NULL,
			generation_time_ms integer,
			cost_usd_micros integer
		);
		CREATE TABLE message_analytics (
			id text PRIMARY KEY,
			message_id text,
			model text,
			generation_time_ms integer
		);
		INSERT INTO users (id, email, password_hash)
		VALUES ('user-1', 'legacy-ordering@example.com', 'hash');
		INSERT INTO conversations (id, user_id, title, created_at, updated_at)
		VALUES ('conv-1', 'user-1', 'Legacy ordering', 1777140000, 1777140000);
		INSERT INTO messages (id, conversation_id, role, content, created_at)
		VALUES
			('z-user-message', 'conv-1', 'user', 'Question first', 1777140001),
			('a-assistant-message', 'conv-1', 'assistant', 'Answer second', 1777140001);
	`);
	applyLegacyMessageMigrations(sqlite);
	sqlite.close();
}

describe("message ordering", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-message-ordering-${Date.now()}-${Math.random()}.db`;
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

	it("lists same-second chat messages in persisted conversation order instead of UUID order", async () => {
		seedConversation();
		seedSameSecondMessagesWithUuidOrderOppositeToInsertion();
		const { listMessages } = await import("./messages");

		const listed = await listMessages("conv-1");

		expect(listed.map((message) => message.id)).toEqual([
			"z-user-message",
			"a-assistant-message",
		]);
		expect(listed.map((message) => message.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it("assigns increasing message sequences when persisting new chat messages", async () => {
		seedConversation();
		const { createMessage } = await import("./messages");

		const userMessage = await createMessage("conv-1", "user", "Question");
		const assistantMessage = await createMessage(
			"conv-1",
			"assistant",
			"Answer",
		);

		const { sqlite, db } = openSeedDatabase();
		try {
			const rows = db
				.select({
					id: schema.messages.id,
					messageSequence: schema.messages.messageSequence,
				})
				.from(schema.messages)
				.orderBy(schema.messages.messageSequence)
				.all();

			expect(rows).toEqual([
				{ id: userMessage.id, messageSequence: 1 },
				{ id: assistantMessage.id, messageSequence: 2 },
			]);
		} finally {
			sqlite.close();
		}
	});

	it("repairs null message sequences before allocating the next message sequence", async () => {
		seedConversation();
		seedSameSecondMessagesWithUuidOrderOppositeToInsertion();
		const { createMessage, listMessages } = await import("./messages");

		const nextMessage = await createMessage("conv-1", "user", "Follow-up");
		const listed = await listMessages("conv-1");

		expect(listed.map((message) => message.id)).toEqual([
			"z-user-message",
			"a-assistant-message",
			nextMessage.id,
		]);

		const { sqlite, db } = openSeedDatabase();
		try {
			const rows = db
				.select({
					id: schema.messages.id,
					messageSequence: schema.messages.messageSequence,
				})
				.from(schema.messages)
				.orderBy(schema.messages.messageSequence)
				.all();

			expect(rows).toEqual([
				{ id: "z-user-message", messageSequence: 1 },
				{ id: "a-assistant-message", messageSequence: 2 },
				{ id: nextMessage.id, messageSequence: 3 },
			]);
		} finally {
			sqlite.close();
		}
	});

	it("lists migrated same-second legacy messages by backfilled sequence order", async () => {
		seedLegacyConversationDatabase();
		const { listMessages } = await import("./messages");

		const listed = await listMessages("conv-1");

		expect(listed.map((message) => message.id)).toEqual([
			"z-user-message",
			"a-assistant-message",
		]);
	});
});
