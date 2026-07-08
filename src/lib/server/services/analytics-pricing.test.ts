import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: "./drizzle" });
	return { sqlite, database };
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// Best-effort.
	}
}

// A base provider_models rule. Only the pricing fields matter for these tests;
// the rest is cast to satisfy the row type without listing every column.
function baseRule(overrides: Record<string, number> = {}) {
	return {
		id: "model-rule-1",
		inputUsdMicrosPer1m: 1_000_000,
		cachedInputUsdMicrosPer1m: 200_000,
		cacheHitUsdMicrosPer1m: 200_000,
		cacheMissUsdMicrosPer1m: 1_000_000,
		outputUsdMicrosPer1m: 2_000_000,
		...overrides,
	} as unknown as typeof schema.providerModels.$inferSelect;
}

type Win = import("./analytics").EffectivePriceWindow;

function window(overrides: Partial<Win>): Win {
	return {
		id: "w",
		daysOfWeek: "0123456",
		startMinute: 0,
		endMinute: 1440,
		inputUsdMicrosPer1m: null,
		cachedInputUsdMicrosPer1m: null,
		cacheHitUsdMicrosPer1m: null,
		cacheMissUsdMicrosPer1m: null,
		outputUsdMicrosPer1m: null,
		enabled: true,
		...overrides,
	};
}

describe("calculateCostUsdMicros — DeepSeek cache accounting", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-pricing-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});
	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort.
		}
	});

	it("prices hit/miss separately and leaves regular input at zero", async () => {
		openSeedDatabase().sqlite.close();
		const { calculateCostUsdMicros } = await import("./analytics");
		// DeepSeek: prompt_tokens = cache_hit + cache_miss (sum to prompt).
		const rule = baseRule({
			inputUsdMicrosPer1m: 270_000, // should NOT be charged (regularInput = 0)
			cacheHitUsdMicrosPer1m: 27_000,
			cacheMissUsdMicrosPer1m: 270_000,
			outputUsdMicrosPer1m: 1_100_000,
		});
		const cost = calculateCostUsdMicros(rule, {
			promptTokens: 1000,
			cachedInputTokens: 800,
			cacheHitTokens: 800,
			cacheMissTokens: 200,
			completionTokens: 500,
			reasoningTokens: 0,
		});
		// hit: 800 * 27000 / 1e6 = 21.6
		// miss: 200 * 270000 / 1e6 = 54
		// output: 500 * 1_100_000 / 1e6 = 550
		// regular input: max(0, 1000 - (800+200)) = 0 -> 0
		expect(cost).toBe(Math.round(21.6 + 54 + 550));
	});
});

describe("findActivePriceWindow / resolveEffectivePriceRule", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-pricing-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});
	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort.
		}
	});

	it("returns the base rule unchanged when there are no windows", async () => {
		openSeedDatabase().sqlite.close();
		const { resolveEffectivePriceRule } = await import("./analytics");
		const rule = baseRule();
		expect(resolveEffectivePriceRule(rule, [], new Date())).toBe(rule);
	});

	it("overrides only the window's non-null rates", async () => {
		openSeedDatabase().sqlite.close();
		const { resolveEffectivePriceRule } = await import("./analytics");
		const now = new Date("2026-06-01T10:00:00Z"); // Monday 10:00 UTC
		const win = window({
			startMinute: 9 * 60,
			endMinute: 17 * 60,
			inputUsdMicrosPer1m: 500_000,
			outputUsdMicrosPer1m: 1_000_000,
		});
		const resolved = resolveEffectivePriceRule(baseRule(), [win], now);
		expect(resolved?.inputUsdMicrosPer1m).toBe(500_000);
		expect(resolved?.outputUsdMicrosPer1m).toBe(1_000_000);
		// Null override -> inherit base.
		expect(resolved?.cacheHitUsdMicrosPer1m).toBe(200_000);
		expect(resolved?.cacheMissUsdMicrosPer1m).toBe(1_000_000);
	});

	it("is inactive outside the window", async () => {
		openSeedDatabase().sqlite.close();
		const { resolveEffectivePriceRule } = await import("./analytics");
		const now = new Date("2026-06-01T20:00:00Z"); // 20:00, outside 09:00-17:00
		const win = window({
			startMinute: 9 * 60,
			endMinute: 17 * 60,
			inputUsdMicrosPer1m: 500_000,
		});
		const rule = baseRule();
		expect(resolveEffectivePriceRule(rule, [win], now)).toBe(rule);
	});

	it("handles a window that wraps past UTC midnight — active both before and after", async () => {
		openSeedDatabase().sqlite.close();
		const { findActivePriceWindow } = await import("./analytics");
		// 22:00 -> 06:00 next day, every day.
		const win = window({ startMinute: 22 * 60, endMinute: 6 * 60 });
		// 23:00 Monday -> active (leading portion of Monday's window).
		expect(
			findActivePriceWindow([win], new Date("2026-06-01T23:00:00Z"))?.id,
		).toBe("w");
		// 05:00 Tuesday -> active (tail of Monday's window spilled past midnight).
		expect(
			findActivePriceWindow([win], new Date("2026-06-02T05:00:00Z"))?.id,
		).toBe("w");
		// 12:00 Monday -> inactive (daytime gap).
		expect(
			findActivePriceWindow([win], new Date("2026-06-01T12:00:00Z")),
		).toBeNull();
	});

	it("respects days_of_week for the window's START day, including wrap tails", async () => {
		openSeedDatabase().sqlite.close();
		const { findActivePriceWindow } = await import("./analytics");
		// Wrap window that only STARTS on Monday (day 1): 22:00 Mon -> 06:00 Tue.
		const win = window({
			daysOfWeek: "1",
			startMinute: 22 * 60,
			endMinute: 6 * 60,
		});
		// 23:00 Monday -> active.
		expect(
			findActivePriceWindow([win], new Date("2026-06-01T23:00:00Z"))?.id,
		).toBe("w");
		// 05:00 Tuesday -> active (belongs to Monday's window).
		expect(
			findActivePriceWindow([win], new Date("2026-06-02T05:00:00Z"))?.id,
		).toBe("w");
		// 05:00 Monday -> inactive (would belong to Sunday's window, not scheduled).
		expect(
			findActivePriceWindow([win], new Date("2026-06-01T05:00:00Z")),
		).toBeNull();
	});

	it("ignores disabled windows", async () => {
		openSeedDatabase().sqlite.close();
		const { resolveEffectivePriceRule } = await import("./analytics");
		const now = new Date("2026-06-01T10:00:00Z");
		const win = window({
			startMinute: 0,
			endMinute: 1440,
			enabled: false,
			inputUsdMicrosPer1m: 1,
		});
		const rule = baseRule();
		expect(resolveEffectivePriceRule(rule, [win], now)).toBe(rule);
	});

	it("breaks overlapping-window ties by start_minute then id", async () => {
		openSeedDatabase().sqlite.close();
		const { findActivePriceWindow, resolveEffectivePriceRule } = await import(
			"./analytics"
		);
		const now = new Date("2026-06-01T10:00:00Z");
		// Both cover 10:00. Earliest start wins; equal start -> smaller id wins.
		const later = window({
			id: "b-later-start",
			startMinute: 8 * 60,
			endMinute: 18 * 60,
			inputUsdMicrosPer1m: 999,
		});
		const earlier = window({
			id: "a-earlier-start",
			startMinute: 0,
			endMinute: 20 * 60,
			inputUsdMicrosPer1m: 111,
		});
		expect(findActivePriceWindow([later, earlier], now)?.id).toBe(
			"a-earlier-start",
		);
		expect(
			resolveEffectivePriceRule(baseRule(), [later, earlier], now)
				?.inputUsdMicrosPer1m,
		).toBe(111);

		// Equal start_minute -> lexicographically smaller id.
		const tieA = window({
			id: "aaa",
			startMinute: 60,
			endMinute: 1200,
			inputUsdMicrosPer1m: 1,
		});
		const tieB = window({
			id: "bbb",
			startMinute: 60,
			endMinute: 1200,
			inputUsdMicrosPer1m: 2,
		});
		expect(findActivePriceWindow([tieB, tieA], now)?.id).toBe("aaa");
	});
});

describe("listPriceWindowsForModel", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-pricing-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});
	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Best-effort.
		}
	});

	it("returns only enabled windows for the model", async () => {
		const { sqlite, database } = openSeedDatabase();
		database
			.insert(schema.providers)
			.values({
				id: "p1",
				name: "deepseek",
				displayName: "DeepSeek",
				baseUrl: "https://deepseek.example",
				apiKeyEncrypted: "x",
				apiKeyIv: "y",
			})
			.run();
		database
			.insert(schema.providerModels)
			.values({ id: "m1", providerId: "p1", name: "chat", displayName: "Chat" })
			.run();
		database
			.insert(schema.providerModelPriceWindows)
			.values([
				{
					id: "on",
					providerModelId: "m1",
					label: "off-peak",
					startMinute: 0,
					endMinute: 60,
					enabled: 1,
				},
				{
					id: "off",
					providerModelId: "m1",
					label: "disabled",
					startMinute: 60,
					endMinute: 120,
					enabled: 0,
				},
			])
			.run();
		sqlite.close();

		const { listPriceWindowsForModel } = await import("./analytics");
		const windows = await listPriceWindowsForModel("m1");
		expect(windows.map((w) => w.id)).toEqual(["on"]);
		expect(windows[0].enabled).toBe(true);
	});
});
