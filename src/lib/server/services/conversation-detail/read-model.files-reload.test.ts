// Review Focus 7 of docs/superpowers/plans/2026-11-15-nextcloud-file-cards:
// "a reload must draw the same cards as the live turn". The live turn's cards
// ride the tool call's own JSON (`ThinkingSegment.files`), so this seeds that
// stored JSON exactly as the finalize step writes it, opens the conversation
// through the real read model, and checks the card's link survives the
// store-then-reload trip. A test that handed the read model an already-parsed
// `ChatMessage` would prove nothing here: the risk is the JSON round trip.
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
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

function seedConversationWithStoredFilesCard() {
	const { sqlite, db } = openSeedDatabase();
	const now = new Date("2026-11-15T12:00:00.000Z");

	db.insert(schema.users)
		.values({
			id: "user-1",
			email: "files-reload@example.com",
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Files reload fixture",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	db.insert(schema.messages)
		.values([
			{
				id: "msg-user",
				conversationId: "conv-1",
				messageSequence: 1,
				role: "user",
				content: "Find the Q3 report",
				createdAt: now,
			},
			{
				id: "msg-assistant",
				conversationId: "conv-1",
				messageSequence: 2,
				role: "assistant",
				content: "Here it is.",
				// Exactly the shape `finalize` persists: the tool-call segment with
				// its `files` payload beside `map`-style fields.
				toolCalls: JSON.stringify([
					{
						type: "tool_call",
						callId: "call-files",
						name: "files",
						input: { action: "search", query: "Q3 report" },
						status: "done",
						files: {
							connectionId: "conn-1",
							cards: [
								{
									name: "Q3 report.pdf",
									path: "Documents/Q3 report.pdf",
									size: 24_576,
									mtime: "2015-10-21T07:28:00.000Z",
									contentType: "application/pdf",
									previewUrl: null,
									webUrl:
										"https://cloud.example.com/index.php/apps/files/?dir=%2FDocuments&openfile=42",
								},
							],
							total: 1,
						},
					},
				]),
				createdAt: new Date(now.getTime() + 1000),
			},
		])
		.run();

	sqlite.close();
}

describe("conversation detail read model — a stored files card survives a reload", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-files-reload-${Date.now()}-${Math.random()}.db`;
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

	it("returns the thinking segment with files.cards[0].webUrl intact", async () => {
		seedConversationWithStoredFilesCard();
		const { getConversationDetail } = await import("./read-model");

		const detail = await getConversationDetail({
			userId: "user-1",
			conversationId: "conv-1",
		});

		const assistant = detail?.messages.find(
			(message) => message.id === "msg-assistant",
		);
		const segment = assistant?.thinkingSegments?.[0];
		expect(segment?.type).toBe("tool_call");
		if (segment?.type !== "tool_call") {
			throw new Error("expected the stored call to come back as a tool call");
		}
		expect(segment.name).toBe("files");
		expect(segment.files?.cards[0]?.webUrl).toBe(
			"https://cloud.example.com/index.php/apps/files/?dir=%2FDocuments&openfile=42",
		);
	});
});
