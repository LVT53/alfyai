import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, sqlite } from "$lib/server/db";
import { createQueryExecutor } from "$lib/server/db/query-executor";
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

// The revokes run through the executor they are handed (ADR-0059); these use the
// app's own connection, as the admin's pane does.
const executor = createQueryExecutor(db);

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

		const signedOut = await revokeOtherSessions(
			userId,
			current.token,
			executor,
		);

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

		await revokeOtherSessions(userId, current.token, executor);

		expect(await sessionIdsOf(otherUserId)).toEqual([
			hashSessionToken(strangers.token),
		]);
		expect((await validateSession(strangers.token))?.id).toBe(otherUserId);
	});

	it("says 0 when there is nothing else to sign out", async () => {
		const current = await createSession(userId);

		expect(await revokeOtherSessions(userId, current.token, executor)).toBe(0);
		expect(await sessionIdsOf(userId)).toHaveLength(1);
	});

	it("signs out every session when there is no current one to keep", async () => {
		await createSession(userId);
		await createSession(userId);

		expect(await revokeOtherSessions(userId, null, executor)).toBe(2);
		expect(await sessionIdsOf(userId)).toHaveLength(0);
	});

	it("takes the token to keep, not the stored id: the hash keeps nothing", async () => {
		const current = await createSession(userId);
		await createSession(userId);

		// What a copy of the database holds is not what the cookie holds.
		const storedId = hashSessionToken(current.token);
		expect(await revokeOtherSessions(userId, storedId, executor)).toBe(2);
		expect(await sessionIdsOf(userId)).toHaveLength(0);
	});
});

// The count goes back to the Profile card, which tells the person "you were
// signed out on your other devices". A row that was already dead is no device:
// an expired one, or one of the rows the release before the hashing one wrote
// while a deploy ran (the raw token as its id, a millisecond count in the
// seconds column, which reads back as a date tens of thousands of years away
// and which no lookup can match). Every one of them is still deleted.
describe("what a revoke counts", () => {
	const ONE_DAY_MS = 24 * 60 * 60 * 1000;

	async function addDeadRows() {
		await db.insert(sessions).values({
			id: "ended-yesterday",
			userId,
			expiresAt: new Date(Date.now() - ONE_DAY_MS),
		});
		sqlite
			.prepare(
				"INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
			)
			.run(
				"raw-token-from-the-old-release",
				userId,
				Date.now() + 14 * ONE_DAY_MS,
			);
	}

	it("counts the sessions that were live and no row that had already ended", async () => {
		const current = await createSession(userId);
		const phone = await createSession(userId);
		await addDeadRows();

		const signedOut = await revokeOtherSessions(
			userId,
			current.token,
			executor,
		);

		expect(signedOut).toBe(1);
		expect(await validateSession(phone.token)).toBeNull();
		// Still deleted: the dead rows go with the live ones.
		expect(await sessionIdsOf(userId)).toEqual([
			hashSessionToken(current.token),
		]);
	});

	it("says 0 when every other row was already dead, and still deletes them", async () => {
		const current = await createSession(userId);
		await addDeadRows();

		expect(await revokeOtherSessions(userId, current.token, executor)).toBe(0);
		expect(await sessionIdsOf(userId)).toEqual([
			hashSessionToken(current.token),
		]);
	});

	it("counts a session that is about to end, but has not, as live", async () => {
		const current = await createSession(userId);
		const soon = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5_000);
		await db
			.insert(sessions)
			.values({ id: "ends-in-a-moment", userId, expiresAt: soon });

		expect(await revokeOtherSessions(userId, current.token, executor)).toBe(1);
	});

	it("counts the same way when everything is revoked", async () => {
		await createSession(userId);
		await addDeadRows();

		expect(await revokeAllSessions(userId, executor)).toBe(1);
		expect(await sessionIdsOf(userId)).toHaveLength(0);
	});
});

describe("revokeAllSessions", () => {
	it("signs a person out everywhere and says how many sessions ended", async () => {
		const first = await createSession(userId);
		const second = await createSession(userId);
		const strangers = await createSession(otherUserId);

		const signedOut = await revokeAllSessions(userId, executor);

		expect(signedOut).toBe(2);
		expect(await validateSession(first.token)).toBeNull();
		expect(await validateSession(second.token)).toBeNull();
		expect((await validateSession(strangers.token))?.id).toBe(otherUserId);
	});

	it("says 0 for a person with no session", async () => {
		expect(await revokeAllSessions(userId, executor)).toBe(0);
	});
});
