import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createInMemoryDatabase,
	type InMemoryDatabase,
} from "$lib/server/db/in-memory";
import {
	createQueryExecutor,
	type QueryExecutor,
} from "$lib/server/db/query-executor";
import * as schema from "$lib/server/db/schema";

const { mockEraseUserAccountAsAdmin } = vi.hoisted(() => ({
	mockEraseUserAccountAsAdmin: vi.fn(),
}));

vi.mock("./privacy-controls", () => ({
	DETACHED_SHARED_CONTENT_OWNER_ID: "detached-shared-content-owner",
	eraseUserAccountAsAdmin: mockEraseUserAccountAsAdmin,
}));

// Regular static import works here (unlike the old file-backed pattern):
// the in-memory adapter needs no DATABASE_PATH env swap or vi.resetModules()
// dance, so there is no reason to defer loading the module under test.
const { deleteManagedUser, listManagedUsers } = await import("./user-admin");

let memory: InMemoryDatabase;
let executor: QueryExecutor;

function seedAdminAndTargetUsers() {
	const now = new Date("2026-06-15T13:00:00.000Z");
	memory.db
		.insert(schema.users)
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
}

function seedDetachedOwnerUser() {
	const now = new Date("2026-06-15T13:30:00.000Z");
	memory.db
		.insert(schema.users)
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
}

describe("deleteManagedUser", () => {
	beforeEach(() => {
		memory = createInMemoryDatabase();
		executor = createQueryExecutor(memory.db);
		vi.clearAllMocks();
		mockEraseUserAccountAsAdmin.mockResolvedValue(true);
	});

	afterEach(() => {
		memory.close();
	});

	it("reuses the shared Account Erasure boundary for admin deletion", async () => {
		seedAdminAndTargetUsers();

		await deleteManagedUser(
			{
				actorUserId: "admin-1",
				targetUserId: "user-1",
			},
			executor,
		);

		expect(mockEraseUserAccountAsAdmin).toHaveBeenCalledWith("user-1");
	});

	it("does not list the detached shared-content owner as a managed user", async () => {
		seedAdminAndTargetUsers();
		seedDetachedOwnerUser();

		const users = await listManagedUsers(executor);

		expect(users.map((user) => user.id)).toEqual(["admin-1", "user-1"]);
	});
});
