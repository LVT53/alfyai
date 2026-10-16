import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import {
	createSession,
	hashSessionToken,
	revokeAllSessions,
	revokeOtherSessions,
	validateSession,
} from "./auth";

// Signing a person out elsewhere. Real sessions table: what is being checked is
// which rows survive, and a mocked delete cannot say.

let userId: string;
let otherUserId: string;

async function makeUser(): Promise<string> {
	const id = randomUUID();
	await db.insert(users).values({
		id,
		email: `${id}@example.com`,
		passwordHash: "not-a-real-hash",
	});
	return id;
}

beforeEach(async () => {
	userId = await makeUser();
	otherUserId = await makeUser();
});

afterEach(async () => {
	// Their sessions go with them (the foreign key cascades).
	await db.delete(users).where(eq(users.id, userId));
	await db.delete(users).where(eq(users.id, otherUserId));
});

function sessionIdsOf(id: string) {
	return db
		.select({ id: sessions.id })
		.from(sessions)
		.where(eq(sessions.userId, id))
		.then((rows) => rows.map((row) => row.id));
}

describe("revokeOtherSessions", () => {
	it("keeps the current session and deletes the rest", async () => {
		const current = await createSession(userId);
		const phone = await createSession(userId);
		const laptop = await createSession(userId, { rememberMe: false });

		const signedOut = await revokeOtherSessions(userId, current.token);

		expect(signedOut).toBe(2);
		expect(await sessionIdsOf(userId)).toEqual([
			hashSessionToken(current.token),
		]);
		expect((await validateSession(current.token))?.id).toBe(userId);
		expect(await validateSession(phone.token)).toBeNull();
		expect(await validateSession(laptop.token)).toBeNull();
	});

	it("touches nobody else's sessions", async () => {
		const current = await createSession(userId);
		await createSession(userId);
		const strangers = await createSession(otherUserId);

		await revokeOtherSessions(userId, current.token);

		expect(await sessionIdsOf(otherUserId)).toEqual([
			hashSessionToken(strangers.token),
		]);
		expect((await validateSession(strangers.token))?.id).toBe(otherUserId);
	});

	it("says 0 when there is nothing else to sign out", async () => {
		const current = await createSession(userId);

		expect(await revokeOtherSessions(userId, current.token)).toBe(0);
		expect(await sessionIdsOf(userId)).toHaveLength(1);
	});

	it("signs out every session when there is no current one to keep", async () => {
		await createSession(userId);
		await createSession(userId);

		expect(await revokeOtherSessions(userId, null)).toBe(2);
		expect(await sessionIdsOf(userId)).toHaveLength(0);
	});

	it("takes the token to keep, not the stored id: the hash keeps nothing", async () => {
		const current = await createSession(userId);
		await createSession(userId);

		// What a copy of the database holds is not what the cookie holds.
		const storedId = hashSessionToken(current.token);
		expect(await revokeOtherSessions(userId, storedId)).toBe(2);
		expect(await sessionIdsOf(userId)).toHaveLength(0);
	});
});

describe("revokeAllSessions", () => {
	it("signs a person out everywhere and says how many sessions ended", async () => {
		const first = await createSession(userId);
		const second = await createSession(userId);
		const strangers = await createSession(otherUserId);

		const signedOut = await revokeAllSessions(userId);

		expect(signedOut).toBe(2);
		expect(await validateSession(first.token)).toBeNull();
		expect(await validateSession(second.token)).toBeNull();
		expect((await validateSession(strangers.token))?.id).toBe(otherUserId);
	});

	it("says 0 for a person with no session", async () => {
		expect(await revokeAllSessions(userId)).toBe(0);
	});
});
