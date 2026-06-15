import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "$lib/server/db/schema";

const { mockEraseUserAccountAsAdmin } = vi.hoisted(() => ({
	mockEraseUserAccountAsAdmin: vi.fn(),
}));

vi.mock("./privacy-controls", () => ({
	DETACHED_SHARED_CONTENT_OWNER_ID: "detached-shared-content-owner",
	eraseUserAccountAsAdmin: mockEraseUserAccountAsAdmin,
}));

let dbPath: string;

function seedAdminAndTargetUsers() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	migrate(db, { migrationsFolder: "./drizzle" });
	const now = new Date("2026-06-15T13:00:00.000Z");
	db.insert(schema.users)
		.values([
			{
				id: "admin-1",
				email: "admin@example.com",
				passwordHash: "hash",
				role: "admin",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "user-1",
				email: "user@example.com",
				passwordHash: "hash",
				role: "user",
				createdAt: now,
				updatedAt: now,
			},
		])
		.run();
	sqlite.close();
}

function seedDetachedOwnerUser() {
	const sqlite = new Database(dbPath);
	sqlite.pragma("foreign_keys = ON");
	const db = drizzle(sqlite, { schema });
	const now = new Date("2026-06-15T13:30:00.000Z");
	db.insert(schema.users)
		.values({
			id: "detached-shared-content-owner",
			email: "detached-shared-content-owner@alfyai.local",
			name: "Detached shared content owner",
			passwordHash: "",
			role: "user",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	sqlite.close();
}

describe("deleteManagedUser", () => {
	beforeEach(() => {
		dbPath = `/tmp/alfyai-user-admin-delete-${randomUUID()}.db`;
		process.env.DATABASE_PATH = dbPath;
		vi.resetModules();
		vi.clearAllMocks();
		mockEraseUserAccountAsAdmin.mockResolvedValue(true);
	});

	afterEach(async () => {
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

	it("reuses the shared Account Erasure boundary for admin deletion", async () => {
		seedAdminAndTargetUsers();
		const { deleteManagedUser } = await import("./user-admin");

		await deleteManagedUser({
			actorUserId: "admin-1",
			targetUserId: "user-1",
		});

		expect(mockEraseUserAccountAsAdmin).toHaveBeenCalledWith("user-1");
	});

	it("does not list the detached shared-content owner as a managed user", async () => {
		seedAdminAndTargetUsers();
		seedDetachedOwnerUser();
		const { listManagedUsers } = await import("./user-admin");

		const users = await listManagedUsers();

		expect(users.map((user) => user.id)).toEqual(["admin-1", "user-1"]);
	});
});
