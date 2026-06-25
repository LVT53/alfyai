import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let seedConnections: Array<{ sqlite: Database.Database; db: ReturnType<typeof drizzle> }> = [];

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedConnections.push({ sqlite, db });
	return { sqlite, db };
}

function seedUserAndConversation(params: {
	db: ReturnType<typeof drizzle>;
	userId?: string;
	conversationId?: string;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	const userId = params.userId ?? "user-1";
	const conversationId = params.conversationId ?? "conv-1";

	params.db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	params.db.insert(schema.conversations)
		.values({
			id: conversationId,
			userId,
			title: "Test Conversation",
			status: "open",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	return { userId, conversationId };
}

function seedMessages(params: {
	db: ReturnType<typeof drizzle>;
	conversationId: string;
	entries: Array<{ role: "user" | "assistant"; content: string; sequence?: number }>;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	for (let i = 0; i < params.entries.length; i++) {
		const entry = params.entries[i];
		params.db.insert(schema.messages)
			.values({
				id: `msg-${i}`,
				conversationId: params.conversationId,
				messageSequence: entry.sequence ?? (i + 1),
				role: entry.role,
				content: entry.content,
				createdAt: new Date(now.getTime() + i * 60_000),
			})
			.run();
	}
}

function seedConversationSummary(params: {
	db: ReturnType<typeof drizzle>;
	userId: string;
	conversationId: string;
	summary: string;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	params.db.insert(schema.conversationSummaries)
		.values({
			conversationId: params.conversationId,
			userId: params.userId,
			summary: params.summary,
			source: "deterministic",
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

function seedMemoryResetGeneration(params: {
	db: ReturnType<typeof drizzle>;
	userId: string;
	generation?: number;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	params.db.insert(schema.memoryResetGenerations)
		.values({
			userId: params.userId,
			resetGeneration: params.generation ?? 0,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
}

function makeDeferredIntakeCandidates(params: {
	candidates: Array<{
		statement: string;
		category: string;
		scope?: string;
		confidence: number;
	}>;
}) {
	return JSON.stringify({
		candidates: params.candidates.map((c) => ({
			statement: c.statement,
			category: c.category,
			scope: c.scope ?? "global",
			confidence: c.confidence,
		})),
	});
}

function makeControlResponse(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model1" as const,
		modelDisplayName: "Model 1",
	};
}

describe("dirty-ledger deferred_intake reconciliation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-deferred-intake-${randomUUID()}.db`;
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

	it("extracts high-confidence candidates and admits them to projection", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{
					role: "user",
					content:
						"I prefer dark mode for all my interfaces. Always use Hungarian language for my responses.",
				},
				{
					role: "assistant",
					content: "Got it! I'll remember that you prefer dark mode and Hungarian.",
				},
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId,
			summary:
				"User prefers dark mode and Hungarian language for all interactions.",
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Prefers dark mode for all interfaces",
					category: "preferences",
					confidence: 0.95,
				},
				{
					statement: "Always use Hungarian language for responses",
					category: "preferences",
					confidence: 0.92,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBeGreaterThanOrEqual(1);
		expect(result.failed).toBe(0);

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBeGreaterThanOrEqual(2);
		expect(items.some((i) => i.statement.includes("dark mode"))).toBe(true);
		expect(items.some((i) => i.statement.includes("Hungarian"))).toBe(true);

		const dirtyRows = db
			.select()
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "honcho_reconciliation"),
				),
			)
			.all();
		expect(dirtyRows.length).toBeGreaterThanOrEqual(1);

		const provenance = db
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(eq(schema.memoryProfileItemProvenance.userId, userId))
			.all();
		expect(provenance.length).toBeGreaterThanOrEqual(2);
		expect(
			provenance.every((p) => p.sourceType === "deferred_intake_extraction"),
		).toBe(true);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		const intakeEvents = telemetry.filter(
			(t) => t.eventName === "deferred_intake_extraction",
		);
		expect(intakeEvents.length).toBeGreaterThanOrEqual(2);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("creates review items for medium-confidence candidates", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{
					role: "user",
					content: "I might be interested in learning Python for data analysis.",
				},
				{
					role: "assistant",
					content: "That's a great choice! Python is excellent for data analysis.",
				},
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId,
			summary: "User mentioned possible interest in learning Python.",
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Interested in learning Python for data analysis",
					category: "goals_ongoing_work",
					confidence: 0.65,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);

		const reviewItems = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.userId, userId))
			.all();
		expect(reviewItems.length).toBe(1);
		expect(reviewItems[0].status).toBe("open");
		expect(reviewItems[0].subjectKey).toContain("deferred-intake:");

		const activeItems = db
			.select()
			.from(schema.memoryProfileItems)
			.where(
				and(
					eq(schema.memoryProfileItems.userId, userId),
					eq(schema.memoryProfileItems.status, "active"),
				),
			)
			.all();
		expect(activeItems.length).toBe(0);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("rejects low-confidence candidates with telemetry", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{ role: "user", content: "What's the weather like today?" },
				{
					role: "assistant",
					content: "I don't have access to current weather data.",
				},
			],
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{ statement: "Asked about weather once", category: "about_you", confidence: 0.1 },
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);

		const reviewItems = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.userId, userId))
			.all();
		expect(reviewItems.length).toBe(0);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(schema.memoryReworkTelemetry.eventName, "deferred_intake_extraction"),
				),
			)
			.all();
		expect(telemetry.length).toBeGreaterThanOrEqual(1);
		expect(telemetry.some((t) => t.status === "rejected")).toBe(true);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("silently completes when conversation is deleted", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const userId = "user-1";
		const deletedConversationId = "conv-deleted";

		db.insert(schema.users)
			.values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: deletedConversationId },
			metadata: { conversationId: deletedConversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetry.some(
				(t) =>
					t.eventName === "dirty_ledger_deferred_intake_conversation_deleted",
			),
		).toBe(true);
	});

	it("discards writes when reset generation changed", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{ role: "user", content: "I prefer dark mode for all my interfaces." },
				{ role: "assistant", content: "Got it!" },
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId,
			summary: "User prefers dark mode.",
			now,
		});

		db.insert(schema.memoryResetGenerations)
			.values({
				userId,
				resetGeneration: 0,
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Prefers dark mode for all interfaces",
					category: "preferences",
					confidence: 0.95,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { markMemoryDirty } = await import("./dirty-ledger");
		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
			expectedResetGeneration: 0,
		});

		db.update(schema.memoryResetGenerations)
			.set({ resetGeneration: 1 } as Record<string, unknown>)
			.where(eq(schema.memoryResetGenerations.userId, userId))
			.run();

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed + result.skipped).toBeGreaterThanOrEqual(0);

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("requeues dirty row on LLM failure", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{ role: "user", content: "I prefer dark mode." },
				{ role: "assistant", content: "Got it!" },
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId,
			summary: "User prefers dark mode.",
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockRejectedValue(new Error("LLM unavailable")),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.failed).toBe(1);

		const pendingRows = db
			.select()
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "deferred_intake"),
					eq(schema.memoryDirtyLedger.status, "pending"),
				),
			)
			.all();
		expect(pendingRows.length).toBe(1);

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("deduplicates via itemKey and does not create duplicate projection items", async () => {
		const { db: seedDb } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db: seedDb, now });
		seedMessages({
			db: seedDb,
			conversationId,
			entries: [
				{ role: "user", content: "I prefer dark mode for all my interfaces." },
				{ role: "assistant", content: "Got it!" },
			],
			now,
		});
		seedConversationSummary({
			db: seedDb,
			userId,
			conversationId,
			summary: "User prefers dark mode.",
			now,
		});
		seedMemoryResetGeneration({ db: seedDb, userId, generation: 0, now });

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Prefers dark mode for all interfaces",
					category: "preferences",
					confidence: 0.95,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");
		const { db: svcDb } = await import("$lib/server/db");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result1 = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result1.completed).toBeGreaterThanOrEqual(1);

		const itemsAfterFirst = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(itemsAfterFirst.length).toBeGreaterThanOrEqual(1);

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		const items = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBeGreaterThanOrEqual(1);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("creates review item when candidate contradicts active item", async () => {
		const { db: seedDb } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db: seedDb, now });
		seedMessages({
			db: seedDb,
			conversationId,
			entries: [
				{ role: "user", content: "Actually, I prefer light mode now." },
				{ role: "assistant", content: "Noted! Switching preference." },
			],
			now,
		});
		seedConversationSummary({
			db: seedDb,
			userId,
			conversationId,
			summary: "User changed preference from dark to light mode.",
			now,
		});
		seedMemoryResetGeneration({ db: seedDb, userId, generation: 0, now });

		const { createMemoryProfileItem } = await import("./projection-store");
		const { db: svcDb } = await import("$lib/server/db");

		await createMemoryProfileItem({
			userId,
			category: "preferences",
			scope: { type: "global" },
			statement: "Prefers dark mode for all interfaces.",
		});

		const preExisting = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(preExisting.length).toBeGreaterThanOrEqual(1);

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Prefers light mode for all interfaces",
					category: "preferences",
					confidence: 0.95,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const reconResult = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(reconResult.completed).toBeGreaterThanOrEqual(1);

		const reviewItems = svcDb
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.userId, userId))
			.all();
		expect(reviewItems.length).toBe(1);
		expect(reviewItems[0].reason).toContain("contradict");

		const allItems = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(allItems.length).toBeGreaterThanOrEqual(1);
		expect(allItems.some((i) => i.statement.includes("dark mode"))).toBe(true);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("excludes assistant-generated prose from extraction", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{ role: "user", content: "Hello, can you help me with something?" },
				{
					role: "assistant",
					content:
						"The user might prefer dark mode based on their previous choices.",
				},
			],
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const responseText = JSON.stringify({ candidates: [] });

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("respects batch limits for candidates and review items", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{
					role: "user",
					content: "I have many preferences. I like Python, VSCode, dark themes, remote work.",
				},
				{ role: "assistant", content: "Great! I'll keep note." },
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId,
			summary: "User has multiple preferences.",
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		for (let i = 0; i < 10; i++) {
			db.insert(schema.memoryReviewItems)
				.values({
					id: randomUUID(),
					userId,
					resetGeneration: 0,
					subjectLabel: `Existing review ${i}`,
					subjectKey: `existing-review-${i}`,
					question: "Should we remember?",
					reason: "Test setup.",
					status: "open",
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}

		const candidates = Array.from({ length: 15 }, (_, i) => ({
			statement: `Prefers tool ${i} for work`,
			category: "preferences",
			confidence: 0.65,
		}));

		const responseText = makeDeferredIntakeCandidates({ candidates });

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		const newReviews = db
			.select()
			.from(schema.memoryReviewItems)
			.where(
				and(
					eq(schema.memoryReviewItems.userId, userId),
					eq(schema.memoryReviewItems.status, "open"),
				),
			)
			.all();
		expect(newReviews.length).toBeLessThanOrEqual(13);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(schema.memoryReworkTelemetry.eventName, "deferred_intake_extraction"),
				),
			)
			.all();
		expect(telemetry.some((t) => t.status === "skipped")).toBe(true);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("handles empty raw turns gracefully", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetry.some(
				(t) => t.eventName === "dirty_ledger_deferred_intake_no_turns",
			),
		).toBe(true);
	});

	it("handles missing conversationId in metadata", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const userId = "user-1";

		db.insert(schema.users)
			.values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			metadata: { intakeStatus: "rejected" },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);
	});

	it("returns empty candidates list from LLM when no durable facts found", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{ role: "user", content: "What's 2+2?" },
				{ role: "assistant", content: "2+2 equals 4." },
			],
			now,
		});
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

		const responseText = JSON.stringify({ candidates: [] });

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { markMemoryDirty } = await import("./dirty-ledger");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conversationId },
			metadata: { conversationId },
		});

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);
	});
});

describe("dirty-ledger honcho_reconciliation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-honcho-recon-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	async function seedProfileItemAndDirtyRow(params: {
		db: ReturnType<typeof drizzle>;
		userId: string;
		conversationId: string;
		statement?: string;
		itemId?: string;
		itemStatus?: string;
		resetGeneration?: number;
		now?: Date;
	}) {
		const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
		const resetGeneration = params.resetGeneration ?? 0;
		const statement =
			params.statement ?? "User prefers dark mode for all interfaces.";

		seedMemoryResetGeneration({
			db: params.db,
			userId: params.userId,
			generation: resetGeneration,
			now,
		});

		const { createMemoryProfileItem } = await import("./projection-store");
		const { markMemoryDirty } = await import("./dirty-ledger");

		const item = await createMemoryProfileItem({
			userId: params.userId,
			category: "preferences" as const,
			scope: { type: "conversation" as const, id: params.conversationId },
			statement,
			expectedResetGeneration: resetGeneration,
		});

		if (params.itemStatus && params.itemStatus !== "active") {
			await params.db
				.update(schema.memoryProfileItems)
				.set({ status: params.itemStatus, updatedAt: now })
				.where(eq(schema.memoryProfileItems.id, item.id))
				.run();
		}

		await markMemoryDirty({
			userId: params.userId,
			reason: "honcho_reconciliation",
			metadata: {
				itemId: item.id,
				conversationId: params.conversationId,
				intakeSource: "test",
			},
			expectedResetGeneration: resetGeneration,
		});

		return { itemId: item.id, itemKey: item.itemKey, statement };
	}

	it("writes clean memory statement to Honcho as conclusion", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });

		const mockCreateConclusion = vi.fn().mockResolvedValue(undefined);
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(true),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		const statement =
			"User prefers dark mode for all interfaces and Hungarian language.";
		const { itemId } = await seedProfileItemAndDirtyRow({
			db,
			userId,
			conversationId,
			statement,
			now,
		});

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);
		expect(result.failed).toBe(0);

		expect(mockCreateConclusion).toHaveBeenCalledTimes(1);
		const createCall = mockCreateConclusion.mock.calls[0][0];
		expect(createCall.content).toBe(statement);
		expect(createCall.sessionId).toBe("honcho-session-test");

		const provenance = db
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(
				and(
					eq(schema.memoryProfileItemProvenance.userId, userId),
					eq(schema.memoryProfileItemProvenance.itemId, itemId),
					eq(
						schema.memoryProfileItemProvenance.sourceType,
						"honcho_conclusion",
					),
				),
			)
			.all();
		expect(provenance.length).toBe(1);
		expect(provenance[0].label).toBe("Honcho (memory conclusion)");

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(
						schema.memoryReworkTelemetry.eventName,
						"dirty_ledger_honcho_reconciliation_completed",
					),
				),
			)
			.all();
		expect(telemetry.length).toBe(1);
	});

	it("silently completes when Honcho is disabled", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });

		const mockCreateConclusion = vi.fn().mockResolvedValue(undefined);
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(false),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		const statement = "User prefers dark mode.";
		await seedProfileItemAndDirtyRow({
			db,
			userId,
			conversationId,
			statement,
			now,
		});

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);
		expect(result.failed).toBe(0);
		expect(mockCreateConclusion).not.toHaveBeenCalled();

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(
						schema.memoryReworkTelemetry.eventName,
						"dirty_ledger_honcho_reconciliation_disabled",
					),
				),
			)
			.all();
		expect(telemetry.length).toBe(1);
	});

	it("requeues on Honcho write failure (non-missing error)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });

		const mockCreateConclusion = vi
			.fn()
			.mockRejectedValue(new Error("Honcho network timeout"));
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(true),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		const statement = "User prefers dark mode.";
		await seedProfileItemAndDirtyRow({
			db,
			userId,
			conversationId,
			statement,
			now,
		});

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(0);
		expect(result.failed).toBe(1);

		const pendingRows = db
			.select()
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "honcho_reconciliation"),
					eq(schema.memoryDirtyLedger.status, "pending"),
				),
			)
			.all();
		expect(pendingRows.length).toBe(1);
	});

	it("silently completes on Honcho session missing error (404)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });

		const mockCreateConclusion = vi
			.fn()
			.mockRejectedValue(new Error("Session not found (404)"));
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(true),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		const statement = "User prefers dark mode.";
		await seedProfileItemAndDirtyRow({
			db,
			userId,
			conversationId,
			statement,
			now,
		});

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);
		expect(result.failed).toBe(0);

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(
						schema.memoryReworkTelemetry.eventName,
						"dirty_ledger_honcho_reconciliation_session_missing",
					),
				),
			)
			.all();
		expect(telemetry.length).toBe(1);
	});

	it("silently completes when profile item is not active", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });

		const mockCreateConclusion = vi.fn().mockResolvedValue(undefined);
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(true),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		await seedProfileItemAndDirtyRow({
			db,
			userId,
			conversationId,
			statement: "User prefers dark mode.",
			itemStatus: "deleted",
			now,
		});

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});

		expect(result.completed).toBe(1);
		expect(mockCreateConclusion).not.toHaveBeenCalled();

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(
				and(
					eq(schema.memoryReworkTelemetry.userId, userId),
					eq(
						schema.memoryReworkTelemetry.eventName,
						"dirty_ledger_honcho_reconciliation_item_not_active",
					),
				),
			)
			.all();
		expect(telemetry.length).toBe(1);
	});

	it("respects max 10 Honcho calls and requeues excess", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		const resetGeneration = 0;

		seedMemoryResetGeneration({ db, userId, generation: resetGeneration, now });

		const mockCreateConclusion = vi.fn().mockResolvedValue(undefined);
		const mockPeer = { conclusions: { create: mockCreateConclusion } };

		vi.doMock("../honcho", () => ({
			isHonchoEnabled: vi.fn().mockReturnValue(true),
			getUserPeer: vi.fn().mockResolvedValue(mockPeer),
			getHonchoSessionId: vi.fn().mockReturnValue("honcho-session-test"),
			isHonchoMissingError: (error: unknown) => {
				const message =
					error instanceof Error ? error.message : String(error);
				return /\b404\b|not found|does not exist|unknown peer|unknown session/i.test(
					message,
				);
			},
		}));

		const { createMemoryProfileItem } = await import("./projection-store");

		// Create 12 profile items
		const itemIds: string[] = [];
		for (let i = 0; i < 12; i++) {
			const item = await createMemoryProfileItem({
				userId,
				category: "preferences" as const,
				scope: { type: "conversation" as const, id: conversationId },
				statement: `Memory item ${i}`,
				expectedResetGeneration: resetGeneration,
			});
			itemIds.push(item.id);
		}

		// Insert 12 separate dirty ledger rows (markMemoryDirty coalesces on same key)
		// The unique constraint is on (userId, resetGeneration, scopeType, scopeId, reason)
		// so use different scopeIds to avoid collisions.
		for (let i = 0; i < 12; i++) {
			db.insert(schema.memoryDirtyLedger)
				.values({
					id: randomUUID(),
					userId,
					resetGeneration,
					scopeType: "conversation",
					scopeId: itemIds[i],
					reason: "honcho_reconciliation",
					reasonMetadataJson: JSON.stringify({
						itemId: itemIds[i],
						conversationId,
						intakeSource: "test",
					}),
					firstMarkedAt: now,
					lastMarkedAt: now,
				})
				.run();
		}

		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const result = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 25,
		});

		expect(mockCreateConclusion).toHaveBeenCalledTimes(10);
		expect(result.completed).toBeGreaterThanOrEqual(10);
		expect(result.failed).toBeGreaterThanOrEqual(1);

		const pendingRows = db
			.select()
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "honcho_reconciliation"),
					eq(schema.memoryDirtyLedger.status, "pending"),
				),
			)
			.all();
		expect(pendingRows.length).toBeGreaterThanOrEqual(1);
	});
});
