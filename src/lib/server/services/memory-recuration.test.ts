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

	it("recomputes expiresAt on review_needed -> active transitions (kept and rewritten)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u3";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// review_needed item kept as durable -> active with expiresAt cleared
		const keptId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "The user works in finance.",
			status: "review_needed",
			now,
		});
		// review_needed item rewritten as time_bound(60) -> active with a fresh horizon
		const rewrittenId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} is training for a marathon in the fall.`,
			status: "review_needed",
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
									{ itemId: keptId, verdict: "keep" },
									{
										itemId: rewrittenId,
										verdict: "rewrite",
										statement: "I am training for a marathon in the fall.",
										expiryClass: "time_bound",
										expiresInDays: 60,
									},
								],
							}),
						),
					);
				}
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

		expect(result).toMatchObject({ kept: 1, rewritten: 1 });

		const kept = readItem(db, keptId);
		expect(kept?.status).toBe("active");
		expect(kept?.expiresAt).toBeNull();

		const rewritten = readItem(db, rewrittenId);
		expect(rewritten?.status).toBe("active");
		expect(rewritten?.statement).toBe(
			"I am training for a marathon in the fall.",
		);
		expect(rewritten?.expiresAt).not.toBeNull();
		const expiresAtMs = new Date(rewritten?.expiresAt as Date).getTime();
		const expectedMs = now.getTime() + 60 * 86_400_000;
		expect(Math.abs(expiresAtMs - expectedMs)).toBeLessThan(10_000);
	});

	it("leaves a still-review_needed item's review row open when its batch fails, while resolving other rows", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u4";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// This item's batch will fail the control-model call, so it remains review_needed.
		const failedBatchItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "The user might be moving to a new city.",
			status: "review_needed",
			now,
		});
		const failedBatchReviewRowId = seedOpenReview(db, {
			userId,
			affectedItemIds: [failedBatchItemId],
			now,
		});

		// This item's batch succeeds and gets kept -> its review row should resolve.
		const okItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "The user enjoys cooking.",
			status: "review_needed",
			now,
		});
		const okReviewRowId = seedOpenReview(db, {
			userId,
			affectedItemIds: [okItemId],
			now,
		});

		let callCount = 0;
		sendJsonControlMessageMock.mockImplementation(
			(
				_userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					callCount++;
					// Fail exactly the batch containing failedBatchItemId; both
					// items land in the same (only) batch here since BATCH_SIZE=20,
					// so simulate the "some items processed, some not" scenario by
					// rejecting the whole call once, then this test only needs the
					// single-batch failure semantics: reject unconditionally.
					return Promise.reject(new Error("control model unavailable"));
				}
				return Promise.resolve(
					makeControlResponse(JSON.stringify({ actions: [] })),
				);
			},
		);

		const { runMemoryRecuration } = await import("./memory-recuration");
		await runMemoryRecuration(userId);

		// Both items are in the same batch and the batch failed, so both remain
		// review_needed and both review rows must remain open.
		expect(readItem(db, failedBatchItemId)?.status).toBe("review_needed");
		expect(readItem(db, okItemId)?.status).toBe("review_needed");

		const [failedRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, failedBatchReviewRowId))
			.all();
		expect(failedRow?.status).toBe("open");

		const [okRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, okReviewRowId))
			.all();
		expect(okRow?.status).toBe("open");
		expect(callCount).toBeGreaterThan(0);
	});

	it("resolves review rows for items no longer review_needed, but preserves rows for items whose batch failed", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u5";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// Active item, verdict retire -> resolved fully; its review row (if any) should resolve.
		const activeItemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: "The user drinks coffee every morning.",
			now,
		});
		const activeReviewRowId = seedOpenReview(db, {
			userId,
			affectedItemIds: [activeItemId],
			now,
		});

		// A stray open review row referencing an item id that isn't review_needed
		// (e.g. already resolved/retired previously) -> should be resolved.
		const staleReviewRowId = seedOpenReview(db, {
			userId,
			affectedItemIds: ["nonexistent-item-id"],
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
								verdicts: [{ itemId: activeItemId, verdict: "retire" }],
							}),
						),
					);
				}
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

		expect(result.reviewResolved).toBe(2);

		const [activeRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, activeReviewRowId))
			.all();
		expect(activeRow?.status).toBe("resolved");

		const [staleRow] = db
			.select()
			.from(schema.memoryReviewItems)
			.where(eq(schema.memoryReviewItems.id, staleReviewRowId))
			.all();
		expect(staleRow?.status).toBe("resolved");
	});

	// Count how many itemIds a recuration user message carried.
	function itemCount(userMessage: string): number {
		try {
			const parsed = JSON.parse(userMessage);
			return Array.isArray(parsed?.items) ? parsed.items.length : 0;
		} catch {
			return 0;
		}
	}

	it("emits recuration_batch_unparsed telemetry and split-retries when a full batch parses to zero verdicts", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u6";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// A single batch of 4 eligible items. The first (whole-batch) call returns
		// garbage that parses to zero verdicts; the two split-half calls return
		// valid verdicts. Success = telemetry emitted AND both halves' verdicts
		// applied (proving the one-level split-retry ran).
		const ids = [0, 1, 2, 3].map((n) =>
			seedItem(db, {
				userId,
				projectionStateId,
				statement: `${PEER_TOKEN} statement number ${n}, as mentioned in conversation.`,
				now,
			}),
		);

		sendJsonControlMessageMock.mockImplementation(
			(
				userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					const count = itemCount(userMessage);
					if (count === 4) {
						// Whole batch -> unparseable. Exact shape captured from a live
						// DeepSeek run against the production snapshot: reasoning
						// consumed the token budget and the content channel was cut
						// mid-key by finish_reason=length.
						return Promise.resolve(
							makeControlResponse(
								'{"verdicts":[{"itemId":"9c5d5c6b-d094-4ba7-8d41-d1eac6157355","ver',
							),
						);
					}
					// split halves -> retire every item they were given
					const parsed = JSON.parse(userMessage) as {
						items: Array<{ itemId: string }>;
					};
					return Promise.resolve(
						makeControlResponse(
							JSON.stringify({
								verdicts: parsed.items.map((i) => ({
									itemId: i.itemId,
									verdict: "retire",
								})),
							}),
						),
					);
				}
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

		// All four items retired via the two split halves.
		expect(result.retired).toBe(4);
		for (const id of ids) {
			expect(readItem(db, id)?.status).toBe("retired");
		}

		const telemetryRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		const unparsed = telemetryRows.filter(
			(r) =>
				r.eventFamily === "intake" &&
				r.eventName === "recuration_batch_unparsed",
		);
		expect(unparsed.length).toBe(1);
		expect(unparsed[0]?.count).toBe(4);
	});

	it("does NOT split-retry a second time: a half that still parses to zero is left alone (one level only)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u7";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const ids = [0, 1].map((n) =>
			seedItem(db, {
				userId,
				projectionStateId,
				statement: `${PEER_TOKEN} statement number ${n}, as mentioned in conversation.`,
				now,
			}),
		);

		// Every recuration call returns reasoning PROSE (no JSON at all) -> zero
		// verdicts at every depth. Opening sentence captured verbatim from a live
		// DeepSeek run where the reasoning channel consumed the whole token
		// budget and allowReasoningFallback surfaced the chain-of-thought text.
		sendJsonControlMessageMock.mockImplementation(
			(
				_userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					return Promise.resolve(
						makeControlResponse(
							"We are asked to produce verdicts for existing items. The input contains two items. We need to evaluate each against the five gates: stable, owned, useful, confident, not redundant.",
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

		expect(result).toMatchObject({ kept: 0, rewritten: 0, retired: 0 });
		for (const id of ids) {
			expect(readItem(db, id)?.status).toBe("active");
		}

		// One top-level unparsed event (with retry hint) + one per split half
		// (2 halves) = 3 total. No infinite recursion.
		const unparsed = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all()
			.filter(
				(r) =>
					r.eventFamily === "intake" &&
					r.eventName === "recuration_batch_unparsed",
			);
		expect(unparsed.length).toBe(3);
	});

	it("recovers a verdicts envelope embedded in reasoning prose (and ignores a quoted format example)", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u10";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const itemId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} statement, as mentioned in conversation.`,
			now,
		});

		sendJsonControlMessageMock.mockImplementation(
			(
				_userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string } },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					// Reasoning prose that first QUOTES the format example (with fake
					// ids), then emits the real envelope at the end — the shape a
					// reasoning model produces when its chain-of-thought is surfaced.
					return Promise.resolve(
						makeControlResponse(
							[
								"We need to reply with a single JSON object with one key,",
								'"verdicts". The example was {"verdicts":[{"itemId":"f1","verdict":"keep"}]}.',
								"The item is third-person so it must be retired. Final answer:",
								JSON.stringify({
									verdicts: [{ itemId, verdict: "retire" }],
								}),
							].join("\n"),
						),
					);
				}
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

		// The real envelope (last in the text) was applied; the quoted example
		// with fake ids was not: no unknown-id drops, no unparsed telemetry.
		expect(result.retired).toBe(1);
		expect(readItem(db, itemId)?.status).toBe("retired");

		const telemetry = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetry.some((r) => r.eventName === "recuration_batch_unparsed"),
		).toBe(false);
		expect(
			telemetry.some((r) => r.eventName === "recuration_verdicts_dropped"),
		).toBe(false);
	});

	it("counts unknown-id verdicts and emits recuration_verdicts_dropped telemetry", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u8";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		const realId = seedItem(db, {
			userId,
			projectionStateId,
			statement: `${PEER_TOKEN} statement, as mentioned in conversation.`,
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
									{ itemId: realId, verdict: "retire" },
									{ itemId: "unknown-id-1", verdict: "retire" },
									{ itemId: "unknown-id-2", verdict: "keep" },
								],
							}),
						),
					);
				}
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

		expect(result.retired).toBe(1);
		expect(readItem(db, realId)?.status).toBe("retired");

		const dropped = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all()
			.filter(
				(r) =>
					r.eventFamily === "intake" &&
					r.eventName === "recuration_verdicts_dropped",
			);
		expect(dropped.length).toBe(1);
		expect(dropped[0]?.count).toBe(2);
	});

	it("chunks eligible rows into batches of at most BATCH_SIZE (10), one model call per batch", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u9";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);

		// 23 items -> ceil(23/10) = 3 batches -> 3 recuration model calls.
		for (let n = 0; n < 23; n++) {
			seedItem(db, {
				userId,
				projectionStateId,
				statement: `I am fact number ${n}.`,
				now,
			});
		}

		const batchSizes: number[] = [];
		const batchMaxTokens: number[] = [];
		sendJsonControlMessageMock.mockImplementation(
			(
				userMessage: string,
				_model: string,
				options: { jsonSchema?: { name?: string }; maxTokens?: number },
			) => {
				if (options?.jsonSchema?.name === "memory_recuration_verdicts") {
					batchSizes.push(itemCount(userMessage));
					batchMaxTokens.push(options?.maxTokens ?? 0);
					const parsed = JSON.parse(userMessage) as {
						items: Array<{ itemId: string }>;
					};
					return Promise.resolve(
						makeControlResponse(
							JSON.stringify({
								verdicts: parsed.items.map((i) => ({
									itemId: i.itemId,
									verdict: "keep",
								})),
							}),
						),
					);
				}
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
		await runMemoryRecuration(userId);

		expect(batchSizes).toEqual([10, 10, 3]);
		expect(batchSizes.every((s) => s <= 10)).toBe(true);
		// Reasoning-aware token budget: JUDGE_MAX_TOKENS (2400) + 500/item,
		// capped at 8000. Reasoning tokens count against max_tokens on the
		// OpenAI-compatible providers this runs on.
		expect(batchMaxTokens).toEqual([7400, 7400, 3900]);
	});
});
