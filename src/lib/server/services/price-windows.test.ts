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

function seedModel() {
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
	sqlite.close();
}

describe("parsePriceWindowPayload validation", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-pw-${randomUUID()}.db`;
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

	it("normalizes days and defaults, keeps null rate overrides", async () => {
		openSeedDatabase().sqlite.close();
		const { parsePriceWindowPayload } = await import("./price-windows");
		const input = parsePriceWindowPayload({
			label: "  off-peak  ",
			daysOfWeek: "6120",
			startMinute: 990,
			endMinute: 60,
			outputUsdMicrosPer1m: 500,
		});
		expect(input.label).toBe("off-peak");
		expect(input.daysOfWeek).toBe("0126"); // deduped + sorted
		expect(input.startMinute).toBe(990);
		expect(input.endMinute).toBe(60);
		expect(input.inputUsdMicrosPer1m).toBeNull();
		expect(input.outputUsdMicrosPer1m).toBe(500);
		expect(input.enabled).toBe(true);
	});

	it("rejects a missing label", async () => {
		openSeedDatabase().sqlite.close();
		const { parsePriceWindowPayload, PriceWindowValidationError } =
			await import("./price-windows");
		expect(() =>
			parsePriceWindowPayload({ startMinute: 0, endMinute: 60 }),
		).toThrow(PriceWindowValidationError);
	});

	it("rejects out-of-range minutes and bad days", async () => {
		openSeedDatabase().sqlite.close();
		const { parsePriceWindowPayload } = await import("./price-windows");
		expect(() =>
			parsePriceWindowPayload({ label: "x", startMinute: 1440, endMinute: 60 }),
		).toThrow(/startMinute/);
		expect(() =>
			parsePriceWindowPayload({ label: "x", startMinute: 0, endMinute: 1441 }),
		).toThrow(/endMinute/);
		expect(() =>
			parsePriceWindowPayload({
				label: "x",
				startMinute: 0,
				endMinute: 60,
				daysOfWeek: "7",
			}),
		).toThrow(/daysOfWeek/);
	});

	it("rejects a negative rate override", async () => {
		openSeedDatabase().sqlite.close();
		const { parsePriceWindowPayload } = await import("./price-windows");
		expect(() =>
			parsePriceWindowPayload({
				label: "x",
				startMinute: 0,
				endMinute: 60,
				inputUsdMicrosPer1m: -1,
			}),
		).toThrow(/inputUsdMicrosPer1m/);
	});
});

describe("price-windows CRUD", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-pw-${randomUUID()}.db`;
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

	it("creates, updates and deletes a window", async () => {
		seedModel();
		const {
			createPriceWindow,
			updatePriceWindow,
			deletePriceWindow,
			listPriceWindows,
			parsePriceWindowPayload,
		} = await import("./price-windows");

		const created = await createPriceWindow(
			"m1",
			parsePriceWindowPayload({
				label: "off-peak",
				startMinute: 0,
				endMinute: 480,
				inputUsdMicrosPer1m: 100,
			}),
		);
		expect(created.label).toBe("off-peak");

		const updated = await updatePriceWindow(
			created.id,
			parsePriceWindowPayload({
				label: "off-peak-2",
				startMinute: 60,
				endMinute: 480,
			}),
		);
		expect(updated?.label).toBe("off-peak-2");
		expect(updated?.inputUsdMicrosPer1m).toBeNull();

		expect((await listPriceWindows("m1")).length).toBe(1);
		expect(await deletePriceWindow(created.id)).toBe(true);
		expect((await listPriceWindows("m1")).length).toBe(0);
	});

	it("replaces the whole window set atomically", async () => {
		seedModel();
		const {
			replacePriceWindowsForModel,
			listPriceWindows,
			parsePriceWindowPayload,
		} = await import("./price-windows");

		await replacePriceWindowsForModel("m1", [
			parsePriceWindowPayload({ label: "a", startMinute: 0, endMinute: 60 }),
			parsePriceWindowPayload({ label: "b", startMinute: 120, endMinute: 180 }),
		]);
		expect((await listPriceWindows("m1")).map((w) => w.label)).toEqual([
			"a",
			"b",
		]);

		await replacePriceWindowsForModel("m1", [
			parsePriceWindowPayload({ label: "c", startMinute: 0, endMinute: 30 }),
		]);
		expect((await listPriceWindows("m1")).map((w) => w.label)).toEqual(["c"]);
	});

	it("rejects windows for a missing model", async () => {
		seedModel();
		const { replacePriceWindowsForModel, PriceWindowValidationError } =
			await import("./price-windows");
		await expect(
			replacePriceWindowsForModel("does-not-exist", []),
		).rejects.toBeInstanceOf(PriceWindowValidationError);
	});
});
