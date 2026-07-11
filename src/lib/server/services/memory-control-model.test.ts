import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// The adapter funnels every memory-feature control-model call through the SAME
// `sendJsonControlMessage`, so a hoisted module mock intercepts it exactly as
// the individual feature suites do.
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

const NOW = new Date("2026-06-01T10:00:00.000Z");

function seedUser(db: ReturnType<typeof drizzle>, userId: string) {
	db.insert(schema.users)
		.values({
			id: userId,
			email: `${userId}@example.com`,
			passwordHash: "hash",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	db.insert(schema.memoryResetGenerations)
		.values({ userId, resetGeneration: 0, createdAt: NOW, updatedAt: NOW })
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
}

describe("callMemoryControlModel adapter", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-control-model-${randomUUID()}.db`;
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

	it("disables thinking, applies reasoning-aware budgeting, extracts the envelope, and records a per-feature cost row", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");

		// Response wraps the JSON envelope in reasoning prose so the plain
		// JSON.parse fails and the envelope extractor must recover the object.
		sendJsonControlMessageMock.mockResolvedValue({
			text: 'Let me think about this... {"actions":[{"type":"merge"}]} done.',
			rawResponse: null,
			modelId: "model1",
			modelDisplayName: "test",
			usage: { promptTokens: 100, completionTokens: 40, totalTokens: 140 },
		});

		const { callMemoryControlModel } = await import("./memory-control-model");
		const { reasoningAwareMaxTokens } = await import("./memory-judge/schema");

		const result = await callMemoryControlModel({
			userId: "u1",
			feature: "consolidation",
			systemPrompt: "SYS",
			userMessage: "USER",
			modelId: "model1",
			inputSizeHint: 4,
			jsonSchema: {
				name: "x",
				strict: true,
				schema: { type: "object" },
			},
			envelopeKey: "actions",
		});

		// Positional contract preserved: (message, modelId, options).
		expect(sendJsonControlMessageMock).toHaveBeenCalledTimes(1);
		const [message, modelId, options] = sendJsonControlMessageMock.mock
			.calls[0] as [
			string,
			string,
			{
				thinkingMode?: string;
				maxTokens?: number;
				allowReasoningFallback?: boolean;
				systemPrompt?: string;
			},
		];
		expect(message).toBe("USER");
		expect(modelId).toBe("model1");
		expect(options.systemPrompt).toBe("SYS");
		expect(options.thinkingMode).toBe("off");
		expect(options.maxTokens).toBe(reasoningAwareMaxTokens(4));
		expect(options.allowReasoningFallback).toBe(true);

		// Envelope extracted from the reasoning-wrapped text.
		expect(result.data).toEqual({ actions: [{ type: "merge" }] });
		expect(result.text).toContain('"actions"');

		// A cost row tagged with the given feature was recorded.
		const costRows = db
			.select()
			.from(schema.memoryReworkTelemetry)
			.all()
			.filter((row) => row.eventFamily === "cost");
		expect(costRows).toHaveLength(1);
		expect(costRows[0].count).toBe(140);
		expect(JSON.parse(costRows[0].metadataJson)).toMatchObject({
			feature: "consolidation",
			promptTokens: 100,
			completionTokens: 40,
			totalTokens: 140,
		});
	});
});
