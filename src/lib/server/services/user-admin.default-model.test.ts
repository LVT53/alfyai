import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

let dbPath: string;

function prepareDatabaseWithDefaultModel(defaultModel: string) {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	db.insert(schema.adminConfig)
		.values({
			key: "DEFAULT_NEW_USER_MODEL",
			value: defaultModel,
			updatedAt: new Date("2026-05-15T12:00:00.000Z"),
			updatedBy: "admin-1",
		})
		.run();
	sqlite.close();
}

function readUserByEmail(email: string) {
	const sqlite = new Database(dbPath);
	const db = drizzle(sqlite, { schema });
	const user = db
		.select()
		.from(schema.users)
		.where(eq(schema.users.email, email))
		.get();
	sqlite.close();
	return user;
}

async function closeServiceDatabase() {
	try {
		const { sqlite } = await import("$lib/server/db");
		sqlite.close();
	} catch {
		// The service DB may not have been imported if setup failed early.
	}
}

describe("createManagedUser default model", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-user-default-model-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
	});

	afterEach(async () => {
		await closeServiceDatabase();
		try {
			unlinkSync(dbPath);
		} catch {
			// Temporary DB cleanup is best-effort.
		}
	});

	it("stores inherited system default for new managed users", async () => {
		prepareDatabaseWithDefaultModel("model2");
		const { refreshConfig } = await import("$lib/server/config-store");
		const { createManagedUser } = await import("./user-admin");

		await refreshConfig();
		await createManagedUser({
			email: "new-user@example.com",
			password: "supersecret",
			role: "user",
		});

		expect(readUserByEmail("new-user@example.com")).toEqual(
			expect.objectContaining({
				email: "new-user@example.com",
				preferredModel: "model2",
				modelPreferenceMode: "system",
			}),
		);
	});
});
