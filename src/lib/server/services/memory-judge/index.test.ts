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
});
