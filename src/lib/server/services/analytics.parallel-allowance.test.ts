// Slice B — the Parallel free monthly allowance.
//
// The rule lives in one pure function and is applied inside the same write
// that records the call, so these tests split in two: the arithmetic (no DB),
// and the booking path against a scratch database. The second half is where
// the boundary cases live — a call that crosses the line, two calls that
// together cost exactly one call, and the same month across two users.
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
		// The service may not have opened the DB if a test failed early.
	}
}

function currentBillingMonth(): string {
	return new Date().toISOString().slice(0, 7);
}

/**
 * Writes the override the way the admin screen does — an `admin_config` row —
 * and reloads the runtime config, so the test exercises the real
 * env → config-store → applier path instead of poking a variable.
 */
async function setAllowanceUsd(usd: number): Promise<void> {
	const sqlite = new Database(dbPath);
	sqlite
		.prepare(
			"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		)
		.run("PARALLEL_FREE_MONTHLY_USD", String(usd), Date.now(), "test");
	sqlite.close();

	const { refreshConfig } = await import("$lib/server/config-store");
	await refreshConfig();
}

/** Billed micros of the `parallel:*` rows in scope. */
function billedMicrosFor(
	scope: { userId?: string; month?: string } = {},
): number {
	const clauses = ["model_id LIKE 'parallel:%'", "billing_month = ?"];
	const params: Array<string> = [scope.month ?? currentBillingMonth()];
	if (scope.userId) {
		clauses.push("user_id = ?");
		params.push(scope.userId);
	}

	const sqlite = new Database(dbPath);
	const row = sqlite
		.prepare(
			`SELECT COALESCE(SUM(cost_usd_micros), 0) AS micros FROM usage_events WHERE ${clauses.join(" AND ")}`,
		)
		.get(...params) as { micros: number };
	sqlite.close();
	return row.micros;
}

/** Billed micros of the whole server's Parallel calls in a month. */
function totalBilledMicros(month = currentBillingMonth()): number {
	return billedMicrosFor({ month });
}

describe("parallelBilledMicros", () => {
	it("books nothing while the month stays under the allowance", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		expect(parallelBilledMicros(0, 1000, 5_000_000)).toBe(0);
	});

	it("books only the part above the allowance on the crossing call", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		// allowance 5_000 micros = 5 calls; the 6th call crosses it.
		expect(parallelBilledMicros(5_000, 6_000, 5_000)).toBe(1000);
	});

	it("books a half-crossed call only for its remainder", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		// allowance 5_500: call 6 goes 5_000 -> 6_000, so 500 micros are over
		// the line.
		expect(parallelBilledMicros(5_000, 6_000, 5_500)).toBe(500);
	});

	it("books full price once the month is past the allowance", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		expect(parallelBilledMicros(9_000, 10_000, 5_000)).toBe(1000);
	});

	it("behaves like today when the allowance is zero", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		expect(parallelBilledMicros(0, 1_000, 0)).toBe(1000);
		expect(parallelBilledMicros(9_000, 10_000, 0)).toBe(1000);
	});

	it("never books a negative amount when the allowance exceeds the whole month", async () => {
		const { parallelBilledMicros } = await import("./analytics");
		expect(parallelBilledMicros(0, 1_000, 10_000_000)).toBe(0);
	});

	it("derives the list price from the call count", async () => {
		const { parallelListMicrosForCalls } = await import("./analytics");
		expect(parallelListMicrosForCalls(0)).toBe(0);
		expect(parallelListMicrosForCalls(3)).toBe(3_000);
	});

	it("sums a month's calls into the running billed series", async () => {
		const { parallelBilledSeries } = await import("./analytics");
		// Six calls, an allowance worth exactly five of them.
		expect(parallelBilledSeries(6, 5_000)).toEqual([0, 0, 0, 0, 0, 1000]);
		// An allowance that stops halfway through the sixth call.
		expect(parallelBilledSeries(6, 5_500)).toEqual([0, 0, 0, 0, 0, 500]);
	});
});

describe("recordParallelUsage against the free allowance", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-parallel-allowance-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		vi.unstubAllEnvs();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("is free for the first call of the month", async () => {
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");

		await recordParallelUsage({ userId: "u1", tool: "research_web" });

		expect(totalBilledMicros()).toBe(0);
	});

	it("counts the whole server, not one user, against the allowance", async () => {
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");

		// 0.002 USD = 2,000 micros = exactly two calls free, across users.
		await setAllowanceUsd(0.002);
		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		await recordParallelUsage({ userId: "u2", tool: "fetch_url" });
		expect(totalBilledMicros()).toBe(0);

		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		expect(totalBilledMicros()).toBe(1000);
		// The third call is booked against whoever made it, not against the
		// user who happened to use the free ones.
		expect(billedMicrosFor({ userId: "u2" })).toBe(0);
		expect(billedMicrosFor({ userId: "u1" })).toBe(1000);
	});

	it("charges the crossing call for its remainder only", async () => {
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");

		// The allowance is a dollar amount and need not land on a call
		// boundary: 0.0025 USD = 2,500 micros = two and a half calls.
		await setAllowanceUsd(0.0025);
		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		await recordParallelUsage({ userId: "u1", tool: "research_web" });

		expect(totalBilledMicros()).toBe(500);
	});

	it("keeps the total exact when two calls are recorded back to back at the boundary", async () => {
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");

		await setAllowanceUsd(0.001); // exactly one call
		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		await recordParallelUsage({ userId: "u1", tool: "research_web" });

		expect(totalBilledMicros()).toBe(1000);
	});

	it("charges every call when the allowance is zero", async () => {
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");

		await setAllowanceUsd(0);
		await recordParallelUsage({ userId: "u1", tool: "research_web" });
		await recordParallelUsage({ userId: "u1", tool: "fetch_url" });
		await recordParallelUsage({ userId: "u1", tool: "research_web" });

		expect(totalBilledMicros()).toBe(3000);
	});

	it("reads the month's running total and writes the row in one transaction", async () => {
		// The count and the insert have to be atomic: two simultaneous calls
		// would otherwise both read "under the allowance" and both book $0.
		// better-sqlite3 is synchronous, so one db.transaction around the pair
		// is what makes that true; this pins the write path to that shape.
		openSeedDatabase().sqlite.close();
		const { recordParallelUsage } = await import("./analytics");
		const { db } = await import("$lib/server/db");
		const transaction = vi.spyOn(db, "transaction");

		await recordParallelUsage({ userId: "u1", tool: "research_web" });

		expect(transaction).toHaveBeenCalledTimes(1);
		transaction.mockRestore();
	});
});

describe("recomputeParallelBillingForMonth", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-parallel-allowance-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		vi.unstubAllEnvs();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	/**
	 * Charges a month's Parallel rows by hand, so a replay can be asked to
	 * rewrite a month that is not the current one. `id` and `created_at` are
	 * deliberately in opposite orders, so a replay that sorted by row id would
	 * bill a different row than one that sorted by call time.
	 */
	function seedChargedMonth(month: string, calls: number) {
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
				`row-${month}-${calls - index}`,
				`parallel:${month}:${calls - index}`,
				month,
				1_756_000_000 + index,
			);
		}
		sqlite.close();
	}

	function costOfRow(id: string): number {
		const sqlite = new Database(dbPath);
		const row = sqlite
			.prepare(
				"SELECT cost_usd_micros AS micros FROM usage_events WHERE id = ?",
			)
			.get(id) as { micros: number } | undefined;
		sqlite.close();
		return row?.micros ?? -1;
	}

	it("recomputes only the requested month", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-08", 1);
		seedChargedMonth("2026-09", 2);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		const result = await recomputeParallelBillingForMonth("2026-09", 5, {
			apply: true,
		});

		expect(result.month).toBe("2026-09");
		// A month nobody asked about keeps the cost it was booked at.
		expect(billedMicrosFor({ month: "2026-08" })).toBe(1000);
		expect(billedMicrosFor({ month: "2026-09" })).toBe(0);
	});

	it("writes nothing in a dry run", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-09", 2);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		const before = billedMicrosFor({ month: "2026-09" });
		const result = await recomputeParallelBillingForMonth("2026-09", 0, {
			apply: false,
		});

		expect(result.changed).toBe(0);
		expect(billedMicrosFor({ month: "2026-09" })).toBe(before);
	});

	it("reports what a dry run would rewrite without touching a row", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-09", 2);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		const result = await recomputeParallelBillingForMonth("2026-09", 5, {
			apply: false,
		});

		expect(result.applied).toBe(false);
		expect(result.changed).toBe(2);
		expect(result.billedMicros).toBe(0);
		expect(result.previousMicros).toBe(2000);
		expect(billedMicrosFor({ month: "2026-09" })).toBe(2000);
	});

	it("bills the crossing call's remainder, in call order", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-09", 2);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		// 0.001 USD = exactly one call, so the earlier call is free and the
		// later one pays. Sorting by row id instead of call time would swap
		// those two rows around.
		const result = await recomputeParallelBillingForMonth("2026-09", 0.001, {
			apply: true,
		});

		// Only the earlier row moves: the later one was already booked at the
		// price the replay gives it, so it is not rewritten.
		expect(result.changed).toBe(1);
		expect(costOfRow("row-2026-09-2")).toBe(0);
		expect(costOfRow("row-2026-09-1")).toBe(1000);
		expect(billedMicrosFor({ month: "2026-09" })).toBe(1000);
	});

	it("is idempotent: a second run finds nothing left to change", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-09", 3);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		await recomputeParallelBillingForMonth("2026-09", 0.0025, { apply: true });
		const second = await recomputeParallelBillingForMonth("2026-09", 0.0025, {
			apply: true,
		});

		expect(second.changed).toBe(0);
		expect(billedMicrosFor({ month: "2026-09" })).toBe(500);
	});

	it("leaves the months it was not asked about out of the write", async () => {
		openSeedDatabase().sqlite.close();
		seedChargedMonth("2026-08", 2);
		const { recomputeParallelBillingForMonth } = await import("./analytics");

		const result = await recomputeParallelBillingForMonth("2026-09", 5, {
			apply: true,
		});

		expect(result.calls).toBe(0);
		expect(result.changed).toBe(0);
		expect(billedMicrosFor({ month: "2026-08" })).toBe(2000);
	});
});
