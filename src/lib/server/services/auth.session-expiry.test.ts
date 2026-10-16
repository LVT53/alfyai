import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, sqlite } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import { createSession, sweepExpiredSessions, validateSession } from "./auth";

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

/** A row for the person that ends at `endsAt`, written the way the app now writes one. */
function insertSessionEnding(id: string, endsAt: Date) {
	return db.insert(sessions).values({ id, userId, expiresAt: endsAt });
}

/**
 * A row as the release before the hashing one wrote it, and the deploy leaves
 * a few of: the raw token as the id, a millisecond count where seconds belong.
 * Read back through Drizzle it is a date tens of thousands of years away.
 */
function insertRowTheOldReleaseWrote(id: string, expiryMs: number) {
	sqlite
		.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
		.run(id, userId, expiryMs);
}

async function idsOfTheUsersSessions() {
	return (await sessionRowsOfTheUser()).map((row) => row.id).sort();
}

describe("sweepExpiredSessions", () => {
	it("the sweep deletes expired sessions only", async () => {
		const now = new Date();
		const live = await createSession(userId);
		const shortLived = await createSession(userId, { rememberMe: false });
		await insertSessionEnding(
			"ended-a-second-ago",
			new Date(now.getTime() - 1000),
		);
		await insertSessionEnding(
			"ended-last-month",
			new Date(now.getTime() - 30 * ONE_DAY_MS),
		);

		const deleted = await sweepExpiredSessions(now);

		expect(deleted).toBe(2);
		expect(await idsOfTheUsersSessions()).toHaveLength(2);
		expect((await validateSession(live.token))?.id).toBe(userId);
		expect((await validateSession(shortLived.token))?.id).toBe(userId);
	});

	// The column holds whole seconds and the sweep compares in them, so it does
	// not delete a row until the second after the one it ends in. That is never
	// ahead of validateSession (which compares in milliseconds and may refuse the
	// same row a moment sooner): the sweep never removes what would still be
	// accepted.
	it("keeps a session whose expiry second is the current second", async () => {
		const now = new Date();
		// Whole seconds are what the column holds, so "now" and the expiry share one.
		const sameSecond = new Date(Math.floor(now.getTime() / 1000) * 1000);
		await insertSessionEnding("ends-now", sameSecond);

		expect(await sweepExpiredSessions(now)).toBe(0);
		expect(await idsOfTheUsersSessions()).toEqual(["ends-now"]);
	});

	it("says 0 when there is nothing to sweep", async () => {
		await createSession(userId);

		expect(await sweepExpiredSessions(new Date())).toBe(0);
	});

	it("sweeps other people's expired sessions too, and keeps their live ones", async () => {
		const now = new Date();
		const strangerId = randomUUID();
		await db.insert(users).values({
			id: strangerId,
			email: `${strangerId}@example.com`,
			passwordHash: "not-a-real-hash",
		});
		try {
			const strangers = await createSession(strangerId);
			await db.insert(sessions).values({
				id: "strangers-old",
				userId: strangerId,
				expiresAt: new Date(now.getTime() - ONE_DAY_MS),
			});

			expect(await sweepExpiredSessions(now)).toBe(1);

			expect((await validateSession(strangers.token))?.id).toBe(strangerId);
		} finally {
			await db.delete(users).where(eq(users.id, strangerId));
		}
	});
});

// `db:prepare` runs the migration while the release before this one is still
// serving, for about two minutes. Anyone who signs in then gets a row of the
// old shape: the raw token as the id and milliseconds in the seconds column,
// which reads back as a date tens of thousands of years away. No lookup can
// match it, so it is inert, but it must not live forever.
describe("sweepExpiredSessions and the rows the previous release writes during a deploy", () => {
	it("deletes a row whose expiry is a millisecond count read as seconds", async () => {
		const now = new Date();
		const fourteenDaysLater = now.getTime() + REMEMBERED_DAYS * ONE_DAY_MS;
		insertRowTheOldReleaseWrote(
			"raw-token-from-the-old-release",
			fourteenDaysLater,
		);
		const live = await createSession(userId);

		const deleted = await sweepExpiredSessions(now);

		expect(deleted).toBe(1);
		expect(await idsOfTheUsersSessions()).not.toContain(
			"raw-token-from-the-old-release",
		);
		expect((await validateSession(live.token))?.id).toBe(userId);
	});

	it("keeps a session up to the longest one the app creates plus a day, and not past it", async () => {
		const now = new Date();
		const longest = REMEMBERED_DAYS * ONE_DAY_MS;
		// A fresh remembered session, and one a minute inside the limit: both live.
		await insertSessionEnding(
			"just-created",
			new Date(now.getTime() + longest),
		);
		await insertSessionEnding(
			"inside-the-limit",
			new Date(now.getTime() + longest + ONE_DAY_MS - 60_000),
		);
		// A minute past it: nothing the app creates ends that far away.
		await insertSessionEnding(
			"past-the-limit",
			new Date(now.getTime() + longest + ONE_DAY_MS + 60_000),
		);

		const deleted = await sweepExpiredSessions(now);

		expect(deleted).toBe(1);
		expect(await idsOfTheUsersSessions()).toEqual([
			"inside-the-limit",
			"just-created",
		]);
	});

	it("is harmless until it is swept: no lookup can match such a row, and nothing throws", async () => {
		const rawToken = "c".repeat(64);
		insertRowTheOldReleaseWrote(
			rawToken,
			Date.now() + REMEMBERED_DAYS * ONE_DAY_MS,
		);

		await expect(validateSession(rawToken)).resolves.toBeNull();
		// Looking it up did not disturb it either: only the sweep removes it.
		expect(await idsOfTheUsersSessions()).toEqual([rawToken]);
	});
});
