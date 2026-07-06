import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let seedConnections: Array<{
	sqlite: Database.Database;
	db: ReturnType<typeof drizzle>;
}> = [];

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedConnections.push({ sqlite, db });
	return { sqlite, db };
}

const NOW = new Date("2026-06-01T10:00:00.000Z");

function seedUserAndConversation(params: {
	db: ReturnType<typeof drizzle>;
	userId?: string;
	conversationId?: string;
}) {
	const userId = params.userId ?? "u1";
	const conversationId = params.conversationId ?? "c1";
	params.db
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	params.db
		.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			title: "Test Conversation",
			status: "open",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	params.db
		.insert(schema.memoryResetGenerations)
		.values({
			userId,
			resetGeneration: 0,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
	return { userId, conversationId };
}

function seedMessages(params: {
	db: ReturnType<typeof drizzle>;
	conversationId: string;
	entries: Array<{ role: "user" | "assistant"; content: string }>;
}) {
	for (let i = 0; i < params.entries.length; i++) {
		const entry = params.entries[i];
		params.db
			.insert(schema.messages)
			.values({
				id: `msg-${i}`,
				conversationId: params.conversationId,
				messageSequence: i + 1,
				role: entry.role,
				content: entry.content,
				createdAt: new Date(NOW.getTime() + i * 60_000),
			})
			.run();
	}
}

const ADMIT_REVIEW_DECISIONS = {
	decisions: [
		{
			action: "add",
			statement: "I prefer plain language.",
			category: "preferences",
			scope: "global",
			confidence: "stated",
			expiryClass: "durable",
			sourceQuote: "I prefer plain language",
		},
		{
			action: "add",
			statement: "I am probably tired.",
			category: "about_you",
			scope: "global",
			confidence: "inferred",
			expiryClass: "durable",
			sourceQuote: "...",
		},
		{
			action: "add",
			statement: "I am mentoring a colleague this quarter.",
			category: "goals_ongoing_work",
			scope: "global",
			confidence: "inferred",
			expiryClass: "time_bound",
			expiresInDays: 90,
			sourceQuote: "mentoring",
		},
	],
};

function mockControlModel(payload: unknown) {
	vi.doMock("../normal-chat-control-model", () => ({
		sendJsonControlMessage: vi.fn(async () => ({
			text: JSON.stringify(payload),
			rawResponse: null,
			modelId: "model1",
			modelDisplayName: "test",
		})),
	}));
}

describe("Memory judge service", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-judge-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		delete process.env.MEMORY_JUDGE_DRY_RUN;
		vi.resetModules();
		seedConnections = [];
	});

	afterEach(async () => {
		delete process.env.MEMORY_JUDGE_DRY_RUN;
		for (const conn of seedConnections) {
			try {
				conn.sqlite.close();
			} catch {
				// best-effort
			}
		}
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// db module may not have been imported
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// best-effort cleanup
		}
	});

	it("admits stated facts as active with provenance; routes inferred to review; advances watermark", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel(ADMIT_REVIEW_DECISIONS);

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({
			status: "ran",
			admitted: 1,
			review: 1,
			dryRun: false,
		});

		const { getActiveMemoryProfileContext } = await import(
			"../memory-profile/active-context"
		);
		const ctx = await getActiveMemoryProfileContext({ userId: "u1" });
		expect(ctx.items.map((i) => i.statement)).toContain(
			"I prefer plain language.",
		);

		const { getMemoryProfileReadModel } = await import(
			"../memory-profile/read-model"
		);
		const rm = await getMemoryProfileReadModel({ userId: "u1" });
		expect(rm.review.openCount).toBe(1);

		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);

		// provenance recorded for the admitted item
		const { db: svcDb } = await import("$lib/server/db");
		const admittedItem = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(
				and(
					eq(schema.memoryProfileItems.userId, "u1"),
					eq(schema.memoryProfileItems.status, "active"),
				),
			)
			.all()[0];
		const provenance = svcDb
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(eq(schema.memoryProfileItemProvenance.itemId, admittedItem.id))
			.all();
		expect(provenance.length).toBeGreaterThanOrEqual(1);

		// time_bound review item got an expiresAt ≈ +90d
		const reviewItem = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(
				and(
					eq(schema.memoryProfileItems.userId, "u1"),
					eq(schema.memoryProfileItems.status, "review_needed"),
				),
			)
			.all()[0];
		expect(reviewItem.expiresAt).not.toBeNull();
		const expiresMs = (reviewItem.expiresAt as Date).getTime();
		const expected90d = Date.now() + 90 * 86_400_000;
		expect(Math.abs(expiresMs - expected90d)).toBeLessThan(5 * 86_400_000);
	});

	it("dry-run mode writes telemetry only", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		process.env.MEMORY_JUDGE_DRY_RUN = "true";
		mockControlModel(ADMIT_REVIEW_DECISIONS);

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({ status: "ran", dryRun: true });

		const { getActiveMemoryProfileContext } = await import(
			"../memory-profile/active-context"
		);
		expect(
			(await getActiveMemoryProfileContext({ userId: "u1" })).items,
		).toHaveLength(0);

		const { listMemoryReworkTelemetry } = await import(
			"../memory-profile/telemetry"
		);
		const rows = await listMemoryReworkTelemetry({ userId: "u1" });
		expect(rows.some((r) => r.eventName === "judge_dry_run_decision")).toBe(
			true,
		);
	});

	it("returns empty when no unjudged messages", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({ decisions: [] });

		const { advanceConversationMemoryWatermark } = await import("./segment");
		await advanceConversationMemoryWatermark({
			userId: "u1",
			conversationId: "c1",
			lastJudgedSequence: 2,
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toEqual({ status: "empty" });
	});

	it("caps open review items at 10", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({
			decisions: [
				{
					action: "add",
					statement: "I am mentoring a colleague this quarter.",
					category: "goals_ongoing_work",
					scope: "global",
					confidence: "inferred",
					expiryClass: "durable",
					sourceQuote: "mentoring",
				},
			],
		});

		// pre-seed 10 open review items
		const { createOrUpdateMemoryReviewItem } = await import(
			"../memory-profile/review"
		);
		for (let i = 0; i < 10; i++) {
			await createOrUpdateMemoryReviewItem({
				userId: "u1",
				subjectKey: `preseed:${i}`,
				subjectLabel: `Pre-seeded review ${i}`,
				question: "Keep?",
				reason: "test",
			});
		}

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({ status: "ran", admitted: 0, review: 0 });

		const { listMemoryReworkTelemetry } = await import(
			"../memory-profile/telemetry"
		);
		const rows = await listMemoryReworkTelemetry({ userId: "u1" });
		expect(rows.some((r) => r.eventName === "judge_review_cap_hit")).toBe(true);
	});

	it("tracks projection revision across multiple decisions", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		// Pre-existing active item to target with an update; then two stated adds.
		const { createMemoryProfileItem } = await import(
			"../memory-profile/projection-store"
		);
		const existing = await createMemoryProfileItem({
			userId: "u1",
			category: "about_you",
			scope: { type: "global" },
			statement: "I live in Budapest.",
		});

		mockControlModel({
			decisions: [
				{
					action: "add",
					statement: "I prefer plain language.",
					category: "preferences",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "plain language",
				},
				{
					action: "add",
					statement: "I use a mechanical keyboard.",
					category: "preferences",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "keyboard",
				},
				{
					action: "update",
					targetItemId: existing.id,
					statement: "I live in Amsterdam.",
					category: "about_you",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "Amsterdam",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		// Two adds admitted AND the update applied despite advancing revision.
		expect(result).toMatchObject({
			status: "ran",
			admitted: 2,
			updated: 1,
			dryRun: false,
		});

		const { getActiveMemoryProfileContext } = await import(
			"../memory-profile/active-context"
		);
		const ctx = await getActiveMemoryProfileContext({ userId: "u1" });
		const statements = ctx.items.map((i) => i.statement);
		expect(statements).toContain("I prefer plain language.");
		expect(statements).toContain("I use a mechanical keyboard.");
		expect(statements).toContain("I live in Amsterdam.");
		expect(statements).not.toContain("I live in Budapest.");
	});

	it("never updates a user_authored item", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		const { createMemoryProfileItem } = await import(
			"../memory-profile/projection-store"
		);
		const existing = await createMemoryProfileItem({
			userId: "u1",
			category: "about_you",
			scope: { type: "global" },
			statement: "I live in Budapest.",
		});
		const { db: svcDb } = await import("$lib/server/db");
		svcDb
			.update(schema.memoryProfileItems)
			.set({ metadataJson: JSON.stringify({ origin: "user_authored" }) })
			.where(eq(schema.memoryProfileItems.id, existing.id))
			.run();

		mockControlModel({
			decisions: [
				{
					action: "update",
					targetItemId: existing.id,
					statement: "I live in Amsterdam.",
					category: "about_you",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "Amsterdam",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({ status: "ran", updated: 0 });

		const row = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, existing.id))
			.all()[0];
		expect(row.statement).toBe("I live in Budapest.");
	});

	it("does not advance the watermark on the explicit segmentOverride path", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel(ADMIT_REVIEW_DECISIONS);

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "explicit",
			segmentOverride: [{ role: "user", content: "I prefer plain language." }],
		});
		expect(result).toMatchObject({ status: "ran" });

		// watermark not advanced → the two seeded messages are still unjudged
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(2);
	});
});
