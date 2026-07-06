import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;
let seedConnections: Array<{
	sqlite: Database.Database;
	db: ReturnType<typeof drizzle>;
}> = [];

const DAY_MS = 86_400_000;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedConnections.push({ sqlite, db });
	return { sqlite, db };
}

function seedUser(db: ReturnType<typeof drizzle>, userId: string, now: Date) {
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({
			userId,
			resetGeneration: 0,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
}

function seedProjectionState(
	db: ReturnType<typeof drizzle>,
	userId: string,
	now: Date,
): string {
	const id = randomUUID();
	db.insert(schema.memoryProjectionState)
		.values({
			id,
			userId,
			resetGeneration: 0,
			scopeType: "global",
			scopeId: "",
			revision: 0,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

function seedItem(
	db: ReturnType<typeof drizzle>,
	params: {
		userId: string;
		projectionStateId: string;
		id?: string;
		itemKey?: string;
		category?: string;
		statement: string;
		status?: string;
		expiresAt?: Date | null;
		metadata?: Record<string, unknown>;
		createdAt: Date;
		updatedAt: Date;
	},
): string {
	const id = params.id ?? randomUUID();
	db.insert(schema.memoryProfileItems)
		.values({
			id,
			userId: params.userId,
			projectionStateId: params.projectionStateId,
			resetGeneration: 0,
			itemKey: params.itemKey ?? `v1:${id}`,
			category: params.category ?? "about_you",
			scopeType: "global",
			scopeId: "",
			statement: params.statement,
			status: params.status ?? "active",
			revision: 0,
			expiresAt: params.expiresAt ?? null,
			metadataJson: JSON.stringify(params.metadata ?? {}),
			createdAt: params.createdAt,
			updatedAt: params.updatedAt,
		})
		.run();
	return id;
}

function readItem(db: ReturnType<typeof drizzle>, id: string) {
	const [row] = db
		.select()
		.from(schema.memoryProfileItems)
		.where(eq(schema.memoryProfileItems.id, id))
		.all();
	return row;
}

function metaOf(row: { metadataJson: string | null }): Record<string, unknown> {
	try {
		return JSON.parse(row.metadataJson ?? "{}");
	} catch {
		return {};
	}
}

function makeControlResponse(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model1" as const,
		modelDisplayName: "Model 1",
	};
}

describe("memory consolidation steps", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-consolidation-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
	});

	afterEach(async () => {
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
			// best-effort
		}
		vi.doUnmock("../normal-chat-control-model");
	});

	it("renews a time_bound fact touched recently; expires an untouched one", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const aExpires = new Date(now.getTime() + 3 * DAY_MS);
		const aId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I have a conference in three days.",
			metadata: { expiryClass: "time_bound", confidence: "stated" },
			expiresAt: aExpires,
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 2 * DAY_MS),
		});
		const bId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I had a deadline yesterday.",
			metadata: { expiryClass: "time_bound", confidence: "stated" },
			expiresAt: new Date(now.getTime() - 1 * DAY_MS),
			createdAt: new Date(now.getTime() - 45 * DAY_MS),
			updatedAt: new Date(now.getTime() - 40 * DAY_MS),
		});

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		const a = readItem(db, aId);
		const b = readItem(db, bId);
		expect(a.status).toBe("active");
		// expiresAt pushed roughly +30d from the original.
		expect(a.expiresAt?.getTime() ?? 0).toBeGreaterThan(
			aExpires.getTime() + 25 * DAY_MS,
		);
		expect(b.status).toBe("expired");

		expect(actions.some((x) => x.type === "renewed")).toBe(true);
		expect(actions.some((x) => x.type === "expired")).toBe(true);
		const renew = actions.find((x) => x.type === "renewed");
		expect(renew?.itemIds).toContain(aId);
		const expire = actions.find(
			(x) => x.type === "expired" && x.itemIds.includes(bId),
		);
		expect(expire).toBeTruthy();
	});

	it("expires overdue review-queue items and closes their open review row", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const reviewItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "Maybe they like jazz.",
			status: "review_needed",
			metadata: { confidence: "inferred" },
			expiresAt: new Date(now.getTime() - 2 * DAY_MS),
			createdAt: new Date(now.getTime() - 40 * DAY_MS),
			updatedAt: new Date(now.getTime() - 40 * DAY_MS),
		});
		const reviewRowId = randomUUID();
		db.insert(schema.memoryReviewItems)
			.values({
				id: reviewRowId,
				userId,
				resetGeneration: 0,
				subjectKey: `judge:${reviewItemId}`,
				subjectLabel: "Maybe they like jazz.",
				question: "Should I keep remembering this?",
				reason: "Inferred.",
				status: "open",
				affectedItemIdsJson: JSON.stringify([reviewItemId]),
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		const item = readItem(db, reviewItemId);
		expect(item.status).toBe("expired");
		const [reviewRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, reviewRowId))
			.all();
		expect(reviewRow.status).toBe("resolved");
		expect(
			actions.some(
				(x) => x.type === "expired" && x.itemIds.includes(reviewItemId),
			),
		).toBe(true);
	});

	it("does not renew a time_bound fact that was not touched recently (boundary)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// Expires soon (within 7d) but updatedAt is 20 days old → not renewed,
		// and not yet expired (expiresAt still in the future) → unchanged.
		const soon = new Date(now.getTime() + 4 * DAY_MS);
		const id = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I have a stale time-bound fact.",
			metadata: { expiryClass: "time_bound", confidence: "stated" },
			expiresAt: soon,
			createdAt: new Date(now.getTime() - 30 * DAY_MS),
			updatedAt: new Date(now.getTime() - 20 * DAY_MS),
		});

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		const row = readItem(db, id);
		expect(row.status).toBe("active");
		// expiresAt unchanged (SQLite stores timestamps at second granularity).
		expect(Math.floor((row.expiresAt?.getTime() ?? 0) / 1000)).toBe(
			Math.floor(soon.getTime() / 1000),
		);
		expect(actions.some((x) => x.itemIds.includes(id))).toBe(false);
	});

	it("supersedes contradicted facts and merges duplicates per model output", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const xId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am planning an exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 10 * DAY_MS),
			updatedAt: new Date(now.getTime() - 10 * DAY_MS),
		});
		const yId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I settled in Limerick for my exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 2 * DAY_MS),
			updatedAt: new Date(now.getTime() - 2 * DAY_MS),
		});
		const z1Id = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am building a swap website.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 5 * DAY_MS),
		});
		const z2Id = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I coded the backend for a swap site.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 4 * DAY_MS),
			updatedAt: new Date(now.getTime() - 4 * DAY_MS),
		});

		// Seed provenance rows for the merge members to verify copy.
		db.insert(schema.memoryProfileItemProvenance)
			.values({
				id: randomUUID(),
				itemId: z1Id,
				userId,
				resetGeneration: 0,
				sourceType: "conversation",
				sourceId: "conv-z1",
				label: "Conversation",
				summary: "swap site frontend",
				createdAt: now,
			})
			.run();
		db.insert(schema.memoryProfileItemProvenance)
			.values({
				id: randomUUID(),
				itemId: z2Id,
				userId,
				resetGeneration: 0,
				sourceType: "conversation",
				sourceId: "conv-z2",
				label: "Conversation",
				summary: "swap site backend",
				createdAt: now,
			})
			.run();

		const responseText = JSON.stringify({
			actions: [
				{ type: "supersede", winnerId: yId, loserId: xId },
				{
					type: "merge",
					itemIds: [z1Id, z2Id],
					mergedStatement: "I built the swap-site project end to end.",
					category: "about_you",
					scope: "global",
				},
			],
		});
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });

		// Supersede.
		const x = readItem(db, xId);
		expect(x.status).toBe("retired");
		expect(metaOf(x).supersededBy).toBe(yId);
		expect(readItem(db, yId).status).toBe("active");

		// Merge.
		const z1 = readItem(db, z1Id);
		const z2 = readItem(db, z2Id);
		expect(z1.status).toBe("retired");
		expect(z2.status).toBe("retired");
		const mergedInto = metaOf(z1).mergedInto as string;
		expect(typeof mergedInto).toBe("string");
		expect(metaOf(z2).mergedInto).toBe(mergedInto);

		const merged = readItem(db, mergedInto);
		expect(merged.status).toBe("active");
		expect(merged.statement).toBe("I built the swap-site project end to end.");
		expect(metaOf(merged).origin).toBe("consolidation");

		// The merged item triggers a best-effort embedding refresh. With TEI
		// unconfigured it must no-op silently (no throw, no stored embedding).
		const mergedEmbeddings = db
			.select()
			.from(schema.semanticEmbeddings)
			.where(eq(schema.semanticEmbeddings.subjectId, mergedInto))
			.all();
		expect(mergedEmbeddings.length).toBe(0);

		// Provenance copied.
		const mergedProv = db
			.select()
			.from(schema.memoryProfileItemProvenance)
			.where(eq(schema.memoryProfileItemProvenance.itemId, mergedInto))
			.all();
		expect(mergedProv.length).toBe(2);
		expect(mergedProv.some((p) => p.sourceId === "conv-z1")).toBe(true);
		expect(mergedProv.some((p) => p.sourceId === "conv-z2")).toBe(true);

		// Actions + undo.
		const supersedeAction = actions.find((a) => a.type === "superseded");
		expect(supersedeAction?.itemIds).toContain(xId);
		expect(supersedeAction?.resultItemId).toBe(yId);
		expect(
			supersedeAction?.undo.some(
				(u) => u.itemId === xId && u.prevStatus === "active",
			),
		).toBe(true);

		const mergeAction = actions.find((a) => a.type === "merged");
		expect(mergeAction?.itemIds.sort()).toEqual([z1Id, z2Id].sort());
		expect(mergeAction?.resultItemId).toBe(mergedInto);
		expect(mergeAction?.undo.length).toBe(2);
	});

	it("never touches user_authored items", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const authoredId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I authored this myself.",
			metadata: { origin: "user_authored" },
			createdAt: now,
			updatedAt: now,
		});
		const winnerId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "A newer contradicting fact.",
			metadata: { origin: "judge_v1" },
			createdAt: now,
			updatedAt: now,
		});

		const responseText = JSON.stringify({
			actions: [{ type: "supersede", winnerId, loserId: authoredId }],
		});
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });

		const authored = readItem(db, authoredId);
		expect(authored.status).toBe("active");
		expect(metaOf(authored).supersededBy).toBeUndefined();
		expect(actions.length).toBe(0);
	});
});
