// scripts/recompute-parallel-billing.ts against a real migrated SQLite
// fixture. The dry run is the default, so the first thing these tests have to
// prove is that a plain run writes nothing at all — and the second is that the
// run which does write books exactly the numbers the dry run previewed.
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

type ScriptModule = typeof import("./recompute-parallel-billing");

let dbPath: string;
let script: ScriptModule;

async function reimport() {
	process.env.DATABASE_PATH = dbPath;
	vi.resetModules();
	script = await import("./recompute-parallel-billing");
}

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const database = drizzle(sqlite, { schema });
	migrate(database, { migrationsFolder: "./drizzle" });
	return { sqlite, database };
}

function seedMonth(month: string, calls: number) {
	const sqlite = new Database(dbPath);
	const insert = sqlite.prepare(
		`INSERT INTO usage_events
			(id, user_id, conversation_id, message_id, model_id, model_display_name,
			 provider_display_name, usage_source, billing_month, cost_usd_micros, created_at)
		 VALUES (?, 'u1', '', ?, 'parallel:turbo', 'Parallel Turbo',
			 'Parallel', 'provider', ?, 1000, ?)`,
	);
	for (let index = 0; index < calls; index++) {
		insert.run(
			`${month}-${index}`,
			`parallel:${month}:${index}`,
			month,
			1_756_000_000 + index,
		);
	}
	sqlite.close();
}

function billedMicros(month: string): number {
	const sqlite = new Database(dbPath);
	const row = sqlite
		.prepare(
			"SELECT COALESCE(SUM(cost_usd_micros), 0) AS micros FROM usage_events WHERE billing_month = ? AND model_id LIKE 'parallel:%'",
		)
		.get(month) as { micros: number };
	sqlite.close();
	return row.micros;
}

describe("recompute-parallel-billing", () => {
	beforeEach(async () => {
		dbPath = `/tmp/alfyai-parallel-replay-${randomUUID()}.db`;
		openSeedDatabase().sqlite.close();
		process.env.PARALLEL_FREE_MONTHLY_USD = "5";
		await reimport();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("previews the change without writing in a dry run", async () => {
		seedMonth("2026-08", 3);
		seedMonth("2026-09", 2);

		const summary = await script.replayAllMonths({ apply: false });

		expect(summary.applied).toBe(false);
		expect(summary.rows).toEqual([
			{
				month: "2026-08",
				calls: 3,
				listMicros: 3000,
				beforeMicros: 3000,
				afterMicros: 0,
				changed: 3,
			},
			{
				month: "2026-09",
				calls: 2,
				listMicros: 2000,
				beforeMicros: 2000,
				afterMicros: 0,
				changed: 2,
			},
		]);
		// $5.00 is worth far more than the 5 calls seeded, so the preview is
		// free — and no row was touched.
		expect(billedMicros("2026-08")).toBe(3000);
		expect(billedMicros("2026-09")).toBe(2000);
	});

	it("applies exactly the previewed values with --apply", async () => {
		seedMonth("2026-08", 3);
		seedMonth("2026-09", 2);
		const preview = await script.replayAllMonths({ apply: false });

		const applied = await script.replayAllMonths({ apply: true });

		expect(applied.applied).toBe(true);
		for (const [index, row] of applied.rows.entries()) {
			expect(row.afterMicros).toBe(preview.rows[index]?.afterMicros);
			expect(billedMicros(row.month)).toBe(row.afterMicros);
		}
		expect(billedMicros("2026-08")).toBe(0);
		expect(billedMicros("2026-09")).toBe(0);
	});

	it("bills history the way the record path would, not by zeroing it", async () => {
		// Five calls against an allowance worth one of them: the first is free
		// and the rest are charged, so a replay that simply wrote 0 everywhere
		// would be wrong.
		process.env.PARALLEL_FREE_MONTHLY_USD = "0.001";
		await reimport();
		seedMonth("2026-09", 5);

		const summary = await script.replayAllMonths({ apply: true });

		expect(summary.rows[0]?.afterMicros).toBe(4000);
		expect(billedMicros("2026-09")).toBe(4000);
	});

	it("is idempotent: a second run previews zero changes", async () => {
		seedMonth("2026-08", 3);
		seedMonth("2026-09", 2);
		await script.replayAllMonths({ apply: true });

		const second = await script.replayAllMonths({ apply: false });

		expect(second.changed).toBe(0);
		expect(second.beforeMicros).toBe(second.afterMicros);
	});

	it("replays months in ascending billing-month order", async () => {
		seedMonth("2026-09", 1);
		seedMonth("2026-07", 1);
		seedMonth("2026-08", 1);

		const summary = await script.replayAllMonths({ apply: false });

		expect(summary.rows.map((row) => row.month)).toEqual([
			"2026-07",
			"2026-08",
			"2026-09",
		]);
	});

	it("refuses to guess which database to rewrite", async () => {
		const exit = vi.spyOn(process, "exit").mockImplementation((() => {
			throw new Error("process.exit");
		}) as unknown as typeof process.exit);
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		delete process.env.DATABASE_PATH;

		await expect(script.main([])).rejects.toThrow("process.exit");
		expect(exit).toHaveBeenCalledWith(1);
		expect(error.mock.calls.flat().join(" ")).toContain("DATABASE_PATH");

		exit.mockRestore();
		error.mockRestore();
	});

	it("reports a dry run and writes nothing through main", async () => {
		seedMonth("2026-09", 2);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});

		const code = await script.main([]);

		const output = log.mock.calls.flat().join("\n");
		expect(code).toBe(0);
		expect(output).toContain("dry run");
		expect(output).toContain("2026-09");
		expect(output).toContain("$0.000000");
		expect(billedMicros("2026-09")).toBe(2000);

		log.mockRestore();
	});
});
