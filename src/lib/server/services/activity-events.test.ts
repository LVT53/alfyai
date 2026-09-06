import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function seedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: "./drizzle" });

	const now = new Date("2026-05-01T00:00:00.000Z");
	database
		.insert(schema.users)
		.values({
			id: "user-1",
			email: "user@example.com",
			name: "User One",
			passwordHash: "hash",
			role: "user",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	database
		.insert(schema.conversations)
		.values({
			id: "conv-1",
			userId: "user-1",
			title: "Conversation",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	database
		.insert(schema.messages)
		.values({
			id: "message-1",
			conversationId: "conv-1",
			role: "assistant",
			content: "Hello",
			createdAt: now,
		})
		.run();

	sqlite.close();
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The service may not have opened the DB if a test failed early.
	}
}

describe("activity-events recording", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-activity-events-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedDatabase();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort cleanup.
		}
	});

	it("records a done tool_call activity event", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			modelId: "model1",
			toolCalls: [{ name: "research_web", input: {}, status: "done" }],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			kind: "tool_call",
			name: "research_web",
			status: "done",
			modelId: "model1",
			durationMs: null,
		});
	});

	it("maps a failed ToolCallEntry status to a failed activity event", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			toolCalls: [{ name: "fetch_url", input: {}, status: "failed" }],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.status).toBe("failed");
	});

	it("maps metadata.cached=true to a cached activity event and reads metadata.durationMs", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			toolCalls: [
				{
					name: "read_file",
					input: {},
					status: "done",
					metadata: { cached: true, durationMs: 12 },
				},
			],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows[0]).toMatchObject({ status: "cached", durationMs: 12 });
	});

	it("skips tool calls that are still running", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			toolCalls: [{ name: "research_web", input: {}, status: "running" }],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(0);
	});

	it("records a skill_use activity event", async () => {
		const { recordSkillUseActivityEvent } = await import("./activity-events");

		await recordSkillUseActivityEvent({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			modelId: "model2",
			displayName: "my-skill",
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "skill_use",
			name: "my-skill",
			status: "done",
			modelId: "model2",
		});
	});

	it("records a successful use_skill tool call as a skill_use event named after the skill", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			modelId: "model1",
			toolCalls: [
				{
					name: "use_skill",
					input: { name: "recipe-planner" },
					status: "done",
					metadata: {
						ok: true,
						found: true,
						skillId: "skill-recipe-planner",
						skillDisplayName: "Recipe Planner",
					},
				},
			],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "skill_use",
			name: "Recipe Planner",
			status: "done",
			modelId: "model1",
		});
	});

	it("records a use_skill tool call that found nothing as an ordinary failed tool_call", async () => {
		const { recordToolCallActivityEvents } = await import("./activity-events");

		await recordToolCallActivityEvents({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "message-1",
			toolCalls: [
				{
					name: "use_skill",
					input: { name: "no-such-skill" },
					status: "done",
					metadata: {
						ok: false,
						found: false,
						skillId: null,
						skillOwnership: null,
					},
				},
			],
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			kind: "tool_call",
			name: "use_skill",
			status: "done",
		});
	});

	it("records a client activity event and truncates a long name to 64 chars", async () => {
		const { recordClientActivityEvent, ACTIVITY_EVENT_NAME_MAX_LENGTH } =
			await import("./activity-events");

		await recordClientActivityEvent({
			userId: "user-1",
			conversationId: "conv-1",
			kind: "composer_command",
			name: "x".repeat(200),
		});

		const { db } = await import("$lib/server/db");
		const rows = await db.select().from(schema.activityEvents);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toHaveLength(ACTIVITY_EVENT_NAME_MAX_LENGTH);
		expect(rows[0]?.messageId).toBeNull();
		expect(rows[0]?.modelId).toBeNull();
	});

	it("isClientActivityEventKind accepts only the three client-observed kinds", async () => {
		const { isClientActivityEventKind } = await import("./activity-events");

		expect(isClientActivityEventKind("composer_command")).toBe(true);
		expect(isClientActivityEventKind("follow_up_click")).toBe(true);
		expect(isClientActivityEventKind("answer_now")).toBe(true);
		expect(isClientActivityEventKind("tool_call")).toBe(false);
		expect(isClientActivityEventKind("skill_use")).toBe(false);
		expect(isClientActivityEventKind("something_else")).toBe(false);
		expect(isClientActivityEventKind(42)).toBe(false);
	});

	it("never throws when the insert fails", async () => {
		const { recordActivityEvent } = await import("./activity-events");

		await expect(
			recordActivityEvent({
				// A userId with no matching `users` row violates the FK — the
				// writer swallows it rather than failing the caller.
				userId: "missing-user",
				conversationId: "conv-1",
				kind: "tool_call",
				name: "research_web",
			}),
		).resolves.toBeUndefined();
	});
});

describe("client activity rate limiting", () => {
	it("allows requests under the limit and blocks once the window fills", async () => {
		const {
			checkClientActivityRateLimit,
			_resetClientActivityRateLimitForTests,
		} = await import("./activity-events");
		_resetClientActivityRateLimitForTests();

		const now = 1_777_140_000_000;
		for (let i = 0; i < 60; i++) {
			expect(checkClientActivityRateLimit("user-rl", now)).toBe(true);
		}
		expect(checkClientActivityRateLimit("user-rl", now)).toBe(false);
	});

	it("resets once the sliding window has passed", async () => {
		const {
			checkClientActivityRateLimit,
			_resetClientActivityRateLimitForTests,
		} = await import("./activity-events");
		_resetClientActivityRateLimitForTests();

		const now = 1_777_140_000_000;
		for (let i = 0; i < 60; i++) {
			checkClientActivityRateLimit("user-rl-2", now);
		}
		expect(checkClientActivityRateLimit("user-rl-2", now)).toBe(false);
		expect(checkClientActivityRateLimit("user-rl-2", now + 60_001)).toBe(true);
	});

	it("tracks separate buckets per user", async () => {
		const {
			checkClientActivityRateLimit,
			_resetClientActivityRateLimitForTests,
		} = await import("./activity-events");
		_resetClientActivityRateLimitForTests();

		const now = 1_777_140_000_000;
		for (let i = 0; i < 60; i++) {
			checkClientActivityRateLimit("user-a", now);
		}
		expect(checkClientActivityRateLimit("user-a", now)).toBe(false);
		expect(checkClientActivityRateLimit("user-b", now)).toBe(true);
	});
});
