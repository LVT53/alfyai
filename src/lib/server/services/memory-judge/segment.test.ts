import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let sqlite: Database.Database;
let seedDb: ReturnType<typeof drizzle>;

function seedUserAndConversation(params: {
	userId: string;
	conversationId: string;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	seedDb
		.insert(schema.users)
		.values({
			id: params.userId,
			email: `${params.userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	seedDb
		.insert(schema.conversations)
		.values({
			id: params.conversationId,
			userId: params.userId,
			title: "Test Conversation",
			status: "open",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedMessages(params: {
	conversationId: string;
	entries: Array<{
		role: "user" | "assistant";
		content: string;
		sequence: number;
	}>;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	for (let i = 0; i < params.entries.length; i++) {
		const entry = params.entries[i];
		seedDb
			.insert(schema.messages)
			.values({
				id: `msg-${params.conversationId}-${i}`,
				conversationId: params.conversationId,
				messageSequence: entry.sequence,
				role: entry.role,
				content: entry.content,
				createdAt: new Date(now.getTime() + i * 60_000),
			})
			.run();
	}
}

describe("memory-judge segment loader + watermark store", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-judge-segment-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		sqlite = new Database(dbPath);
		sqlite.pragma("foreign_keys = ON");
		seedDb = drizzle(sqlite, { schema });
		migrate(seedDb, { migrationsFolder: "./drizzle" });
	});

	afterEach(async () => {
		try {
			sqlite.close();
		} catch {
			// Best-effort close
		}
		try {
			const { sqlite: svcSqlite } = await import("$lib/server/db");
			svcSqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("returns all messages when no watermark, then only newer ones after advancing", async () => {
		seedUserAndConversation({ userId: "u1", conversationId: "c1" });
		seedMessages({
			conversationId: "c1",
			entries: [
				{ role: "user", content: "m1", sequence: 1 },
				{ role: "assistant", content: "m2", sequence: 2 },
				{ role: "user", content: "m3", sequence: 3 },
				{ role: "assistant", content: "m4", sequence: 4 },
			],
		});

		const seg = await import("./segment");
		const first = await seg.getUnjudgedConversationSegment({
			userId: "u1",
			conversationId: "c1",
		});
		expect(first.count).toBe(4);
		expect(first.highestSequence).toBe(4);
		expect(first.messages.map((m) => m.content)).toEqual([
			"m1",
			"m2",
			"m3",
			"m4",
		]);

		await seg.advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: 4,
		});

		const second = await seg.getUnjudgedConversationSegment({
			userId: "u1",
			conversationId: "c1",
		});
		expect(second.count).toBe(0);
		expect(second.messages).toEqual([]);
		expect(second.highestSequence).toBe(0);
		expect(
			await seg.countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
	});

	it("caps segment at maxMessages keeping the OLDEST, and advances the watermark only over the kept batch (D1)", async () => {
		seedUserAndConversation({ userId: "u1", conversationId: "c1" });
		seedMessages({
			conversationId: "c1",
			entries: [
				{ role: "user", content: "m1", sequence: 1 },
				{ role: "assistant", content: "m2", sequence: 2 },
				{ role: "user", content: "m3", sequence: 3 },
				{ role: "assistant", content: "m4", sequence: 4 },
				{ role: "user", content: "m5", sequence: 5 },
				{ role: "assistant", content: "m6", sequence: 6 },
			],
		});

		const seg = await import("./segment");
		const s = await seg.getUnjudgedConversationSegment({
			userId: "u1",
			conversationId: "c1",
			maxMessages: 3,
		});
		// Oldest-first: the batch is m1..m3, and highestSequence stays inside it
		// (3), so advancing the watermark can never mark the un-sent m4..m6 judged.
		expect(s.messages.map((m) => m.content)).toEqual(["m1", "m2", "m3"]);
		expect(s.highestSequence).toBe(3);
		expect(s.count).toBe(3);
		expect(s.remaining).toBe(3);

		// After advancing over the kept batch, the surplus is still fully unjudged.
		await seg.advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: s.highestSequence,
		});
		expect(
			await seg.countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(3);

		// A second pass drains the remainder with no gap.
		const s2 = await seg.getUnjudgedConversationSegment({
			userId: "u1",
			conversationId: "c1",
			maxMessages: 3,
		});
		expect(s2.messages.map((m) => m.content)).toEqual(["m4", "m5", "m6"]);
		expect(s2.highestSequence).toBe(6);
		expect(s2.remaining).toBe(0);
	});

	it("counts unjudged messages without loading them", async () => {
		seedUserAndConversation({ userId: "u1", conversationId: "c1" });
		seedMessages({
			conversationId: "c1",
			entries: [
				{ role: "user", content: "m1", sequence: 1 },
				{ role: "assistant", content: "m2", sequence: 2 },
			],
		});

		const seg = await import("./segment");
		expect(
			await seg.countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(2);

		await seg.advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: 1,
		});
		expect(
			await seg.countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(1);
	});

	it("advancing the watermark backwards does not regress it (monotonic max)", async () => {
		seedUserAndConversation({ userId: "u1", conversationId: "c1" });
		seedMessages({
			conversationId: "c1",
			entries: [
				{ role: "user", content: "m1", sequence: 1 },
				{ role: "assistant", content: "m2", sequence: 2 },
				{ role: "user", content: "m3", sequence: 3 },
			],
		});

		const seg = await import("./segment");
		await seg.advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: 3,
		});
		await seg.advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: 1,
		});

		expect(
			await seg.countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
	});

	it("ignores messages with roles other than user/assistant", async () => {
		seedUserAndConversation({ userId: "u1", conversationId: "c1" });
		seedMessages({
			conversationId: "c1",
			entries: [
				{ role: "user", content: "m1", sequence: 1 },
				{ role: "assistant", content: "m2", sequence: 2 },
			],
		});
		seedDb
			.insert(schema.messages)
			.values({
				id: "msg-system-1",
				conversationId: "c1",
				messageSequence: 3,
				role: "system",
				content: "system prompt",
				createdAt: new Date("2026-06-01T10:03:00.000Z"),
			})
			.run();

		const seg = await import("./segment");
		const result = await seg.getUnjudgedConversationSegment({
			userId: "u1",
			conversationId: "c1",
		});
		expect(result.count).toBe(2);
		expect(result.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
	});
});
