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

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	seedConnections.push({ sqlite, db });
	return { sqlite, db };
}

function seedUser(
	db: ReturnType<typeof drizzle>,
	userId: string,
	now: Date,
	options?: { titleLanguage?: string; uiLanguage?: string },
) {
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			titleLanguage: options?.titleLanguage ?? "auto",
			uiLanguage: options?.uiLanguage ?? "en",
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
		statement: string;
		category?: string;
		now: Date;
	},
): string {
	const id = randomUUID();
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
			status: "active",
			revision: 0,
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

function readProjectionRow(db: ReturnType<typeof drizzle>, userId: string) {
	const [row] = db
		.select()
		.from(schema.memoryProjectionState)
		.where(eq(schema.memoryProjectionState.userId, userId))
		.all();
	return row;
}

describe("persona summary generation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-persona-summary-${randomUUID()}.db`;
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

	it("stores summary text with per-sentence fact links; getPersonaSummary round-trips", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now, { uiLanguage: "en" });
		const projectionStateId = seedProjectionState(db, userId, now);
		const id1 = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am Hungarian.",
			now,
		});
		const id2 = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am an Erasmus student.",
			now,
		});
		const id3 = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I prefer plain language.",
			category: "preferences",
			now,
		});

		const responseText = JSON.stringify({
			sentences: [
				{
					text: "Levente is a Hungarian Erasmus student.",
					factIds: [id1, id2],
				},
				{ text: "He prefers plain language.", factIds: [id3] },
			],
		});
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { generateAndStorePersonaSummary, getPersonaSummary } = await import(
			"./summary"
		);
		const created = await generateAndStorePersonaSummary({ userId });
		expect(created).not.toBeNull();
		expect(created?.text).toContain("Erasmus");
		expect(created?.text).toBe(
			"Levente is a Hungarian Erasmus student. He prefers plain language.",
		);

		const read = await getPersonaSummary({ userId });
		expect(read).not.toBeNull();
		expect(read?.text).toBe(created?.text);
		expect(read?.links).toHaveLength(2);
		expect(read?.links[0].factIds).toContain(id1);
		expect(read?.links[0].factIds).toContain(id2);
		expect(read?.links[1].factIds).toEqual([id3]);
		expect(read?.updatedAt).toBeInstanceOf(Date);

		const row = readProjectionRow(db, userId);
		expect(row?.personaSummaryText).toBe(created?.text);
		expect(row?.revision).toBeGreaterThanOrEqual(1);
	});

	it("drops fact links that reference unknown ids but keeps the sentence", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		const id1 = seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am a designer.",
			now,
		});

		const responseText = JSON.stringify({
			sentences: [
				{
					text: "They are a designer.",
					factIds: [id1, "bogus-id-not-real"],
				},
				{ text: "They enjoy hiking.", factIds: ["another-bogus-id"] },
			],
		});
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { generateAndStorePersonaSummary } = await import("./summary");
		const created = await generateAndStorePersonaSummary({ userId });
		expect(created).not.toBeNull();
		expect(created?.links).toHaveLength(2);
		expect(created?.links[0].factIds).toEqual([id1]);
		expect(created?.links[1].factIds).toEqual([]);
		expect(created?.text).toBe("They are a designer. They enjoy hiking.");
	});

	it("returns null and stores nothing when there are no active facts", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u2";
		seedUser(db, userId, now);

		const sendJsonControlMessage = vi.fn();
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage,
		}));

		const { generateAndStorePersonaSummary, getPersonaSummary } = await import(
			"./summary"
		);
		const created = await generateAndStorePersonaSummary({ userId });
		expect(created).toBeNull();
		expect(sendJsonControlMessage).not.toHaveBeenCalled();

		const read = await getPersonaSummary({ userId });
		expect(read).toBeNull();
		const row = readProjectionRow(db, userId);
		expect(row?.personaSummaryText ?? null).toBeNull();
	});

	it("returns null, stores nothing, and records telemetry when the response is unusable", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		const userId = "u1";
		seedUser(db, userId, now);
		const projectionStateId = seedProjectionState(db, userId, now);
		seedItem(db, {
			userId,
			projectionStateId,
			statement: "I am a teacher.",
			now,
		});

		const responseText = JSON.stringify({ sentences: [{ text: "   " }] });
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage: vi
				.fn()
				.mockResolvedValue(makeControlResponse(responseText)),
		}));

		const { generateAndStorePersonaSummary } = await import("./summary");
		const created = await generateAndStorePersonaSummary({ userId });
		expect(created).toBeNull();

		const row = readProjectionRow(db, userId);
		expect(row?.personaSummaryText ?? null).toBeNull();

		const telemetryRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.where(eq(schema.memoryReworkTelemetry.userId, userId))
			.all();
		expect(
			telemetryRows.some(
				(r) =>
					r.eventFamily === "maintenance" &&
					r.eventName === "persona_summary_failed",
			),
		).toBe(true);
	});

	it("uses titleLanguage when set, else uiLanguage, for the prompt language", async () => {
		const { db } = openSeedDatabase();
		const now = new Date();
		seedUser(db, "u-hu", now, { titleLanguage: "hu", uiLanguage: "en" });
		seedUser(db, "u-en", now, { titleLanguage: "auto", uiLanguage: "en" });
		const psHu = seedProjectionState(db, "u-hu", now);
		const psEn = seedProjectionState(db, "u-en", now);
		const huFactId = seedItem(db, {
			userId: "u-hu",
			projectionStateId: psHu,
			statement: "Magyar vagyok.",
			now,
		});
		const enFactId = seedItem(db, {
			userId: "u-en",
			projectionStateId: psEn,
			statement: "I am from London.",
			now,
		});

		const sendJsonControlMessage = vi
			.fn()
			.mockImplementation((_message: string) =>
				Promise.resolve(
					makeControlResponse(
						JSON.stringify({
							sentences: [{ text: "A sentence.", factIds: [] }],
						}),
					),
				),
			);
		vi.doMock("../normal-chat-control-model", () => ({
			sendJsonControlMessage,
		}));

		const { generateAndStorePersonaSummary } = await import("./summary");

		await generateAndStorePersonaSummary({ userId: "u-hu" });
		expect(sendJsonControlMessage).toHaveBeenCalledTimes(1);
		const huCall = sendJsonControlMessage.mock.calls[0];
		expect(huCall[2].systemPrompt).toContain("Hungarian");
		expect(huCall[0]).toContain(huFactId);

		await generateAndStorePersonaSummary({ userId: "u-en" });
		expect(sendJsonControlMessage).toHaveBeenCalledTimes(2);
		const enCall = sendJsonControlMessage.mock.calls[1];
		expect(enCall[2].systemPrompt).toContain("English");
		expect(enCall[0]).toContain(enFactId);
	});
});
