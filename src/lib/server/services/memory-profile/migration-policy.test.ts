import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let sqlite: Database.Database;
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys=ON");
	migrate(drizzle(sqlite, { schema }), { migrationsFolder: "./drizzle" });
	const db = drizzle(sqlite, { schema });
	for (const id of ["alice", "bob"]) {
		db.insert(schema.users)
			.values({ id, email: `${id}@test.invalid`, passwordHash: "x" })
			.run();
		db.insert(schema.memoryAccounts)
			.values({ userId: id, tenantId: randomUUID(), authority: "hindsight" })
			.run();
	}
});
afterEach(() => sqlite.close());
describe("historical memory permission", () => {
	it("uses enabled Memory by default without recording an earlier-chat choice", async () => {
		const { getHistoryImportStatus } = await import("./migration-policy");
		const { isHistoricalMemorySourceEligible } = await import(
			"./history-eligibility"
		);
		expect((await getHistoryImportStatus("alice")).choice).toBe(null);
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date("2020-01-01"),
				incognito: false,
			}),
		).toBe(true);
	});
	it("limits an explicit include to its cutoff and preserves known disabled intervals", async () => {
		const { recordHistoryImportChoice } = await import("./migration-policy");
		const { isHistoricalMemorySourceEligible } = await import(
			"./history-eligibility"
		);
		const choice = await recordHistoryImportChoice("alice", {
			choice: "include",
			requestId: "include1",
		});
		expect(choice.cutoff).not.toBe(null);
		await recordHistoryImportChoice("bob", {
			choice: "decline",
			requestId: "bob-opt-out",
		});
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date("2020-01-01"),
				incognito: false,
			}),
		).toBe(true);
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "bob",
				assertedAt: new Date("2020-01-01"),
				incognito: false,
			}),
		).toBe(false);
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date(Date.now() + 86400000),
				incognito: false,
			}),
		).toBe(false);
		drizzle(sqlite, { schema })
			.insert(schema.memoryControlIntervals)
			.values({
				id: randomUUID(),
				userId: "alice",
				enabled: false,
				startedAt: new Date("2019-01-01"),
				endedAt: new Date("2021-01-01"),
				epoch: 0,
			})
			.run();
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date("2020-01-01"),
				incognito: false,
			}),
		).toBe(false);
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date("2022-01-01"),
				incognito: true,
			}),
		).toBe(false);
	});
	it("reset overrides consent and repeat requests cannot advance the cutoff", async () => {
		const { recordHistoryImportChoice } = await import("./migration-policy");
		const { isHistoricalMemorySourceEligible } = await import(
			"./history-eligibility"
		);
		const choice = await recordHistoryImportChoice("alice", {
			choice: "include",
			requestId: "same",
		});
		expect(
			await recordHistoryImportChoice("alice", {
				choice: "include",
				requestId: "same",
			}),
		).toEqual(choice);
		drizzle(sqlite, { schema })
			.insert(schema.memoryResetGenerations)
			.values({
				userId: "alice",
				resetGeneration: 1,
				advancedAt: new Date("2021-01-01"),
			})
			.run();
		expect(
			await isHistoricalMemorySourceEligible({
				userId: "alice",
				assertedAt: new Date("2020-01-01"),
				incognito: false,
			}),
		).toBe(false);
	});
	it("records toggle intervals atomically and duplicate toggles do not rewrite their start", async () => {
		const { setMemoryEnabled } = await import("./migration-policy");
		await setMemoryEnabled("alice", false);
		await setMemoryEnabled("alice", false);
		const db = drizzle(sqlite, { schema });
		expect(db.select().from(schema.memoryControlIntervals).all()).toHaveLength(
			1,
		);
		await setMemoryEnabled("alice", true);
		const intervals = db.select().from(schema.memoryControlIntervals).all();
		expect(intervals).toHaveLength(2);
		expect(intervals.filter((x) => !x.endedAt)).toHaveLength(1);
	});
});
