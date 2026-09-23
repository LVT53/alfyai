import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Hoisted static mock: vi.doMock registered from inside an `it()` races with
// sibling files (memory-consolidation/summary.test.ts, memory.v2-actions.test.ts,
// etc.) that dynamically import this same relative specifier's target module
// concurrently under file parallelism, causing the real (unmocked) module to
// resolve intermittently. A hoisted vi.mock is applied once, synchronously,
// before this file's module graph loads, which removes the runtime timing
// dependency entirely. Each test configures the shared spy's behavior instead
// of re-registering the module mock.
const sendJsonControlMessageMock = vi.fn();
vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: sendJsonControlMessageMock,
}));

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
	sendJsonControlMessageMock.mockImplementation(async () => ({
		text: JSON.stringify(payload),
		rawResponse: null,
		modelId: "model1",
		modelDisplayName: "test",
	}));
}

describe("Memory judge service", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-judge-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		delete process.env.MEMORY_JUDGE_DRY_RUN;
		vi.resetModules();
		seedConnections = [];
		sendJsonControlMessageMock.mockReset();
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

		// time_bound review item still gets the review auto-expiry (+30d), not
		// the factual horizon; the horizon is preserved in metadata for later use
		// (e.g. recomputing expiresAt if the item is accepted).
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
		const expected30d = Date.now() + 30 * 86_400_000;
		expect(Math.abs(expiresMs - expected30d)).toBeLessThan(5 * 86_400_000);
		const reviewMetadata = JSON.parse(reviewItem.metadataJson ?? "{}");
		expect(reviewMetadata.expiresInDays).toBe(90);
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

	it("skips judging entirely when the user's master memory toggle is off — including the flush path", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		db.update(schema.users)
			.set({ memoryEnabled: false })
			.where(eq(schema.users.id, "u1"))
			.run();
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		// A genuinely admissible fact is present — the guard must short-circuit
		// BEFORE the judge model is ever consulted, on every trigger path.
		mockControlModel({
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
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});

		expect(result).toEqual({ status: "empty" });
		expect(sendJsonControlMessageMock).not.toHaveBeenCalled();
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

	// createMemoryProfileItem returns the EXISTING row when the itemKey is
	// taken; the judge then overwrote that row's metadata (dropping
	// origin=user_authored) and, for an inferred add, opened a review row that
	// flipped the active user_authored fact to review_needed with a 30-day
	// auto-expiry. Accept on that row would now promote it as a judge fact.
	it.each([
		["stated", "active"],
		["inferred", "active"],
	] as const)("never rewrites an existing user_authored fact when a %s add repeats it", async (confidence, expectedStatus) => {
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
			category: "preferences",
			scope: { type: "global" },
			statement: "I prefer plain language.",
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
					action: "add",
					statement: "I prefer plain language.",
					category: "preferences",
					scope: "global",
					confidence,
					expiryClass: "durable",
					sourceQuote: "I prefer plain language",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({ status: "ran", admitted: 0, review: 0 });

		const row = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, existing.id))
			.all()[0];
		expect(JSON.parse(row.metadataJson)).toEqual({ origin: "user_authored" });
		expect(row.status).toBe(expectedStatus);
		expect(row.expiresAt).toBeNull();
		expect(
			svcDb
				.select()
				.from(schema.memoryReviewItems)
				.where(eq(schema.memoryReviewItems.userId, "u1"))
				.all(),
		).toEqual([]);
		const { listMemoryReworkTelemetry } = await import(
			"../memory-profile/telemetry"
		);
		expect(
			(await listMemoryReworkTelemetry({ userId: "u1" })).filter(
				(r) => r.eventName === "judge_candidate_rejected",
			),
		).toEqual([expect.objectContaining({ reason: "duplicate_existing" })]);
	});

	it("applies a strengthen decision by bumping revision and adding provenance without changing the statement", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I still prefer plain language." },
				{ role: "assistant", content: "Noted again." },
			],
		});
		const { createMemoryProfileItem } = await import(
			"../memory-profile/projection-store"
		);
		const existing = await createMemoryProfileItem({
			userId: "u1",
			category: "preferences",
			scope: { type: "global" },
			statement: "I prefer plain language.",
		});

		mockControlModel({
			decisions: [
				{
					action: "strengthen",
					targetItemId: existing.id,
					statement: "I prefer plain language.",
					category: "preferences",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "still prefer plain language",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({
			status: "ran",
			admitted: 0,
			updated: 1,
			dryRun: false,
		});

		const { db: svcDb } = await import("$lib/server/db");
		const row = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, existing.id))
			.all()[0];
		expect(row.statement).toBe("I prefer plain language.");
		expect(row.revision).toBe(existing.revision + 1);

		const provenance = svcDb
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(eq(schema.memoryProfileItemProvenance.itemId, existing.id))
			.all();
		expect(provenance.length).toBeGreaterThanOrEqual(1);
	});

	it("records a rejected-candidate telemetry row for a hedged decision in live mode", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "I might have a bike." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({
			decisions: [
				{
					action: "add",
					statement: "I might have a bike.",
					category: "about_you",
					scope: "global",
					confidence: "stated",
					expiryClass: "durable",
					sourceQuote: "might have a bike",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});
		expect(result).toMatchObject({
			status: "ran",
			admitted: 0,
			dryRun: false,
		});

		const { listMemoryReworkTelemetry } = await import(
			"../memory-profile/telemetry"
		);
		const rows = await listMemoryReworkTelemetry({ userId: "u1" });
		const rejected = rows.find(
			(r) => r.eventName === "judge_candidate_rejected",
		);
		expect(rejected).toBeDefined();
		expect(rejected?.reason).toBe("hedge");
	});

	it("scales the model token budget with segment length so long conversations are not truncated", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		// 12 messages → a segment large enough that a flat budget would starve a
		// reasoning model into an all-reasoning, zero-decision response.
		seedMessages({
			db,
			conversationId: "c1",
			entries: Array.from({ length: 12 }, (_, i) => ({
				role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
				content: `Message number ${i}.`,
			})),
		});
		mockControlModel(ADMIT_REVIEW_DECISIONS);

		const { runMemoryJudgeOnSegment } = await import("./index");
		await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});

		// 12 messages → reasoningAwareMaxTokens(12) = min(2400 + 500*12, 8000) = 8000.
		const callOptions = sendJsonControlMessageMock.mock.calls[0]?.[2] as {
			maxTokens?: number;
		};
		expect(callOptions?.maxTokens).toBe(8000);
	});

	it("advances the watermark to the exchange's max sequence on the explicit override path, so those messages are never re-judged (D2)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel(ADMIT_REVIEW_DECISIONS);

		const { runMemoryJudgeOnSegment } = await import("./index");
		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "explicit",
			segmentOverride: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
			// The newest message of the judged exchange, threaded from finalize.ts.
			overrideHighestSequence: 2,
		});
		expect(result).toMatchObject({ status: "ran" });

		// Watermark advanced to seq 2 → both judged messages are marked judged and
		// a later marathon/idle/sweep count does NOT re-include them.
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);

		const watermark =
			db
				.select()
				.from(schema.conversationMemoryWatermarks)
				.where(eq(schema.conversationMemoryWatermarks.conversationId, "c1"))
				.all()[0]?.lastJudgedSequence ?? 0;
		expect(watermark).toBe(2);
	});

	it("does NOT advance the watermark on the explicit path when a backlog sits below the exchange, so no message is skipped (D2 regression)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		// A pre-existing unjudged backlog (seqs 1-4, watermark 0 — common during an
		// active session where the idle timer keeps getting rescheduled) followed by
		// the explicit exchange (seqs 5-6).
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "backlog-1" },
				{ role: "assistant", content: "backlog-2" },
				{ role: "user", content: "backlog-3" },
				{ role: "assistant", content: "backlog-4" },
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
		});
		mockControlModel({ decisions: [] });

		const { runMemoryJudgeOnSegment } = await import("./index");
		const { countUnjudgedMessages } = await import("./segment");
		const readWatermark = () =>
			db
				.select()
				.from(schema.conversationMemoryWatermarks)
				.where(eq(schema.conversationMemoryWatermarks.conversationId, "c1"))
				.all()[0]?.lastJudgedSequence ?? 0;

		const result = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "explicit",
			segmentOverride: [
				{ role: "user", content: "Remember that I prefer plain language." },
				{ role: "assistant", content: "Noted." },
			],
			overrideHighestSequence: 6,
		});
		expect(result).toMatchObject({ status: "ran" });

		// The watermark must NOT jump to 6: seqs 1-4 were never sent to the model,
		// so marking them judged would be silent intake loss (D1-class).
		expect(readWatermark()).toBe(0);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(6);

		// A later oldest-first loader pass drains the whole backlog AND the explicit
		// exchange — nothing is ever skipped.
		const drain = await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "sweep",
		});
		expect(drain.status).toBe("ran");
		expect(readWatermark()).toBe(6);
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
	});

	it("does not advance the watermark on the explicit path when no override sequence is supplied", async () => {
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

		// No override sequence → the `> 0` guard keeps the watermark untouched.
		const { countUnjudgedMessages } = await import("./segment");
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(2);
	});

	it("records a memory-cost telemetry row with the call's token usage", async () => {
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
		sendJsonControlMessageMock.mockImplementation(async () => ({
			text: JSON.stringify(ADMIT_REVIEW_DECISIONS),
			rawResponse: null,
			modelId: "model1",
			modelDisplayName: "test",
			usage: { promptTokens: 120, completionTokens: 40, totalTokens: 160 },
		}));

		const { runMemoryJudgeOnSegment } = await import("./index");
		await runMemoryJudgeOnSegment({
			userId: "u1",
			conversationId: "c1",
			trigger: "idle",
		});

		const costRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.eventFamily, "cost"))
			.all();
		expect(costRows).toHaveLength(1);
		expect(costRows[0].eventName).toBe("model_usage");
		expect(costRows[0].count).toBe(160);
		expect(JSON.parse(costRows[0].metadataJson)).toMatchObject({
			feature: "judge",
			promptTokens: 120,
			completionTokens: 40,
			totalTokens: 160,
		});
	});

	it("never marks a message judged unless it was sent to the model; drains an 87-message backlog across passes without gaps (D1)", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		// 87 unjudged messages, sequences 1..87, each with a unique marker so we
		// can see exactly which sequences reached the model.
		const TOTAL = 87;
		const entries = Array.from({ length: TOTAL }, (_, i) => ({
			role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
			content: `marker-seq-${i + 1}`,
		}));
		seedMessages({ db, conversationId: "c1", entries });
		mockControlModel({ decisions: [] });

		const { runMemoryJudgeOnSegment } = await import("./index");
		const { countUnjudgedMessages } = await import("./segment");

		const readWatermark = () =>
			db
				.select()
				.from(schema.conversationMemoryWatermarks)
				.where(eq(schema.conversationMemoryWatermarks.conversationId, "c1"))
				.all()[0]?.lastJudgedSequence ?? 0;

		// Collect the highest marker sequence present in each segment actually
		// sent to the model.
		const highestSentPerCall: number[] = [];
		const sentSequences = new Set<number>();
		const recordSent = () => {
			const call =
				sendJsonControlMessageMock.mock.calls[
					sendJsonControlMessageMock.mock.calls.length - 1
				];
			const userMessage = String(call?.[0] ?? "");
			let highest = 0;
			for (let seq = 1; seq <= TOTAL; seq++) {
				if (
					userMessage.includes(`marker-seq-${seq}\n`) ||
					userMessage.endsWith(`marker-seq-${seq}`)
				) {
					sentSequences.add(seq);
					if (seq > highest) highest = seq;
				}
			}
			highestSentPerCall.push(highest);
		};

		// Drain the backlog across as many passes as needed, re-marking is handled
		// by the caller in prod; here we simply re-run the chokepoint until empty.
		let priorWatermark = 0;
		let passes = 0;
		let lastBacklogRemaining = true;
		while (
			(await countUnjudgedMessages({
				userId: "u1",
				conversationId: "c1",
			})) > 0
		) {
			passes++;
			if (passes > 10) throw new Error("drain did not converge");
			const result = await runMemoryJudgeOnSegment({
				userId: "u1",
				conversationId: "c1",
				trigger: "sweep",
			});
			recordSent();
			expect(result.status).toBe("ran");

			const watermark = readWatermark();
			// INVARIANT: the watermark never advances past the highest sequence
			// that was actually sent to the model in this pass.
			expect(watermark).toBeLessThanOrEqual(
				highestSentPerCall[highestSentPerCall.length - 1],
			);
			// Watermark advances strictly (monotonic, no stall) each pass.
			expect(watermark).toBeGreaterThan(priorWatermark);
			priorWatermark = watermark;
			if (result.status === "ran") {
				lastBacklogRemaining = result.backlogRemaining;
			}
		}

		// The default batch size is 50, so an 87-message backlog needs 2 passes.
		expect(passes).toBe(2);
		// First pass reported a remaining backlog; the final pass did not.
		expect(lastBacklogRemaining).toBe(false);
		// Every one of the 87 messages reached the model in some segment — no
		// silent intake loss.
		expect(sentSequences.size).toBe(TOTAL);
		for (let seq = 1; seq <= TOTAL; seq++) {
			expect(sentSequences.has(seq)).toBe(true);
		}
		// Backlog fully drained; watermark landed exactly on the last message.
		expect(
			await countUnjudgedMessages({ userId: "u1", conversationId: "c1" }),
		).toBe(0);
		expect(readWatermark()).toBe(TOTAL);
	});

	it("opens an acceptable review row for an inferred fact, and Accept promotes it to active with provenance", async () => {
		const { db } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Mentoring Anna again this week." },
				{ role: "assistant", content: "Nice." },
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
					expiryClass: "time_bound",
					expiresInDays: 90,
					sourceQuote: "Mentoring Anna again",
				},
			],
		});

		const { runMemoryJudgeOnSegment } = await import("./index");
		await expect(
			runMemoryJudgeOnSegment({
				userId: "u1",
				conversationId: "c1",
				trigger: "idle",
			}),
		).resolves.toMatchObject({ status: "ran", review: 1 });

		const { getMemoryProfileReadModel } = await import(
			"../memory-profile/read-model"
		);
		const before = await getMemoryProfileReadModel({ userId: "u1" });
		expect(before.review.visibleItems).toEqual([
			expect.objectContaining({
				subject: "I am mentoring a colleague this quarter.",
				canAccept: true,
			}),
		]);
		const { db: svcDb } = await import("$lib/server/db");
		const reviewRow = svcDb.select().from(schema.memoryReviewItems).all()[0];
		expect(JSON.parse(reviewRow.metadataJson)).toMatchObject({
			category: "goals_ongoing_work",
			proposedStatement: "I am mentoring a colleague this quarter.",
		});

		const { applyMemoryReviewItemWithRevision } = await import(
			"../memory-profile/review"
		);
		const accepted = await applyMemoryReviewItemWithRevision({
			userId: "u1",
			reviewItemId: before.review.visibleItems[0]?.id ?? "",
			expectedProjectionRevision: before.projectionRevision,
			action: "accept",
		});
		expect(accepted).toMatchObject({
			status: "updated",
			category: "goals_ongoing_work",
		});
		const itemId = accepted.status === "updated" ? accepted.itemId : "";
		const item = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.id, itemId as string))
			.all()[0];
		expect(item.status).toBe("active");
		const expiresMs = (item.expiresAt as Date).getTime();
		expect(Math.abs(expiresMs - (Date.now() + 90 * 86_400_000))).toBeLessThan(
			86_400_000,
		);
		const provenance = svcDb
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(eq(schema.memoryProfileItemProvenance.itemId, item.id))
			.all();
		expect(provenance).toEqual([
			expect.objectContaining({
				sourceType: "conversation",
				sourceId: "c1",
			}),
		]);
		expect(
			svcDb
				.select()
				.from(schema.memoryProfileItems)
				.where(eq(schema.memoryProfileItems.status, "review_needed"))
				.all(),
		).toEqual([]);
	});

	it("retiring the legacy review backlog frees the review cap so inferred facts reach review again", async () => {
		const { db, sqlite } = openSeedDatabase();
		seedUserAndConversation({ db });
		seedMessages({
			db,
			conversationId: "c1",
			entries: [
				{ role: "user", content: "Mentoring Anna again this week." },
				{ role: "assistant", content: "Nice." },
			],
		});
		const inferred = {
			decisions: [
				{
					action: "add",
					statement: "I am mentoring a colleague this quarter.",
					category: "goals_ongoing_work",
					scope: "global",
					confidence: "inferred",
					expiryClass: "durable",
					sourceQuote: "Mentoring Anna again",
				},
			],
		};
		mockControlModel(inferred);

		// Ten prod-shaped legacy backlog items, each with its open legacy row.
		const { createMemoryProfileItem, setMemoryProfileItemMetadataAndExpiry } =
			await import("../memory-profile/projection-store");
		const { createOrUpdateMemoryReviewItem, legacyReviewSubjectKey } =
			await import("../memory-profile/review");
		for (let i = 0; i < 10; i++) {
			const statement = `Legacy candidate number ${i}.`;
			const item = await createMemoryProfileItem({
				userId: "u1",
				category: "preferences",
				scope: { type: "global" },
				statement,
				status: "review_needed",
			});
			await setMemoryProfileItemMetadataAndExpiry({
				userId: "u1",
				itemId: item.id,
				metadataJson: JSON.stringify({
					source: "legacy_memory_curation",
					legacyCurationDecision: "review",
				}),
			});
			await createOrUpdateMemoryReviewItem({
				userId: "u1",
				subjectKey: legacyReviewSubjectKey({
					category: "preferences",
					statement,
				}),
				subjectLabel: statement,
				question: "Should AlfyAI remember this?",
				reason: "Legacy memory needs confirmation before becoming active.",
				affectedItemIds: [item.id],
				metadata: {
					source: "legacy_memory_curation",
					category: "preferences",
					proposedStatement: statement,
				},
			});
		}

		const { runMemoryJudgeOnSegment } = await import("./index");
		await expect(
			runMemoryJudgeOnSegment({
				userId: "u1",
				conversationId: "c1",
				trigger: "idle",
			}),
		).resolves.toMatchObject({ status: "ran", review: 0 });

		const { readFileSync } = await import("node:fs");
		const migration = readFileSync(
			"./drizzle/1777140000101_retire_legacy_review_backlog.sql",
			"utf8",
		);
		for (const statement of migration.split("--> statement-breakpoint")) {
			if (statement.trim()) sqlite.exec(statement);
		}

		const { getMemoryProfileReadModel } = await import(
			"../memory-profile/read-model"
		);
		expect(
			(await getMemoryProfileReadModel({ userId: "u1" })).review.openCount,
		).toBe(0);

		db.insert(schema.messages)
			.values([
				{
					id: "msg-late-1",
					conversationId: "c1",
					messageSequence: 3,
					role: "user",
					content: "Anna and I meet every Friday now.",
					createdAt: new Date(NOW.getTime() + 10 * 60_000),
				},
				{
					id: "msg-late-2",
					conversationId: "c1",
					messageSequence: 4,
					role: "assistant",
					content: "Great.",
					createdAt: new Date(NOW.getTime() + 11 * 60_000),
				},
			])
			.run();
		await expect(
			runMemoryJudgeOnSegment({
				userId: "u1",
				conversationId: "c1",
				trigger: "idle",
			}),
		).resolves.toMatchObject({ status: "ran", review: 1 });
	});

	describe("update/strengthen target handling", () => {
		const decision = (over: Record<string, unknown>) => ({
			action: "update",
			statement: "I live in Amsterdam.",
			category: "about_you",
			scope: "global",
			confidence: "stated",
			expiryClass: "durable",
			sourceQuote: "moved to Amsterdam",
			...over,
		});

		async function setup(decisions: Array<Record<string, unknown>>) {
			const { db, sqlite } = openSeedDatabase();
			seedUserAndConversation({ db });
			seedMessages({
				db,
				conversationId: "c1",
				entries: [
					{ role: "user", content: "I moved to Amsterdam." },
					{ role: "assistant", content: "Noted." },
				],
			});
			mockControlModel({ decisions });
			return { db, sqlite };
		}

		async function createFact(params: {
			statement: string;
			category?: "about_you" | "preferences";
			slotKey?: string;
			scope?: { type: "global" } | { type: "project"; id: string };
		}) {
			const { createMemoryProfileItem } = await import(
				"../memory-profile/projection-store"
			);
			return createMemoryProfileItem({
				userId: "u1",
				category: params.category ?? "about_you",
				scope: params.scope ?? { type: "global" },
				statement: params.statement,
				...(params.slotKey ? { slotKey: params.slotKey } : {}),
			});
		}

		async function run() {
			const { runMemoryJudgeOnSegment } = await import("./index");
			return runMemoryJudgeOnSegment({
				userId: "u1",
				conversationId: "c1",
				trigger: "idle",
			});
		}

		async function telemetry() {
			const { listMemoryReworkTelemetry } = await import(
				"../memory-profile/telemetry"
			);
			return listMemoryReworkTelemetry({ userId: "u1" });
		}

		async function activeStatements() {
			const { getActiveMemoryProfileContext } = await import(
				"../memory-profile/active-context"
			);
			return (await getActiveMemoryProfileContext({ userId: "u1" })).items.map(
				(i) => i.statement,
			);
		}

		it("applies an update whose targetItemId echoes the prompt's [brackets]", async () => {
			await setup([]);
			const existing = await createFact({ statement: "I live in Budapest." });
			mockControlModel({
				decisions: [decision({ targetItemId: `[${existing.id}]` })],
			});
			await expect(run()).resolves.toMatchObject({ updated: 1, admitted: 0 });
			expect(await activeStatements()).toEqual(["I live in Amsterdam."]);
		});

		it("resolves an update without targetItemId to the unique exact match and applies it", async () => {
			await setup([]);
			const existing = await createFact({ statement: "I live in Budapest." });
			mockControlModel({
				decisions: [
					decision({ action: "strengthen", statement: "I live in budapest!" }),
				],
			});
			await expect(run()).resolves.toMatchObject({ updated: 1, admitted: 0 });
			const { db: svcDb } = await import("$lib/server/db");
			const provenance = svcDb
				.select()
				.from(schema.memoryProfileItemProvenance)
				.where(eq(schema.memoryProfileItemProvenance.itemId, existing.id))
				.all();
			expect(provenance).toHaveLength(1);
			expect(
				(await telemetry()).filter(
					(r) => r.eventName === "judge_target_resolved",
				),
			).toEqual([expect.objectContaining({ reason: "statement_match" })]);
		});

		it("rejects an update without targetItemId and without a match instead of adding a contradicting fact", async () => {
			await setup([decision({})]);
			await createFact({ statement: "I live in Budapest." });
			await expect(run()).resolves.toMatchObject({ updated: 0, admitted: 0 });
			expect(await activeStatements()).toEqual(["I live in Budapest."]);
			const rows = await telemetry();
			expect(
				rows.filter((r) => r.eventName === "judge_target_resolved"),
			).toEqual([]);
			expect(
				rows.filter((r) => r.eventName === "judge_candidate_rejected"),
			).toEqual([expect.objectContaining({ reason: "missing_target" })]);
		});

		it("keeps rejecting an ambiguous missing target, with missing_target telemetry", async () => {
			await setup([decision({ statement: "I live in Budapest." })]);
			await createFact({
				statement: "I live in Budapest.",
				slotKey: "memory-slot:test:home-a",
			});
			await createFact({
				statement: "I live in Budapest",
				slotKey: "memory-slot:test:home-b",
			});
			await expect(run()).resolves.toMatchObject({ updated: 0, admitted: 0 });
			expect(
				(await telemetry()).filter(
					(r) => r.eventName === "judge_candidate_rejected",
				),
			).toEqual([expect.objectContaining({ reason: "missing_target" })]);
		});

		it("records telemetry instead of silently dropping an update whose target is not an active fact", async () => {
			await setup([]);
			const { createMemoryProfileItem } = await import(
				"../memory-profile/projection-store"
			);
			const pending = await createMemoryProfileItem({
				userId: "u1",
				category: "about_you",
				scope: { type: "global" },
				statement: "I live in Budapest.",
				status: "review_needed",
			});
			mockControlModel({ decisions: [decision({ targetItemId: pending.id })] });
			await expect(run()).resolves.toMatchObject({ updated: 0, admitted: 0 });
			expect(
				(await telemetry()).filter(
					(r) => r.eventName === "judge_candidate_rejected",
				),
			).toEqual([expect.objectContaining({ reason: "target_not_active" })]);
		});

		it("records telemetry instead of silently dropping an update aimed at a user_authored fact", async () => {
			await setup([]);
			const existing = await createFact({ statement: "I live in Budapest." });
			const { mergeMemoryProfileItemMetadata } = await import(
				"../memory-profile/projection-store"
			);
			await mergeMemoryProfileItemMetadata({
				userId: "u1",
				itemId: existing.id,
				patch: { origin: "user_authored" },
			});
			mockControlModel({
				decisions: [decision({ targetItemId: existing.id })],
			});
			await expect(run()).resolves.toMatchObject({ updated: 0 });
			expect(await activeStatements()).toEqual(["I live in Budapest."]);
			expect(
				(await telemetry()).filter(
					(r) => r.eventName === "judge_candidate_rejected",
				),
			).toEqual([expect.objectContaining({ reason: "target_user_authored" })]);
		});

		it("skips an update or strengthen aimed at a fact the user accepted in review, with target_user_protected telemetry", async () => {
			await setup([]);
			const { createMemoryProfileItem } = await import(
				"../memory-profile/projection-store"
			);
			const {
				applyMemoryReviewItemWithRevision,
				createOrUpdateMemoryReviewItem,
			} = await import("../memory-profile/review");
			const { getMemoryProfileReadModel } = await import(
				"../memory-profile/read-model"
			);
			const pending = await createMemoryProfileItem({
				userId: "u1",
				category: "about_you",
				scope: { type: "global" },
				statement: "I live in Budapest.",
				status: "review_needed",
			});
			const reviewRow = await createOrUpdateMemoryReviewItem({
				userId: "u1",
				subjectKey: `judge:${pending.itemKey}`,
				subjectLabel: "I live in Budapest.",
				question: "Should I keep remembering this?",
				reason: "Inferred from conversation, not stated directly.",
				affectedItemIds: [pending.id],
				metadata: {
					source: "memory_judge",
					category: "about_you",
					proposedStatement: "I live in Budapest.",
				},
			});
			const profile = await getMemoryProfileReadModel({ userId: "u1" });
			await expect(
				applyMemoryReviewItemWithRevision({
					userId: "u1",
					reviewItemId: reviewRow.id,
					expectedProjectionRevision: profile.projectionRevision,
					action: "accept",
				}),
			).resolves.toMatchObject({ status: "updated", itemId: pending.id });

			mockControlModel({
				decisions: [
					decision({ targetItemId: pending.id }),
					decision({
						action: "strengthen",
						statement: "I live in Budapest.",
						targetItemId: pending.id,
					}),
				],
			});
			await expect(run()).resolves.toMatchObject({ updated: 0 });
			expect(await activeStatements()).toEqual(["I live in Budapest."]);
			expect(
				(await telemetry())
					.filter((r) => r.eventName === "judge_candidate_rejected")
					.map((r) => r.reason),
			).toEqual(["target_user_protected", "target_user_protected"]);
		});

		it("shows project-scoped facts to the judge so they can be targeted", async () => {
			const { db } = await setup([]);
			db.insert(schema.projects)
				.values({ id: "p1", userId: "u1", name: "Thesis" })
				.run();
			db.update(schema.conversations)
				.set({ projectId: "p1" })
				.where(eq(schema.conversations.id, "c1"))
				.run();
			const existing = await createFact({
				statement: "I write my thesis in LaTeX.",
				category: "preferences",
				scope: { type: "project", id: "p1" },
			});
			mockControlModel({
				decisions: [
					decision({
						action: "strengthen",
						targetItemId: existing.id,
						statement: "I write my thesis in LaTeX.",
						category: "preferences",
						scope: "project",
					}),
				],
			});
			await expect(run()).resolves.toMatchObject({ updated: 1 });
			const userMessage = String(
				sendJsonControlMessageMock.mock.calls.at(-1)?.[0] ?? "",
			);
			expect(userMessage).toContain(`[${existing.id}]`);
		});

		it("dry-run resolves targets but writes nothing", async () => {
			process.env.MEMORY_JUDGE_DRY_RUN = "true";
			await setup([]);
			const existing = await createFact({ statement: "I live in Budapest." });
			mockControlModel({
				decisions: [
					decision({ action: "update", statement: "I live in Budapest!" }),
					decision({}),
				],
			});
			await expect(run()).resolves.toMatchObject({
				dryRun: true,
				updated: 0,
				admitted: 0,
			});
			expect(await activeStatements()).toEqual(["I live in Budapest."]);
			const { db: svcDb } = await import("$lib/server/db");
			const row = svcDb
				.select()
				.from(schema.memoryProfileItems)
				.where(eq(schema.memoryProfileItems.id, existing.id))
				.all()[0];
			expect(row.revision).toBe(existing.revision);
			expect(
				(await telemetry())
					.filter((r) => r.eventName === "judge_dry_run_decision")
					.map((r) => r.metadata.targetResolution),
			).toEqual(["statement_match"]);
		});
	});
});
