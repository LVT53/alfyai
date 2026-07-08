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

describe("retired status + persona summary columns", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-memory-retired-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		seedConnections = [];
	});

	afterEach(async () => {
		for (const conn of seedConnections) {
			try {
				conn.sqlite.close();
			} catch {
				// Best-effort close
			}
		}
		try {
			const { sqlite } = await import("$lib/server/db");
			sqlite.close();
		} catch {
			// The DB module may not have been imported if a test failed early.
		}
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("retires an item via updateMemoryProfileItemWithRevision and excludes it from active context", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "u1",
				email: "u1@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const { createMemoryProfileItem, updateMemoryProfileItemWithRevision } =
			await import("./projection-store");
		const { getActiveMemoryProfileContext } = await import("./active-context");
		const created = await createMemoryProfileItem({
			userId: "u1",
			category: "preferences",
			scope: { type: "global" },
			statement: "I prefer plain language.",
		});
		const updated = await updateMemoryProfileItemWithRevision({
			userId: "u1",
			itemId: created.id,
			expectedProjectionRevision: created.projectionRevision,
			patch: { status: "retired" },
		});
		expect(updated.status).toBe("updated");
		const ctx = await getActiveMemoryProfileContext({ userId: "u1" });
		expect(ctx.items).toHaveLength(0);
	});

	it("stores and reads persona summary columns on projection state", async () => {
		const { db } = openSeedDatabase();
		const now = new Date("2026-06-01T10:00:00.000Z");
		db.insert(schema.users)
			.values({
				id: "u1",
				email: "u1@example.com",
				passwordHash: "hash",
				createdAt: now,
				updatedAt: now,
			})
			.run();

		const { ensureProjectionState } = await import("./projection-store");
		const { db: appDb } = await import("$lib/server/db");
		const appSchema = await import("$lib/server/db/schema");
		const state = await ensureProjectionState({
			userId: "u1",
			resetGeneration: 0,
		});
		const { eq } = await import("drizzle-orm");
		await appDb
			.update(appSchema.memoryProjectionState)
			.set({
				personaSummaryText: "Test.",
				personaSummaryLinksJson: JSON.stringify([
					{ text: "Test.", factIds: [] },
				]),
				personaSummaryUpdatedAt: new Date(),
			})
			.where(eq(appSchema.memoryProjectionState.id, state.id));
		const row = await appDb.query.memoryProjectionState.findFirst({
			where: eq(appSchema.memoryProjectionState.id, state.id),
		});
		expect(row?.personaSummaryText).toBe("Test.");
	});
});
