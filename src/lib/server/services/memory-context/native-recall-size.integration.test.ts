import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

// The app's side of recall at size, on this machine only: the normal gates
// skip it. In-memory SQLite and a fake native client whose every ranking
// returns all of a bank's rows, so the time measured is the app's own work
// (reads, verification, sharing, formatting), never Hindsight's search.
const PERSONAL_ROWS = 5_000;
const PROJECT_ROWS = 1_000;
const RECALLS = 20;

let sqlite: Database.Database;
vi.mock("$lib/server/db", () => ({
	get db() {
		return drizzle(sqlite, { schema });
	},
}));
const rankings = new Map<string, unknown[]>();
vi.mock("../memory-profile/hindsight-client", () => ({
	nativeMemoryClient: (bankId: string) => ({
		recall: async () => rankings.get(bankId) ?? [],
		list: async () => [],
	}),
}));

/** One bank of synthetic rows, each an accepted source, fact and published row. */
function seedBank(bankId: string, scopeKey: string, count: number) {
	const db = drizzle(sqlite, { schema });
	db.insert(schema.memoryBanks)
		.values({ id: bankId, userId: "u", scopeKey, epoch: 0, generation: "g" })
		.run();
	const ranking: unknown[] = [];
	db.transaction((tx) => {
		for (let i = 0; i < count; i++) {
			const text = `Synthetic fact ${i} of ${bankId}: option ${i % 7} suits task ${i % 50}.`;
			const fact = { id: `f-${bankId}-${i}`, text };
			tx.insert(schema.memorySourceRevisions)
				.values({
					id: `s-${bankId}-${i}`,
					bankId,
					userId: "u",
					epoch: 0,
					eventId: `${bankId}-${i}`,
					lineageId: `${bankId}-${i}`,
					text,
					context: "",
					textHash: "hash",
					assertedAt: new Date(Date.UTC(2026, 0, 1) + i * 60_000),
					state: "accepted",
					acknowledgedFactsJson: JSON.stringify([fact]),
				})
				.run();
			tx.insert(schema.memoryPublishedRows)
				.values({
					id: `r-${bankId}-${i}`,
					bankId,
					generation: "g",
					epoch: 0,
					nativeId: `n-${bankId}-${i}`,
					text,
					nativeText: text,
					sourceIdsJson: JSON.stringify([fact.id]),
					sourceFingerprintsJson: JSON.stringify([fact]),
					updatedAt: new Date(),
				})
				.run();
			ranking.push({
				id: `n-${bankId}-${i}`,
				text,
				fact_type: "observation",
				source_memory_ids: [fact.id],
			});
		}
	});
	rankings.set(bankId, ranking);
}

/** The nearest-rank percentile of a list of timings. */
function percentile(values: number[], q: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] ?? 0;
}

describe.runIf(process.env.MEMORY_RECALL_SIZE_CHECK === "1")(
	"native recall at size",
	() => {
		beforeAll(() => {
			sqlite = new Database(":memory:");
			sqlite.pragma("foreign_keys=ON");
			const db = drizzle(sqlite, { schema });
			migrate(db, { migrationsFolder: "./drizzle" });
			db.insert(schema.users)
				.values({ id: "u", email: "u@x.invalid", passwordHash: "x" })
				.run();
			db.insert(schema.memoryAccounts)
				.values({ userId: "u", tenantId: randomUUID(), authority: "hindsight" })
				.run();
			db.insert(schema.projects)
				.values({ id: "p", userId: "u", name: "p" })
				.run();
			db.insert(schema.conversations)
				.values({
					id: "c",
					title: "Synthetic project chat",
					userId: "u",
					projectId: "p",
				})
				.run();
			seedBank("bp", "personal", PERSONAL_ROWS);
			seedBank("bj", "project:p", PROJECT_ROWS);
		}, 120_000);
		afterAll(() => {
			sqlite?.close();
		});

		it("keeps the app's side of a per-turn recall under 500 ms at the 95th percentile", async () => {
			const { recallMemory } = await import("./native");
			const timings: number[] = [];
			const info = vi.spyOn(console, "info").mockImplementation(() => {});
			try {
				for (let turn = 0; turn < RECALLS; turn++) {
					const started = performance.now();
					const recalled = await recallMemory("u", {
						conversationId: "c",
						query: `What did we settle for task ${turn} of the project?`,
						tokenBudget: 4_000,
						core: true,
					});
					timings.push(performance.now() - started);
					expect(recalled.length).toBeGreaterThan(0);
				}
			} finally {
				info.mockRestore();
			}
			const median = percentile(timings, 0.5);
			const p95 = percentile(timings, 0.95);
			console.log(
				`[recall-size] personal=${PERSONAL_ROWS} project=${PROJECT_ROWS} recalls=${RECALLS} medianMs=${median.toFixed(1)} p95Ms=${p95.toFixed(1)}`,
			);
			expect(p95).toBeLessThan(500);
		}, 300_000);
	},
);
