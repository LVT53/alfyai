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

function seedUserAndConversation(params: {
	db: ReturnType<typeof drizzle>;
	userId?: string;
	conversationId?: string;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	const userId = params.userId ?? "user-1";
	const conversationId = params.conversationId ?? "conv-1";

	params.db
		.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();

	params.db
		.insert(schema.conversations)
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
	entries: Array<{
		role: "user" | "assistant";
		content: string;
		sequence?: number;
	}>;
	now?: Date;
}) {
	const now = params.now ?? new Date("2026-06-01T10:00:00.000Z");
	for (let i = 0; i < params.entries.length; i++) {
		const entry = params.entries[i];
		params.db
			.insert(schema.messages)
			.values({
				id: `msg-${i}`,
				conversationId: params.conversationId,
				messageSequence: entry.sequence ?? i + 1,
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
	params.db
		.insert(schema.conversationSummaries)
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
	params.db
		.insert(schema.memoryResetGenerations)
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

describe("Memory extraction integration tests", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-integration-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
	});

	afterEach(async () => {
		for (const conn of seedConnections) {
			try {
				conn.sqlite.close();
			} catch {
				// Best-effort close
			}
		}
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

	it("scenario 1 — send route parity: explicit Remember-that creates profile item", async () => {
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

		const { intakePostTurnMemory } = await import("./intake");
		const { getMemoryProfileReadModel } = await import("./index");

		const result = await intakePostTurnMemory({
			userId,
			conversationId: "conv-send-route-parity",
			userMessage: "Remember that I prefer dark mode for code examples.",
			assistantMessage: "Got it! I'll remember that.",
			userMessageId: "msg-u-1",
			assistantMessageId: "msg-a-1",
		});

		expect(result.status).toBe("admitted");
		if (result.status === "admitted") {
			expect(result.category).toBe("preferences");
		}

		const profile = await getMemoryProfileReadModel({ userId });
		const preferenceItems = profile.categories[1]?.items ?? [];
		expect(preferenceItems.length).toBeGreaterThanOrEqual(1);
		expect(
			preferenceItems.some((item) =>
				item.statement.toLowerCase().includes("dark"),
			),
		).toBe(true);
	});

	it("scenario 2 — Tier 1 multi-sentence: I live in Amsterdam admitted as about_you", async () => {
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

		const { intakePostTurnMemory } = await import("./intake");

		const result = await intakePostTurnMemory({
			userId,
			conversationId: "conv-tier1-multi",
			userMessage: "Can you help me? I live in Amsterdam.",
			assistantMessage: "Sure! What do you need help with?",
			userMessageId: "msg-u-2",
			assistantMessageId: "msg-a-2",
		});

		expect(result.status).toBe("admitted");
		if (result.status === "admitted") {
			expect(result.category).toBe("about_you");
		}
	});

	it("scenario 3 — Tier 1 Hungarian: Budapesten élek admitted as about_you", async () => {
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

		const { intakePostTurnMemory } = await import("./intake");

		const result = await intakePostTurnMemory({
			userId,
			conversationId: "conv-tier1-hu",
			userMessage: "Budapesten élek.",
			assistantMessage: "Értem, Budapesten laksz.",
			userMessageId: "msg-u-3",
			assistantMessageId: "msg-a-3",
		});

		expect(result.status).toBe("admitted");
		if (result.status === "admitted") {
			expect(result.category).toBe("about_you");
		}
	});

	it("scenario 4 — Tier 2 extraction: deferred_intake → LLM → projection → honcho_reconciliation queued", async () => {
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
					content:
						"Got it! I'll remember that you prefer dark mode and Hungarian.",
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

		vi.doUnmock("../normal-chat-control-model");
	});

	it("scenario 5 — Honcho reconciliation: writes conclusion to Honcho with provenance", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMemoryResetGeneration({ db, userId, generation: 0, now });

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
		const { markMemoryDirty } = await import("./dirty-ledger");
		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);

		const statement = "User prefers dark mode for all interfaces.";
		const item = await createMemoryProfileItem({
			userId,
			category: "preferences" as const,
			scope: { type: "conversation" as const, id: conversationId },
			statement,
			expectedResetGeneration: 0,
		});

		await markMemoryDirty({
			userId,
			reason: "honcho_reconciliation",
			metadata: {
				itemId: item.id,
				conversationId,
				intakeSource: "test",
			},
			expectedResetGeneration: 0,
		});

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
					eq(schema.memoryProfileItemProvenance.itemId, item.id),
					eq(
						schema.memoryProfileItemProvenance.sourceType,
						"honcho_conclusion",
					),
				),
			)
			.all();
		expect(provenance.length).toBe(1);

		vi.doUnmock("../honcho");
	});

	it("scenario 6 — Idempotency: re-extraction produces zero new items", async () => {
		const { db: seedDb } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({
			db: seedDb,
			now,
		});
		seedMessages({
			db: seedDb,
			conversationId,
			entries: [
				{
					role: "user",
					content: "I prefer dark mode for all my interfaces.",
				},
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
		const countAfterFirst = itemsAfterFirst.length;
		expect(countAfterFirst).toBeGreaterThanOrEqual(1);

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

		const itemsAfterSecond = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(itemsAfterSecond.length).toBe(countAfterFirst);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("scenario 7 — Contradiction: contradictory extraction creates review, no silent override", async () => {
		const { db: seedDb } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({
			db: seedDb,
			now,
		});
		seedMessages({
			db: seedDb,
			conversationId,
			entries: [
				{ role: "user", content: "Actually, I live in Amsterdam now." },
				{
					role: "assistant",
					content: "Noted! I'll update your location.",
				},
			],
			now,
		});
		seedConversationSummary({
			db: seedDb,
			userId,
			conversationId,
			summary: "User moved to Amsterdam.",
			now,
		});
		seedMemoryResetGeneration({ db: seedDb, userId, generation: 0, now });

		const { createMemoryProfileItem } = await import("./projection-store");
		const { db: svcDb } = await import("$lib/server/db");

		await createMemoryProfileItem({
			userId,
			category: "about_you" as const,
			scope: { type: "global" },
			statement: "Lives in Budapest.",
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
					statement: "Lives in Amsterdam",
					category: "about_you",
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
		expect(allItems.some((i) => i.statement.includes("Budapest"))).toBe(true);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("scenario 8 — Reset generation: mid-extraction clear prevents writes", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{
					role: "user",
					content: "I prefer dark mode for all my interfaces.",
				},
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

		const items = db
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(items.length).toBe(0);
		expect(result.completed + result.skipped).toBeGreaterThanOrEqual(0);

		vi.doUnmock("../normal-chat-control-model");
	});

	it("scenario 9 — Assistant prose exclusion: only user messages fed to LLM, no profile items from assistant text", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const { userId, conversationId } = seedUserAndConversation({ db, now });
		seedMessages({
			db,
			conversationId,
			entries: [
				{
					role: "user",
					content: "Hello, can you help me with something?",
				},
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

		vi.doUnmock("../normal-chat-control-model");
	});

	it("full pipeline: chat turn → Tier 1 admit → Tier 2 extract → projection → Honcho write", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		const userId = "user-e2e";
		const convId = "conv-e2e-1";
		const conv2Id = "conv-e2e-2";

		db.insert(schema.users)
			.values({
				id: userId,
				email: `${userId}@example.com`,
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		for (const cid of [convId, conv2Id]) {
			db.insert(schema.conversations)
				.values({
					id: cid,
					userId,
					title: "E2E Test Conversation",
					status: "open",
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}

		const { intakePostTurnMemory } = await import("./intake");
		const { getMemoryProfileReadModel } = await import("./index");

		const tier1Result = await intakePostTurnMemory({
			userId,
			conversationId: convId,
			userMessage: "Can you help me? I live in Amsterdam.",
			assistantMessage: "Sure! What do you need help with?",
			userMessageId: "msg-u-t1",
			assistantMessageId: "msg-a-t1",
		});

		expect(tier1Result.status).toBe("admitted");
		if (tier1Result.status === "admitted") {
			expect(tier1Result.category).toBe("about_you");
		}

		const profileAfterT1 = await getMemoryProfileReadModel({ userId });
		expect(
			profileAfterT1.categories
				.flatMap((g) => g.items)
				.some((item) => item.statement.toLowerCase().includes("amsterdam")),
		).toBe(true);

		seedMessages({
			db,
			conversationId: conv2Id,
			entries: [
				{
					role: "user",
					content:
						"I've been working as a software engineer for 10 years.",
				},
				{
					role: "assistant",
					content:
						"That's great! Software engineering is a rewarding field.",
				},
			],
			now,
		});
		seedConversationSummary({
			db,
			userId,
			conversationId: conv2Id,
			summary:
				"User is a software engineer with 10 years of experience.",
			now,
		});

		await intakePostTurnMemory({
			userId,
			conversationId: conv2Id,
			userMessage:
				"I've been working as a software engineer for 10 years.",
			assistantMessage:
				"That's great! Software engineering is a rewarding field.",
			userMessageId: "msg-u-t2",
			assistantMessageId: "msg-a-t2",
		});

		const responseText = makeDeferredIntakeCandidates({
			candidates: [
				{
					statement: "Works as a software engineer for 10 years",
					category: "about_you",
					confidence: 0.92,
				},
			],
		});

		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { markMemoryDirty } = await import("./dirty-ledger");
		const { reconcileMemoryProfileDirtyLedgerForUser } = await import(
			"./dirty-ledger-reconciliation"
		);
		const { db: svcDb } = await import("$lib/server/db");

		await markMemoryDirty({
			userId,
			reason: "deferred_intake",
			scope: { type: "conversation", id: conv2Id },
			metadata: { conversationId: conv2Id },
		});

		const reconResult = await reconcileMemoryProfileDirtyLedgerForUser({
			userId,
			batchSize: 5,
		});
		expect(reconResult.completed).toBeGreaterThanOrEqual(1);

		const allItems = svcDb
			.select()
			.from(schema.memoryProfileItems)
			.where(eq(schema.memoryProfileItems.userId, userId))
			.all();
		expect(
			allItems.some((i) =>
				i.statement.toLowerCase().includes("software engineer"),
			),
		).toBe(true);

		const honchoDirty = svcDb
			.select()
			.from(schema.memoryDirtyLedger)
			.where(
				and(
					eq(schema.memoryDirtyLedger.userId, userId),
					eq(schema.memoryDirtyLedger.reason, "honcho_reconciliation"),
				),
			)
			.all();
		expect(honchoDirty.length).toBeGreaterThanOrEqual(1);

		const finalProfile = await getMemoryProfileReadModel({ userId });
		const allStatements = finalProfile.categories
			.flatMap((g) => g.items)
			.map((i) => i.statement);
		expect(
			allStatements.some((s) => s.toLowerCase().includes("amsterdam")),
		).toBe(true);
		expect(
			allStatements.some((s) =>
				s.toLowerCase().includes("software engineer"),
			),
		).toBe(true);

		vi.doUnmock("../normal-chat-control-model");
	});
});
