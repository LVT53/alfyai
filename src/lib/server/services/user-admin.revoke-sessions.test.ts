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
import { hashSessionToken } from "./auth";

vi.mock("./privacy-controls", () => ({
	DETACHED_SHARED_CONTENT_OWNER_ID: "detached-shared-content-owner",
	eraseUserAccountAsAdmin: vi.fn(),
}));

const { listManagedUsers, revokeManagedUserSessions } = await import(
	"./user-admin"
);

// The admin's "revoke sessions" on a person, against the executor it is handed.
// `sessions.id` holds a hash now; the revoke goes by the person, so it keeps
// working whatever the ids are, and it must write to the connection it was
// given rather than to the app's own.

let memory: InMemoryDatabase;
let executor: QueryExecutor;

function addPerson(id: string) {
	memory.db
		.insert(schema.users)
		.values({
			id,
			email: `${id}@example.com`,
			passwordHash: "hash",
		})
		.run();
}

function addSession(token: string, userId: string) {
	memory.db
		.insert(schema.sessions)
		.values({
			id: hashSessionToken(token),
			userId,
			expiresAt: new Date(Date.now() + 3_600_000),
		})
		.run();
}

function sessionsOf(userId: string) {
	return memory.db
		.select()
		.from(schema.sessions)
		.where(eq(schema.sessions.userId, userId))
		.all();
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

describe("revokeManagedUserSessions", () => {
	it("signs the person out everywhere and leaves everybody else signed in", async () => {
		addSession("token-1", "target");
		addSession("token-2", "target");
		addSession("token-3", "bystander");

		await revokeManagedUserSessions("target", executor);

		expect(sessionsOf("target")).toHaveLength(0);
		expect(sessionsOf("bystander")).toHaveLength(1);
	});

	it("shows in the Users pane's session count", async () => {
		addSession("token-1", "target");
		addSession("token-2", "target");
		const sessionCountOfTarget = async () =>
			(await listManagedUsers(executor)).find((user) => user.id === "target")
				?.activeSessionCount;

		expect(await sessionCountOfTarget()).toBe(2);

		await revokeManagedUserSessions("target", executor);

		expect(await sessionCountOfTarget()).toBe(0);
	});

	it("refuses a person who does not exist, and signs nobody out", async () => {
		addSession("token-1", "bystander");

		await expect(revokeManagedUserSessions("nobody", executor)).rejects.toThrow(
			"User not found.",
		);

		expect(sessionsOf("bystander")).toHaveLength(1);
	});
});
