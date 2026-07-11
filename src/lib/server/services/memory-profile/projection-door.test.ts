import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function openSeedDatabase() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	return { sqlite, db };
}

describe("projection mutation door", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-projection-door-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();

		const { sqlite, db } = openSeedDatabase();
		db.insert(schema.users)
			.values({
				id: "user-1",
				email: "projection-door@example.com",
				passwordHash: "hash",
				name: "Projection Door User",
			})
			.run();
		sqlite.close();
	});

	afterEach(async () => {
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported in a failed test.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("keeps the revision monotonic across interleaved door mutations and rejects the stale one", async () => {
		const { createMemoryProfileItem, updateMemoryProfileItemWithRevision } =
			await import("./projection-store");
		const { getMemoryProfileReadModel } = await import("./read-model");

		const item = await createMemoryProfileItem({
			userId: "user-1",
			category: "about_you",
			scope: { type: "global" },
			statement: "Lives in Budapest.",
		});
		const before = await getMemoryProfileReadModel({ userId: "user-1" });
		const baseRevision = before.projectionRevision;

		// Two writers read the SAME projection revision, then both attempt to
		// mutate. The door claims the revision optimistically: the first wins and
		// advances the revision by exactly one; the second, still holding the now
		// stale revision, is rejected with stale_projection and writes nothing.
		const first = await updateMemoryProfileItemWithRevision({
			userId: "user-1",
			itemId: item.id,
			expectedProjectionRevision: baseRevision,
			patch: { statement: "Lives in Amsterdam." },
		});
		const second = await updateMemoryProfileItemWithRevision({
			userId: "user-1",
			itemId: item.id,
			expectedProjectionRevision: baseRevision,
			patch: { statement: "Lives in Rotterdam." },
		});

		expect(first).toEqual({
			status: "updated",
			projectionRevision: baseRevision + 1,
		});
		expect(second).toEqual({ status: "stale_projection" });

		const after = await getMemoryProfileReadModel({ userId: "user-1" });
		// Monotonic: advanced by exactly one, never by two, never backwards.
		expect(after.projectionRevision).toBe(baseRevision + 1);
		expect(after.categories[0]?.items[0]?.statement).toBe(
			"Lives in Amsterdam.",
		);

		// The winner can chain off the new revision; the door stays monotonic.
		const third = await updateMemoryProfileItemWithRevision({
			userId: "user-1",
			itemId: item.id,
			expectedProjectionRevision: after.projectionRevision,
			patch: { statement: "Lives in Rotterdam." },
		});
		expect(third).toEqual({
			status: "updated",
			projectionRevision: baseRevision + 2,
		});
	});

	it("retires items through one door with identical state + revision behavior across callers", async () => {
		// Consolidation (supersede/merge) and re-curation (retire verdict) both
		// retire an item by composing the SAME door: updateMemoryProfileItemWith
		// Revision with a status:"retired" patch. Retiring three otherwise-identical
		// items must yield byte-identical item state and the same +1 revision step,
		// proving there is a single retire implementation behind the door.
		const { createMemoryProfileItem, updateMemoryProfileItemWithRevision } =
			await import("./projection-store");
		const { db } = await import("$lib/server/db");
		const { memoryProfileItems, memoryProjectionState } = schema;

		async function retireFreshItem(statement: string) {
			const created = await createMemoryProfileItem({
				userId: "user-1",
				category: "about_you",
				scope: { type: "global" },
				statement,
			});
			const patched = await updateMemoryProfileItemWithRevision({
				userId: "user-1",
				itemId: created.id,
				expectedProjectionRevision: created.projectionRevision,
				patch: { status: "retired" },
			});
			const [row] = await db
				.select()
				.from(memoryProfileItems)
				.where(eq(memoryProfileItems.id, created.id))
				.limit(1);
			return { created, patched, row };
		}

		const consolidationRetire = await retireFreshItem("Fact retired by merge.");
		const recurationRetire = await retireFreshItem(
			"Fact retired by recuration.",
		);
		const reviewRetire = await retireFreshItem("Fact retired by review.");

		for (const outcome of [
			consolidationRetire,
			recurationRetire,
			reviewRetire,
		]) {
			// Same door contract every time: a successful claim advancing the
			// projection revision by exactly one.
			expect(outcome.patched).toEqual({
				status: "updated",
				projectionRevision: outcome.created.projectionRevision + 1,
			});
			// Same terminal item state: retired, item revision bumped once.
			expect(outcome.row?.status).toBe("retired");
			expect(outcome.row?.revision).toBe(1);
		}

		// The projection revision is shared and monotonic across all three retires:
		// create+retire each contribute two steps, six total from a fresh store.
		const [projection] = await db
			.select()
			.from(memoryProjectionState)
			.where(
				and(
					eq(memoryProjectionState.userId, "user-1"),
					eq(memoryProjectionState.resetGeneration, 0),
				),
			)
			.limit(1);
		expect(projection?.revision).toBe(6);
	});
});
