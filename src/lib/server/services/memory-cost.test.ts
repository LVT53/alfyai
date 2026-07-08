import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
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

const NOW = new Date("2026-06-01T10:00:00.000Z");
const MODEL_NAME = "cost-test-model";

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
		.values({
			userId,
			resetGeneration: 0,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.onConflictDoNothing({ target: schema.memoryResetGenerations.userId })
		.run();
}

// Seed a provider + an enabled provider_models row named MODEL_NAME so that
// resolveModelPriceRule("model1") -> findPriceRule() matches it (config's
// model1.modelName is set to MODEL_NAME via the MODEL_1_NAME env below).
function seedPriceRule(
	db: ReturnType<typeof drizzle>,
	pricing: { inputUsdMicrosPer1m: number; outputUsdMicrosPer1m: number },
) {
	db.insert(schema.providers)
		.values({
			id: "provider-1",
			name: "openrouter",
			displayName: "OpenRouter",
			baseUrl: "https://openrouter.example",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
		})
		.run();
	db.insert(schema.providerModels)
		.values({
			id: "pm-1",
			providerId: "provider-1",
			name: MODEL_NAME,
			displayName: "Cost Test Model",
			enabled: 1,
			inputUsdMicrosPer1m: pricing.inputUsdMicrosPer1m,
			outputUsdMicrosPer1m: pricing.outputUsdMicrosPer1m,
		})
		.run();
}

function readCostRows(db: ReturnType<typeof drizzle>) {
	return db
		.select()
		.from(schema.memoryReworkTelemetry)
		.all()
		.filter((row) => row.eventFamily === "cost");
}

describe("memory cost tracking", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-cost-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		process.env.MODEL_1_NAME = MODEL_NAME;
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
		delete process.env.MODEL_1_NAME;
	});

	it("prices a call from the matching rule and records a cost telemetry row", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		// 1 USD/1M input, 2 USD/1M output.
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		});

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "judge",
			modelId: "model1",
			usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
		});

		const rows = readCostRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].eventName).toBe("model_usage");
		expect(rows[0].count).toBe(150);
		const metadata = JSON.parse(rows[0].metadataJson);
		expect(metadata).toMatchObject({
			feature: "judge",
			modelId: "model1",
			promptTokens: 100,
			completionTokens: 50,
			totalTokens: 150,
			// 100 * 1_000_000 / 1_000_000 + 50 * 2_000_000 / 1_000_000 = 200.
			costUsdMicros: 200,
		});
	});

	it("records zero cost and zero tokens when usage is absent", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		});

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "consolidation",
			modelId: "model1",
		});

		const rows = readCostRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0].count).toBe(0);
		const metadata = JSON.parse(rows[0].metadataJson);
		expect(metadata).toMatchObject({
			feature: "consolidation",
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			costUsdMicros: 0,
		});
	});

	it("derives totalTokens when the usage omits it", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 0,
			outputUsdMicrosPer1m: 0,
		});

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "summary",
			modelId: "model1",
			usage: {
				promptTokens: 30,
				completionTokens: 12,
				totalTokens: 0,
			},
		});

		const rows = readCostRows(db);
		const metadata = JSON.parse(rows[0].metadataJson);
		// A falsy totalTokens (0) falls back to prompt + completion.
		expect(metadata.totalTokens).toBe(42);
		expect(rows[0].count).toBe(42);
	});

	it("swallows failures and records nothing when the user does not exist", async () => {
		const { db } = openSeedDatabase();
		// No user row -> the telemetry insert violates the FK and throws inside
		// the recorder; recordMemoryModelUsage must swallow it.
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 2_000_000,
		});

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await expect(
			recordMemoryModelUsage({
				userId: "ghost-user",
				feature: "recuration",
				modelId: "model1",
				usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
			}),
		).resolves.toBeUndefined();

		expect(readCostRows(db)).toHaveLength(0);
	});

	it("rolls up recorded cost by feature via getMemoryCostSummary", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		seedUser(db, "u2");
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 1_000_000,
			outputUsdMicrosPer1m: 1_000_000,
		});

		const { recordMemoryModelUsage, getMemoryCostSummary } = await import(
			"./memory-cost"
		);
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "judge",
			modelId: "model1",
			usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
		});
		await recordMemoryModelUsage({
			userId: "u2",
			feature: "judge",
			modelId: "model1",
			usage: { promptTokens: 200, completionTokens: 0, totalTokens: 200 },
		});
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "recuration",
			modelId: "model1",
			usage: { promptTokens: 0, completionTokens: 40, totalTokens: 40 },
		});

		const summary = await getMemoryCostSummary();
		expect(summary.totals).toEqual({
			calls: 3,
			totalTokens: 340,
			totalCostUsdMicros: 340,
		});
		const judge = summary.byFeature.find((f) => f.feature === "judge");
		expect(judge).toEqual({
			feature: "judge",
			calls: 2,
			totalTokens: 300,
			totalCostUsdMicros: 300,
		});
		const recuration = summary.byFeature.find(
			(f) => f.feature === "recuration",
		);
		expect(recuration).toEqual({
			feature: "recuration",
			calls: 1,
			totalTokens: 40,
			totalCostUsdMicros: 40,
		});
	});

	it("bounds getMemoryCostSummary by the since window", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		seedPriceRule(db, {
			inputUsdMicrosPer1m: 0,
			outputUsdMicrosPer1m: 0,
		});

		const { recordMemoryModelUsage, getMemoryCostSummary } = await import(
			"./memory-cost"
		);
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "judge",
			modelId: "model1",
			usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
		});

		const future = new Date(Date.now() + 60 * 60 * 1000);
		const summary = await getMemoryCostSummary({ since: future });
		expect(summary.totals.calls).toBe(0);
		expect(summary.byFeature).toHaveLength(0);
	});

	it("prices a cache-aware memory call at the hit/miss rates", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		db.insert(schema.providers)
			.values({
				id: "provider-1",
				name: "deepseek",
				displayName: "DeepSeek",
				baseUrl: "https://deepseek.example",
				apiKeyEncrypted: "encrypted",
				apiKeyIv: "iv",
			})
			.run();
		db.insert(schema.providerModels)
			.values({
				id: "pm-1",
				providerId: "provider-1",
				name: MODEL_NAME,
				displayName: "Cost Test Model",
				enabled: 1,
				inputUsdMicrosPer1m: 1_000_000,
				cacheHitUsdMicrosPer1m: 100_000,
				cacheMissUsdMicrosPer1m: 1_000_000,
				outputUsdMicrosPer1m: 2_000_000,
			})
			.run();

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "judge",
			modelId: "model1",
			usage: {
				promptTokens: 1000,
				completionTokens: 500,
				totalTokens: 1500,
				cacheHitTokens: 800,
				cacheMissTokens: 200,
			},
		});

		const rows = readCostRows(db);
		const metadata = JSON.parse(rows[0].metadataJson);
		// regularInput = max(0, 1000 - (800+200)) = 0 -> 0
		// hit: 800 * 100_000 / 1e6 = 80; miss: 200 * 1_000_000 / 1e6 = 200
		// output: 500 * 2_000_000 / 1e6 = 1000 -> 1280
		expect(metadata.costUsdMicros).toBe(1280);
	});

	it("applies an active time-slot window to a memory call", async () => {
		const { db } = openSeedDatabase();
		seedUser(db, "u1");
		db.insert(schema.providers)
			.values({
				id: "provider-1",
				name: "deepseek",
				displayName: "DeepSeek",
				baseUrl: "https://deepseek.example",
				apiKeyEncrypted: "encrypted",
				apiKeyIv: "iv",
			})
			.run();
		db.insert(schema.providerModels)
			.values({
				id: "pm-1",
				providerId: "provider-1",
				name: MODEL_NAME,
				displayName: "Cost Test Model",
				enabled: 1,
				inputUsdMicrosPer1m: 1_000_000,
				outputUsdMicrosPer1m: 0,
			})
			.run();
		// Always-active window discounting input to 1/10th.
		db.insert(schema.providerModelPriceWindows)
			.values({
				id: "w1",
				providerModelId: "pm-1",
				label: "off-peak",
				daysOfWeek: "0123456",
				startMinute: 0,
				endMinute: 1440,
				inputUsdMicrosPer1m: 100_000,
				enabled: 1,
			})
			.run();

		const { recordMemoryModelUsage } = await import("./memory-cost");
		await recordMemoryModelUsage({
			userId: "u1",
			feature: "judge",
			modelId: "model1",
			usage: { promptTokens: 100, completionTokens: 0, totalTokens: 100 },
		});

		const rows = readCostRows(db);
		const metadata = JSON.parse(rows[0].metadataJson);
		// 100 * 100_000 / 1e6 = 10 (window rate), not 100 (flat rate).
		expect(metadata.costUsdMicros).toBe(10);
	});
});
