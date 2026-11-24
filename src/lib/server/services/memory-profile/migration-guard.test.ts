import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { DatabaseInstance } from "$lib/server/db";
import * as schema from "$lib/server/db/schema";
import {
	MEMORY_MIGRATION_EXCLUDED,
	memoryMigrationGuard,
} from "./migration-guard";

let sqlite: Database.Database;
let db: DatabaseInstance;

beforeEach(() => {
	sqlite = new Database(":memory:");
	sqlite.pragma("foreign_keys = ON");
	db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.users)
		.values([
			{ id: "tester", email: "tester@tester.com", passwordHash: "h" },
			{ id: "person", email: "person@example.com", passwordHash: "h" },
		])
		.run();
	// What migration 141 did for the tester on the live database.
	db.update(schema.users)
		.set({ memoryMigrationExcluded: true })
		.where(eq(schema.users.id, "tester"))
		.run();
});
afterEach(() => sqlite.close());

it("refuses the excluded account and allows everyone else", () => {
	expect(memoryMigrationGuard("tester", db)).toEqual({
		allowed: false,
		reason: "excluded",
	});
	expect(memoryMigrationGuard("person", db)).toEqual({ allowed: true });
	expect(MEMORY_MIGRATION_EXCLUDED).toBe("memory_migration_excluded");
});

it("refuses an account it cannot find", () => {
	expect(memoryMigrationGuard("nobody", db)).toEqual({
		allowed: false,
		reason: "unknown_account",
	});
});

it("reads the flag by id, so a changed address keeps the exclusion", () => {
	db.update(schema.users)
		.set({ email: "someone-else@example.com" })
		.where(eq(schema.users.id, "tester"))
		.run();
	expect(memoryMigrationGuard("tester", db)).toEqual({
		allowed: false,
		reason: "excluded",
	});
	// And the address alone excludes nobody.
	db.update(schema.users)
		.set({ email: "tester@tester.com" })
		.where(eq(schema.users.id, "person"))
		.run();
	expect(memoryMigrationGuard("person", db)).toEqual({ allowed: true });
});
