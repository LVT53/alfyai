import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sqlite } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import { createSession, validateSession } from "./auth";

// A session ends on the server, not only in the browser. These run against the
// real sessions table (a migrated database per worker), because the bug was in
// what the column holds, which a mock of the database cannot show: the expiry
// was written in milliseconds into a column that is read back in seconds, so
// the check never fired and only the cookie's Max-Age ended a session.

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const REMEMBERED_DAYS = 14;

let userId: string;

beforeEach(async () => {
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: "not-a-real-hash",
	});
	// Only the clock is faked. The database calls are real and must not wait
	// on a fake timer.
	vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(async () => {
	vi.useRealTimers();
	// Its sessions go with it (the foreign key cascades).
	await db.delete(users).where(eq(users.id, userId));
});

function sessionRowsOfTheUser() {
	return db.select().from(sessions).where(eq(sessions.userId, userId));
}

describe("a session's expiry", () => {
	it("a session is refused once its expiry has passed", async () => {
		const { token } = await createSession(userId, { rememberMe: false });

		vi.setSystemTime(Date.now() + ONE_DAY_MS + 1000);

		expect(await validateSession(token)).toBeNull();
		// The refused session does not linger as a row.
		expect(await sessionRowsOfTheUser()).toHaveLength(0);
	});

	it("a session is valid one minute before its expiry", async () => {
		const issuedAt = Date.now();
		const { token } = await createSession(userId, { rememberMe: false });

		vi.setSystemTime(issuedAt + ONE_DAY_MS - 60_000);

		const user = await validateSession(token);
		expect(user?.id).toBe(userId);
		expect(await sessionRowsOfTheUser()).toHaveLength(1);
	});

	it("a remembered session lasts 14 days, and not a day more", async () => {
		const issuedAt = Date.now();
		const { token } = await createSession(userId, { rememberMe: true });

		vi.setSystemTime(issuedAt + (REMEMBERED_DAYS - 1) * ONE_DAY_MS);
		expect((await validateSession(token))?.id).toBe(userId);

		vi.setSystemTime(issuedAt + REMEMBERED_DAYS * ONE_DAY_MS + 1000);
		expect(await validateSession(token)).toBeNull();
	});

	it("hands back the expiry as a Date, and stores it in seconds", async () => {
		const issuedAt = Date.now();
		const { expiresAt } = await createSession(userId, { rememberMe: false });

		expect(expiresAt).toBeInstanceOf(Date);
		expect(expiresAt.getTime()).toBeGreaterThanOrEqual(issuedAt + ONE_DAY_MS);
		expect(expiresAt.getTime()).toBeLessThanOrEqual(
			Date.now() + ONE_DAY_MS + 10,
		);

		// What the column itself holds, read around Drizzle's Date mapping: a
		// ten-digit unix time, never the thirteen-digit millisecond count the
		// raw SQL write used to put there.
		const stored = sqlite
			.prepare("SELECT expires_at AS value FROM sessions WHERE user_id = ?")
			.get(userId) as { value: number };
		expect(stored.value).toBe(Math.floor(expiresAt.getTime() / 1000));
	});
});
