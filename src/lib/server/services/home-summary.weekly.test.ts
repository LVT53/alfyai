/**
 * The weekly bars and "N messages this week", against a real database.
 *
 * The defect this file exists for: the bars counted `usage_events`, which is a
 * BILLING ledger — analytics.ts appends to it for every model call made on the
 * user's behalf (the assistant turn itself, each Atlas job, each Parallel
 * search or fetch, and every control call: the thought-step classifier, the
 * rail summary, the turn acknowledgment, memory recuration/consolidation/
 * summary/judge). An owner who had sent a few dozen messages was shown "249
 * this week". The count is now the user's OWN messages.
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

function seedConversation(userId: string, title = "A conversation"): string {
	const id = randomUUID();
	orm()
		.insert(schema.conversations)
		.values({
			id,
			userId,
			title,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return id;
}

function seedMessage(
	conversationId: string,
	role: string,
	createdAt: Date,
): void {
	orm()
		.insert(schema.messages)
		.values({
			id: randomUUID(),
			conversationId,
			role,
			content: "x",
			createdAt,
		})
		.run();
}

function seedUsageEvent(userId: string, createdAt: Date): void {
	orm()
		.insert(schema.usageEvents)
		.values({
			id: randomUUID(),
			userId,
			conversationId: "",
			messageId: randomUUID(),
			modelId: "control:thought_step_classifier",
			billingMonth: "2026-09",
			createdAt,
		})
		.run();
}

beforeEach(() => {
	dbPath = `${tmpdir()}/alfyai-test-home-summary-${randomUUID()}.db`;
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

async function summaryFor(userId: string, now: Date) {
	const { clearHomeSummaryCache, getHomeSummary } = await import(
		"./home-summary"
	);
	clearHomeSummaryCache();
	return getHomeSummary({ userId, now });
}

describe("the weekly count counts the user's own messages", () => {
	const NOW = new Date("2026-09-10T12:00:00Z"); // a Thursday

	it("counts user rows and ignores assistant, tool and system rows", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const conversation = seedConversation(userId);
		for (let i = 0; i < 4; i += 1) {
			seedMessage(conversation, "user", NOW);
		}
		for (const role of ["assistant", "tool", "system", "assistant"]) {
			seedMessage(conversation, role, NOW);
		}

		const summary = await summaryFor(userId, NOW);
		expect(summary.weeklyTotal).toBe(4);
		expect(summary.weekly.at(-1)?.count).toBe(4);
	});

	it("ignores another user's messages entirely", async () => {
		const mine = randomUUID();
		const theirs = randomUUID();
		seedUser(mine);
		seedUser(theirs);
		seedMessage(seedConversation(mine), "user", NOW);
		const other = seedConversation(theirs);
		for (let i = 0; i < 25; i += 1) seedMessage(other, "user", NOW);

		expect((await summaryFor(mine, NOW)).weeklyTotal).toBe(1);
		expect((await summaryFor(theirs, NOW)).weeklyTotal).toBe(25);
	});

	it("does not count usage_events — the billing ledger the bars used to read", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const conversation = seedConversation(userId);
		seedMessage(conversation, "user", NOW);
		seedMessage(conversation, "assistant", NOW);
		// One user message can be a dozen billed calls: the assistant turn, the
		// thought-step classifier, the rail summary, a memory pass with no user
		// in the room at all.
		for (let i = 0; i < 40; i += 1) seedUsageEvent(userId, NOW);

		const summary = await summaryFor(userId, NOW);
		expect(summary.weeklyTotal).toBe(1);
	});

	it("keeps the week math: last Sunday's message is in last week's bucket", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const conversation = seedConversation(userId);
		seedMessage(conversation, "user", NOW);
		// 2026-09-06 is the Sunday before, i.e. the previous ISO week.
		seedMessage(conversation, "user", new Date("2026-09-06T10:00:00Z"));

		const summary = await summaryFor(userId, NOW);
		expect(summary.weekly).toHaveLength(12);
		expect(summary.weekly.at(-1)?.count).toBe(1);
		expect(summary.weekly.at(-2)?.count).toBe(1);
		expect(summary.weeklyTotal).toBe(1);
	});

	it("drops a message older than the twelve-week window", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const conversation = seedConversation(userId);
		seedMessage(conversation, "user", new Date("2026-01-05T10:00:00Z"));

		const summary = await summaryFor(userId, NOW);
		// Nothing inside the window at all: no record, rather than twelve ticks.
		expect(summary.weekly).toEqual([]);
		expect(summary.weeklyTotal).toBe(0);
	});

	it("shows no record at all for a user who has sent nothing", async () => {
		const userId = randomUUID();
		seedUser(userId);
		const summary = await summaryFor(userId, NOW);
		expect(summary.weekly).toEqual([]);
		expect(summary.weeklyTotal).toBe(0);
	});

	it("counts across every conversation the user owns", async () => {
		const userId = randomUUID();
		seedUser(userId);
		seedMessage(seedConversation(userId, "one"), "user", NOW);
		seedMessage(seedConversation(userId, "two"), "user", NOW);
		seedMessage(seedConversation(userId, "three"), "user", NOW);

		expect((await summaryFor(userId, NOW)).weeklyTotal).toBe(3);
	});

	it("has an index the query can use rather than scanning messages", () => {
		const plan = sqlite
			.prepare(
				`EXPLAIN QUERY PLAN
				 SELECT m.created_at FROM messages m
				 JOIN conversations c ON c.id = m.conversation_id
				 WHERE c.user_id = ? AND m.role = 'user' AND m.created_at >= ?`,
			)
			.all("u", 0) as Array<{ detail: string }>;
		const detail = plan.map((row) => row.detail).join(" | ");
		expect(detail).toContain("messages_conversation_role_created_idx");
	});
});
