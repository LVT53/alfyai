import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootEngine, type EngineHarness } from "../jobs/testing/harness";

let h: EngineHarness;
beforeEach(async () => {
	h = await bootEngine("memory-labels-verified");
});
afterEach(() => h.cleanup());

async function modules() {
	const { db } = await import("$lib/server/db");
	const schema = await import("$lib/server/db/schema");
	const revisions = await import("./revisions");
	const state = await import("./labels-verified");
	return { db, schema, revisions, state };
}

describe("which Memory page an account gets", () => {
	it("a user with no Memory account gets the new page", async () => {
		const { state } = await modules();
		expect(state.memoryLabelsVerified(h.userId)).toBe(true);
		expect(state.memoryPageLayout(h.userId)).toBe("subjects");
	});

	it("an account marked for its epoch keeps today's page until the writer clears it", async () => {
		const { db, revisions, state } = await modules();
		revisions.ensureMemoryBank(h.userId, { kind: "personal" });
		db.transaction((tx) => state.markMemoryLabelsUnverified(tx, h.userId, 0));
		expect(state.memoryLabelsVerified(h.userId)).toBe(false);
		expect(state.memoryPageLayout(h.userId)).toBe("list");
		expect(
			db.transaction((tx) => state.markMemoryLabelsVerified(tx, h.userId, 0)),
		).toBe(true);
		expect(state.memoryLabelsVerified(h.userId)).toBe(true);
		expect(state.memoryPageLayout(h.userId)).toBe("subjects");
	});

	it("the writer does nothing for another epoch", async () => {
		const { db, revisions, state } = await modules();
		revisions.ensureMemoryBank(h.userId, { kind: "personal" });
		db.transaction((tx) => state.markMemoryLabelsUnverified(tx, h.userId, 0));
		expect(
			db.transaction((tx) => state.markMemoryLabelsVerified(tx, h.userId, 1)),
		).toBe(false);
		expect(state.memoryLabelsVerified(h.userId)).toBe(false);
	});

	it("a new epoch (Clear Memory) reads verified with no write", async () => {
		const { db, schema, revisions, state } = await modules();
		revisions.ensureMemoryBank(h.userId, { kind: "personal" });
		db.transaction((tx) => state.markMemoryLabelsUnverified(tx, h.userId, 0));
		db.update(schema.memoryAccounts).set({ epoch: 1 }).run();
		expect(state.memoryLabelsVerified(h.userId)).toBe(true);
	});

	it("marking an epoch the account has left does nothing", async () => {
		const { db, schema, revisions, state } = await modules();
		revisions.ensureMemoryBank(h.userId, { kind: "personal" });
		db.update(schema.memoryAccounts).set({ epoch: 1 }).run();
		db.transaction((tx) => state.markMemoryLabelsUnverified(tx, h.userId, 0));
		expect(state.memoryLabelsVerified(h.userId)).toBe(true);
	});

	it("a new config-2 bank does not verify an unverified epoch", async () => {
		const { db, schema, revisions, state } = await modules();
		revisions.ensureMemoryBank(h.userId, { kind: "personal" });
		db.transaction((tx) => state.markMemoryLabelsUnverified(tx, h.userId, 0));
		db.insert(schema.projects)
			.values({ id: "synthetic-project", userId: h.userId, name: "Garden" })
			.run();
		revisions.ensureMemoryBank(h.userId, {
			kind: "project",
			projectId: "synthetic-project",
		});
		expect(state.memoryLabelsVerified(h.userId)).toBe(false);
	});
});

describe("migration 143", () => {
	/** The migration's statements after the column it adds (the harness has run it already). */
	function markingStatements(): string[] {
		const sql = readFileSync(
			resolve(
				process.cwd(),
				"drizzle/1777140000143_memory_labels_unverified_epoch.sql",
			),
			"utf8",
		);
		return sql
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter((statement) => statement && !/\bALTER TABLE\b/i.test(statement));
	}

	it("leaves the tester account untouched, whatever it holds", async () => {
		const { db, schema, state } = await modules();
		const { sql } = await import("drizzle-orm");
		db.insert(schema.users)
			.values({
				id: "tester",
				email: "Tester@Tester.com",
				passwordHash: "synthetic",
			})
			.run();
		db.insert(schema.memoryAccounts)
			.values({ userId: "tester", tenantId: "tenant-tester" })
			.run();
		db.insert(schema.memoryBanks)
			.values({
				id: "tester-bank",
				userId: "tester",
				scopeKey: "personal",
				epoch: 0,
			})
			.run();
		for (const statement of markingStatements()) db.run(sql.raw(statement));
		expect(
			db
				.select({ epoch: schema.memoryAccounts.labelsUnverifiedEpoch })
				.from(schema.memoryAccounts)
				.get()?.epoch,
		).toBeNull();
		expect(state.memoryLabelsVerified("tester")).toBe(true);
	});

	it("marks accounts with a bank in their current epoch and no other", async () => {
		const { db, schema, state } = await modules();
		const { sql } = await import("drizzle-orm");
		const others = ["with-old-bank", "without-bank"];
		for (const id of others)
			db.insert(schema.users)
				.values({
					id,
					email: `${id}@example.test`,
					passwordHash: "synthetic",
					name: id,
				})
				.run();
		for (const [userId, epoch] of [
			[h.userId, 2],
			["with-old-bank", 3],
			["without-bank", 0],
		] as const)
			db.insert(schema.memoryAccounts)
				.values({ userId, tenantId: `tenant-${userId}`, epoch })
				.run();
		db.insert(schema.memoryBanks)
			.values([
				{ id: "current", userId: h.userId, scopeKey: "personal", epoch: 2 },
				{
					id: "old",
					userId: "with-old-bank",
					scopeKey: "personal",
					epoch: 2,
				},
			])
			.run();
		for (const statement of markingStatements()) db.run(sql.raw(statement));
		expect(state.memoryLabelsVerified(h.userId)).toBe(false);
		expect(state.memoryLabelsVerified("with-old-bank")).toBe(true);
		expect(state.memoryLabelsVerified("without-bank")).toBe(true);
		expect(
			db
				.select({ epoch: schema.memoryAccounts.labelsUnverifiedEpoch })
				.from(schema.memoryAccounts)
				.all()
				.map(({ epoch }) => epoch)
				.sort(),
		).toEqual([2, null, null]);
	});
});
