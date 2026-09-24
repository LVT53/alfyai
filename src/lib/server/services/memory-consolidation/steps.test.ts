import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Hoisted, always-registered mock for the control model. Using a static
// vi.mock (rather than per-test vi.doMock + dynamic import) removes a
// mock-registration/import ordering race that made the supersede/merge tests
// flaky under full-suite parallelism: if the doMock factory was not applied
// before steps.ts imported the module, the real sendJsonControlMessage was
// called, threw, and runReconcileAndMerge silently returned [] (its graceful
// catch), leaving items "active" instead of "retired". The response is
// injected per test via setControlResponse().
const controlModelMock = vi.hoisted(() => ({
	response: null as ReturnType<typeof makeControlResponseValue> | null,
	sendJsonControlMessage: vi.fn(),
}));

function makeControlResponseValue(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model1" as const,
		modelDisplayName: "Model 1",
	};
}

vi.mock("../normal-chat-control-model", () => ({
	sendJsonControlMessage: (...args: unknown[]) => {
		controlModelMock.sendJsonControlMessage(...args);
		if (!controlModelMock.response) {
			throw new Error("control model response not configured for test");
		}
		return Promise.resolve(controlModelMock.response);
	},
}));

function setControlResponse(text: string) {
	controlModelMock.response = makeControlResponseValue(text);
}

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

describe("memory consolidation steps", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-consolidation-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
		controlModelMock.response = null;
		controlModelMock.sendJsonControlMessage.mockClear();
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
		setControlResponse(responseText);

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

		// Reasoning-aware token budget: 2400 base + 500 per candidate (4 here).
		// A flat budget starves large profiles: reasoning tokens count against
		// max_tokens on the OpenAI-compatible providers this runs on.
		const reconcileOptions =
			controlModelMock.sendJsonControlMessage.mock.calls.at(-1)?.[2] as {
				maxTokens?: number;
			};
		expect(reconcileOptions?.maxTokens).toBe(2400 + 500 * 4);
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
		setControlResponse(responseText);

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });

		const authored = readItem(db, authoredId);
		expect(authored.status).toBe("active");
		expect(metaOf(authored).supersededBy).toBeUndefined();
		expect(actions.length).toBe(0);
	});

	it("never supersedes, merges, or offers a user-accepted judge fact to the model", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// Accepted through Guided Memory Review: the judge origin is kept for
		// provenance, the endorsement marker makes it user-protected.
		const acceptedId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am learning Irish.",
			metadata: {
				origin: "judge_v1",
				confidence: "inferred",
				reviewResolution: "accepted",
				endorsement: "user_accepted",
				userConfirmedAt: now.toISOString(),
			},
			createdAt: now,
			updatedAt: now,
		});
		// Accepted before the explicit endorsement marker existed.
		const legacyAcceptedId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I study at night.",
			metadata: { origin: "judge_v1", reviewResolution: "accepted" },
			createdAt: now,
			updatedAt: now,
		});
		const otherId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am learning Irish slowly.",
			metadata: { origin: "judge_v1" },
			createdAt: now,
			updatedAt: now,
		});
		const otherTwoId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I study late.",
			metadata: { origin: "judge_v1" },
			createdAt: now,
			updatedAt: now,
		});

		setControlResponse(
			JSON.stringify({
				actions: [
					{ type: "supersede", winnerId: otherId, loserId: acceptedId },
					{
						type: "merge",
						itemIds: [legacyAcceptedId, otherTwoId],
						mergedStatement: "I study late at night.",
						category: "about_you",
					},
				],
			}),
		);

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });

		expect(actions).toEqual([]);
		for (const id of [acceptedId, legacyAcceptedId, otherTwoId]) {
			expect(readItem(db, id).status).toBe("active");
			expect(metaOf(readItem(db, id)).supersededBy).toBeUndefined();
			expect(metaOf(readItem(db, id)).mergedInto).toBeUndefined();
		}
		expect(readItem(db, acceptedId).statement).toBe("I am learning Irish.");
		const sent = JSON.stringify(
			controlModelMock.sendJsonControlMessage.mock.calls,
		);
		expect(sent).not.toContain(acceptedId);
		expect(sent).not.toContain(legacyAcceptedId);
	});

	it("renews a user-accepted time_bound fact on the normal criteria, touching only its expiry", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const expiresAt = new Date(now.getTime() + 3 * DAY_MS);
		const acceptedMetadata = {
			origin: "judge_v1",
			confidence: "inferred",
			expiryClass: "time_bound",
			expiresInDays: 30,
			reviewResolution: "accepted",
			endorsement: "user_accepted",
			userConfirmedAt: new Date(now.getTime() - 3 * DAY_MS).toISOString(),
		};
		const acceptedId = seedItem(db, {
			userId,
			projectionStateId,
			category: "goals_ongoing_work",
			statement: "I am looking for an apartment in Limerick.",
			metadata: acceptedMetadata,
			expiresAt,
			createdAt: new Date(now.getTime() - 27 * DAY_MS),
			updatedAt: new Date(now.getTime() - 3 * DAY_MS),
		});
		// Accepted before the explicit endorsement marker existed.
		const legacyExpiresAt = new Date(now.getTime() + 5 * DAY_MS);
		const legacyAcceptedId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am preparing for a driving test.",
			metadata: {
				origin: "judge_v1",
				expiryClass: "time_bound",
				reviewResolution: "accepted",
			},
			expiresAt: legacyExpiresAt,
			createdAt: new Date(now.getTime() - 25 * DAY_MS),
			updatedAt: new Date(now.getTime() - 1 * DAY_MS),
		});
		db.insert(schema.memoryProfileItemProvenance)
			.values({
				id: randomUUID(),
				itemId: acceptedId,
				userId,
				resetGeneration: 0,
				sourceType: "conversation",
				sourceId: "c1",
				label: "Conversation",
				createdAt: now,
			})
			.run();
		const before = readItem(db, acceptedId);

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		const renewed = actions.filter((x) => x.type === "renewed");
		expect(renewed.flatMap((x) => x.itemIds).sort()).toEqual(
			[acceptedId, legacyAcceptedId].sort(),
		);

		const after = readItem(db, acceptedId);
		// Expiry pushed +30 days from the previous expiry (second granularity).
		expect(Math.floor((after.expiresAt?.getTime() ?? 0) / 1000)).toBe(
			Math.floor((expiresAt.getTime() + 30 * DAY_MS) / 1000),
		);
		expect(
			Math.floor(
				(readItem(db, legacyAcceptedId).expiresAt?.getTime() ?? 0) / 1000,
			),
		).toBe(Math.floor((legacyExpiresAt.getTime() + 30 * DAY_MS) / 1000));
		// Nothing but expiry + renewal bookkeeping (updatedAt) changes.
		expect(after.status).toBe("active");
		expect(after.statement).toBe(before.statement);
		expect(after.category).toBe(before.category);
		expect(after.scopeType).toBe(before.scopeType);
		expect(after.scopeId).toBe(before.scopeId);
		expect(after.itemKey).toBe(before.itemKey);
		expect(after.revision).toBe(before.revision);
		expect(metaOf(after)).toEqual(acceptedMetadata);
		expect(
			db
				.select()
				.from(schema.memoryProfileItemProvenance)
				.where(eq(schema.memoryProfileItemProvenance.itemId, acceptedId))
				.all(),
		).toHaveLength(1);

		// Still protected from reconcile/merge after the renewal.
		const otherId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I found an apartment in Cork.",
			metadata: { origin: "judge_v1" },
			createdAt: now,
			updatedAt: now,
		});
		setControlResponse(
			JSON.stringify({
				actions: [
					{ type: "supersede", winnerId: otherId, loserId: acceptedId },
					{
						type: "merge",
						itemIds: [legacyAcceptedId, otherId],
						mergedStatement: "I am busy with moving and driving.",
						category: "about_you",
					},
				],
			}),
		);
		const { runReconcileAndMerge } = await import("./steps");
		expect(await runReconcileAndMerge({ userId })).toEqual([]);
		for (const id of [acceptedId, legacyAcceptedId]) {
			const row = readItem(db, id);
			expect(row.status).toBe("active");
			expect(metaOf(row).supersededBy).toBeUndefined();
			expect(metaOf(row).mergedInto).toBeUndefined();
		}
		expect(readItem(db, acceptedId).statement).toBe(before.statement);
	});

	it("does not renew a user-accepted time_bound fact when the renewal criteria are not met", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const accepted = {
			origin: "judge_v1",
			expiryClass: "time_bound",
			reviewResolution: "accepted",
			endorsement: "user_accepted",
		};
		// Expires soon, but untouched for 20 days → no evidence it is current.
		const staleExpiresAt = new Date(now.getTime() + 4 * DAY_MS);
		const staleId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am renovating my kitchen.",
			metadata: accepted,
			expiresAt: staleExpiresAt,
			createdAt: new Date(now.getTime() - 40 * DAY_MS),
			updatedAt: new Date(now.getTime() - 20 * DAY_MS),
		});
		// Touched recently, but not expiring within the renewal window.
		const farExpiresAt = new Date(now.getTime() + 20 * DAY_MS);
		const farId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am training for a half marathon.",
			metadata: accepted,
			expiresAt: farExpiresAt,
			createdAt: new Date(now.getTime() - 10 * DAY_MS),
			updatedAt: new Date(now.getTime() - 1 * DAY_MS),
		});
		// Accepted but durable: never renewed (nothing to renew).
		const durableId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I have a trip in a few days.",
			metadata: { ...accepted, expiryClass: "durable" },
			expiresAt: new Date(now.getTime() + 3 * DAY_MS),
			createdAt: new Date(now.getTime() - 10 * DAY_MS),
			updatedAt: new Date(now.getTime() - 1 * DAY_MS),
		});

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		expect(actions.some((x) => x.type === "renewed")).toBe(false);
		expect(
			Math.floor((readItem(db, staleId).expiresAt?.getTime() ?? 0) / 1000),
		).toBe(Math.floor(staleExpiresAt.getTime() / 1000));
		expect(
			Math.floor((readItem(db, farId).expiresAt?.getTime() ?? 0) / 1000),
		).toBe(Math.floor(farExpiresAt.getTime() / 1000));
		expect(readItem(db, durableId).status).toBe("active");
	});

	it("does not auto-extend a user_authored time_bound fact's end date", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const expiresAt = new Date(now.getTime() + 3 * DAY_MS);
		// Written by the user: the end date is theirs, not an inference.
		const authoredId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am in Dublin until the end of the week.",
			metadata: { origin: "user_authored", expiryClass: "time_bound" },
			expiresAt,
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 2 * DAY_MS),
		});
		// Accepted, then edited by the user: user_authored wins.
		const editedId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am in Galway until Friday.",
			metadata: {
				origin: "user_authored",
				expiryClass: "time_bound",
				reviewResolution: "edited",
				endorsement: "user_accepted",
			},
			expiresAt,
			createdAt: new Date(now.getTime() - 5 * DAY_MS),
			updatedAt: new Date(now.getTime() - 2 * DAY_MS),
		});

		const { runExpireAndRenew } = await import("./steps");
		const actions = await runExpireAndRenew({ userId });

		expect(actions.some((x) => x.type === "renewed")).toBe(false);
		for (const id of [authoredId, editedId]) {
			const row = readItem(db, id);
			expect(row.status).toBe("active");
			expect(Math.floor((row.expiresAt?.getTime() ?? 0) / 1000)).toBe(
				Math.floor(expiresAt.getTime() / 1000),
			);
		}
	});

	it("applies reconcile actions when the model wraps the JSON envelope in reasoning prose", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const loserId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am planning an exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 10 * DAY_MS),
			updatedAt: new Date(now.getTime() - 10 * DAY_MS),
		});
		const winnerId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I settled in Limerick for my exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: new Date(now.getTime() - 2 * DAY_MS),
			updatedAt: new Date(now.getTime() - 2 * DAY_MS),
		});

		// A reasoning model surfaces its chain-of-thought (which even quotes the
		// format example) BEFORE the real envelope. Bare JSON.parse would throw;
		// envelope extraction must recover the trailing object.
		const responseText = `Let me think. The example format is {"actions": [{"type": "supersede", ...}]}. The newer Limerick fact supersedes the older plan.\n{"actions":[{"type":"supersede","winnerId":"${winnerId}","loserId":"${loserId}"}]}`;
		setControlResponse(responseText);

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });

		expect(readItem(db, loserId).status).toBe("retired");
		expect(metaOf(readItem(db, loserId)).supersededBy).toBe(winnerId);
		expect(readItem(db, winnerId).status).toBe("active");
		expect(actions.some((a) => a.type === "superseded")).toBe(true);
	});

	it("returns [] and records a reconcile_call_failed breadcrumb when the control model call fails", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am planning an exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: now,
			updatedAt: now,
		});

		// No setControlResponse(...) call: the shared mock throws because no
		// response was configured, simulating an LLM/network failure.
		controlModelMock.response = null;

		const { runReconcileAndMerge } = await import("./steps");
		const actions = await runReconcileAndMerge({ userId });
		expect(actions).toEqual([]);

		const telemetryRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetryRows.some(
				(r) =>
					r.eventFamily === "maintenance" &&
					r.eventName === "reconcile_call_failed" &&
					typeof r.reason === "string" &&
					r.reason.startsWith("llm_error:"),
			),
		).toBe(true);
	});

	it("records a memory-cost telemetry row with the reconcile call's usage", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am planning an exchange semester.",
			metadata: { origin: "judge_v1", confidence: "stated" },
			createdAt: now,
			updatedAt: now,
		});

		// The mock's response type is inferred without `usage`; the value is
		// returned as-is at runtime, so attach usage via a cast to exercise the
		// cost-recording wiring.
		controlModelMock.response = {
			...makeControlResponseValue(JSON.stringify({ actions: [] })),
			usage: { promptTokens: 90, completionTokens: 30, totalTokens: 120 },
		} as typeof controlModelMock.response;

		const { runReconcileAndMerge } = await import("./steps");
		await runReconcileAndMerge({ userId });

		const costRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.eventFamily, "cost"))
			.all();
		expect(costRows).toHaveLength(1);
		expect(costRows[0].count).toBe(120);
		expect(JSON.parse(costRows[0].metadataJson)).toMatchObject({
			feature: "consolidation",
			promptTokens: 90,
			completionTokens: 30,
			totalTokens: 120,
		});
	});
});
