import { eq } from "drizzle-orm";
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

vi.mock("./privacy-controls", () => ({
	DETACHED_SHARED_CONTENT_OWNER_ID: "detached-shared-content-owner",
	eraseUserAccountAsAdmin: vi.fn(),
}));

const { listManagedUsers, setManagedUserExplicitPictureFilterExempt } =
	await import("./user-admin");

// An admin exempts one person from the explicit-picture filter, or puts it
// back on for them; everyone starts filtered.

let memory: InMemoryDatabase;
let executor: QueryExecutor;

function addPerson(id: string) {
	memory.db
		.insert(schema.users)
		.values({ id, email: `${id}@example.com`, passwordHash: "hash" })
		.run();
}

function exemptColumn(id: string) {
	return memory.db
		.select({ exempt: schema.users.explicitPictureFilterExempt })
		.from(schema.users)
		.where(eq(schema.users.id, id))
		.get()?.exempt;
}

beforeEach(() => {
	memory = createInMemoryDatabase();
	executor = createQueryExecutor(memory.db);
	addPerson("target");
	addPerson("bystander");
});

afterEach(() => {
	memory.close();
});

describe("the explicit-picture filter, per person", () => {
	it("is on for everyone in the users list", async () => {
		const people = await listManagedUsers(executor);
		expect(people.map((person) => person.explicitPictureFilterExempt)).toEqual([
			false,
			false,
		]);
	});

	it("exempts one person and puts the filter back on for them", async () => {
		const exempted = await setManagedUserExplicitPictureFilterExempt(
			{ targetUserId: "target", exempt: true },
			executor,
		);
		expect(exempted.explicitPictureFilterExempt).toBe(true);
		expect(exemptColumn("target")).toBe(true);
		expect(exemptColumn("bystander")).toBe(false);

		const restored = await setManagedUserExplicitPictureFilterExempt(
			{ targetUserId: "target", exempt: false },
			executor,
		);
		expect(restored.explicitPictureFilterExempt).toBe(false);
		expect(exemptColumn("target")).toBe(false);
	});

	it("says so when the person does not exist", async () => {
		await expect(
			setManagedUserExplicitPictureFilterExempt(
				{ targetUserId: "nobody", exempt: true },
				executor,
			),
		).rejects.toThrow("User not found.");
	});
});
