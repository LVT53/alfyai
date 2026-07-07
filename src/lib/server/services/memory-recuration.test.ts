import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// Hoisted static mock: vi.doMock registered from inside an `it()` races with
// sibling test files that dynamically import this same relative specifier
// concurrently under file parallelism, causing the real (unmocked) module to
// resolve intermittently. A hoisted vi.mock is applied once, synchronously,
// before this file's module graph loads. Each test configures the shared
// spy's behavior instead of re-registering the module mock.
const sendJsonControlMessageMock = vi.fn();
vi.mock("./normal-chat-control-model", () => ({
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
		category?: string;
		statement: string;
		status?: string;
		metadata?: Record<string, unknown>;
		now: Date;
	},
): string {
	const id = params.id ?? randomUUID();
	db.insert(schema.memoryProfileItems)
		.values({
			id,
			userId: params.userId,
			projectionStateId: params.projectionStateId,
			resetGeneration: 0,
			itemKey: `v1:${id}`,
			category: params.category ?? "about_you",
			scopeType: "global",
			scopeId: "",
			statement: params.statement,
			status: params.status ?? "active",
			revision: 0,
			metadataJson: JSON.stringify(params.metadata ?? {}),
			createdAt: params.now,
			updatedAt: params.now,
		})
		.run();
	return id;
}

function seedOpenReview(
	db: ReturnType<typeof drizzle>,
	params: {
		userId: string;
		affectedItemIds: string[];
		now: Date;
	},
): string {
	const id = randomUUID();
	db.insert(schema.memoryReviewItems)
		.values({
			id,
			userId: params.userId,
			resetGeneration: 0,
			subjectKey: `judge:${id}`,
			subjectLabel: "Review subject",
			question: "Should I keep remembering this?",
			reason: "Inferred from conversation, not stated directly.",
			status: "open",
			affectedItemIdsJson: JSON.stringify(params.affectedItemIds),
			evidenceJson: "[]",
			metadataJson: "{}",
			createdAt: params.now,
			updatedAt: params.now,
		})
		.run();
	return id;
}

function makeControlResponse(text: string) {
	return {
		text,
		rawResponse: {},
		modelId: "model1" as const,
		modelDisplayName: "Model 1",
	};
}

function readItem(db: ReturnType<typeof drizzle>, id: string) {
	const [row] = db
		.select()
		.from(schema.memoryProfileItems)
		.where(eq(schema.memoryProfileItems.id, id))
		.all();
	return row;
}

const PEER_TOKEN = "U_86dc59c07f598be7de4c127cbf0da318";

describe("runMemoryRecuration", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-recuration-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
		sendJsonControlMessageMock.mockReset();
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

	it("rewrites keepers first-person, retires junk, drains the review queue, then consolidates", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// 1. active third-person peer-token statement -> rewrite
		const rewriteId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} prefers to communicate in simple, everyday language, avoiding technical jargon.`,
			now,
		});
		// 2. active log-scrape evidence-trail statement -> retire
		const logScrapeId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} is working on a server running AlmaLinux, as indicated by the filesystem device name.`,
			now,
		});
		// 3. active hedge statement -> retire
		const hedgeId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} has a bike or has a bike to which insurance might be applicable.`,
			now,
		});
		// 4. review_needed item + open review row -> retire + review resolved
		const reviewItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "The user might be relocating soon.",
			status: "review_needed",
			now,
		});
		const reviewRowId = seedOpenReview(db, {
			userId,
			affectedItemIds: [reviewItemId],
			now,
		});
		// 5. user_authored item -> untouched even if model proposes retire
		const userAuthoredId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I always want responses in English.",
			metadata: { origin: "user_authored" },
			now,
		});
		// 6. rewrite verdict that still trips THIRD_PERSON_RE post-filter -> treated as retire
		const badRewriteId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} enjoys hiking on weekends, as mentioned in conversation.`,
			now,
		});

		sendJsonControlMessageMock.mockImplementation(
			(
				_userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					return Promise.resolve(
						makeControlResponse(
							JSON.stringify({
								verdicts: [
									{
										itemId: rewriteId,
										verdict: "rewrite",
										statement:
											"I prefer to communicate in simple, everyday language, avoiding technical jargon.",
									},
									{ itemId: logScrapeId, verdict: "retire" },
									{ itemId: hedgeId, verdict: "retire" },
									{ itemId: reviewItemId, verdict: "retire" },
									{ itemId: userAuthoredId, verdict: "retire" },
									{
										itemId: badRewriteId,
										verdict: "rewrite",
										// still third-person after "rewrite" -> must be treated as retire
										statement: `${PEER_TOKEN} enjoys hiking on weekends.`,
									},
								],
							}),
						),
					);
				}
				// Persona summary / reconcile-and-merge calls during consolidation:
				// return a generic, harmless payload for either shape.
				if (options?.jsonSchema?.name === "persona_summary") {
					return Promise.resolve(
						makeControlResponse(
							JSON.stringify({
								sentences: [{ text: "You are a user.", factIds: [] }],
							}),
						),
					);
				}
				return Promise.resolve(
					makeControlResponse(JSON.stringify({ actions: [] })),
				);
			},
		);

		const { runMemoryRecuration } = await import("./memory-recuration");
		const result = await runMemoryRecuration(userId);

		expect(result).toMatchObject({
			rewritten: 1,
			retired: 4,
			reviewResolved: 1,
		});

		const rewritten = readItem(db, rewriteId);
		expect(rewritten?.statement).toBe(
			"I prefer to communicate in simple, everyday language, avoiding technical jargon.",
		);
		expect(rewritten?.status).toBe("active");
		expect(JSON.parse(rewritten?.metadataJson ?? "{}").origin).toBe(
			"recuration",
		);

		expect(readItem(db, logScrapeId)?.status).toBe("retired");
		expect(readItem(db, hedgeId)?.status).toBe("retired");
		expect(readItem(db, badRewriteId)?.status).toBe("retired");
		// still third-person, must not have been "rewritten"
		expect(readItem(db, badRewriteId)?.statement).toBe(
			`${PEER_TOKEN} enjoys hiking on weekends, as mentioned in conversation.`,
		);

		const reviewedItem = readItem(db, reviewItemId);
		expect(reviewedItem?.status).toBe("retired");

		const userAuthored = readItem(db, userAuthoredId);
		expect(userAuthored?.status).toBe("active");
		expect(userAuthored?.statement).toBe("I always want responses in English.");

		const [reviewRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, reviewRowId))
			.all();
		expect(reviewRow?.status).toBe("resolved");

		const openReviewRows = db
			.select()
			.from(schema.memoryReviewItems)
			.where(
				and(
					eq(schema.memoryReviewItems.userId, userId),
					eq(schema.memoryReviewItems.status, "open"),
				),
			)
			.all();
		expect(openReviewRows).toHaveLength(0);

		// Consolidation ran: a report row should exist.
		const reports = db
			.select()
			.from(schema.memoryConsolidationReports)
			.where(eq(schema.memoryConsolidationReports.userId, userId))
			.all();
		expect(reports.length).toBeGreaterThanOrEqual(1);
	});

	it("skips a batch entirely (leaving items unchanged) when the control model call fails, without throwing", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u2";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am a backend engineer.",
			now,
		});

		sendJsonControlMessageMock.mockImplementation(
			(
				_userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					return Promise.reject(new Error("control model unavailable"));
				}
				return Promise.resolve(
					makeControlResponse(JSON.stringify({ actions: [] })),
				);
			},
		);

		const { runMemoryRecuration } = await import("./memory-recuration");
		const result = await runMemoryRecuration(userId);

		expect(result).toMatchObject({ kept: 0, rewritten: 0, retired: 0 });
		const item = readItem(db, itemId);
		expect(item?.status).toBe("active");
		expect(item?.statement).toBe("I am a backend engineer.");

		const telemetryRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetryRows.some(
				(r) =>
					r.eventFamily === "intake" &&
					r.eventName === "recuration_batch_failed",
			),
		).toBe(true);
	});
});
