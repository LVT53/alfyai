import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db, sqlite } from "$lib/server/db";
import { sessions, users } from "$lib/server/db/schema";
import {
	createSession,
	deleteSession,
	hashSessionToken,
	validateSession,
} from "./auth";

// The database holds sha256(token); only the cookie holds the token. A copy of
// the database (a backup, a stolen file) then holds no session anyone can
// present. Real sessions table, real hashing: a mock of either would let the
// token be stored unhashed and still pass. The expected hash is computed here
// with node:crypto, not by the function under test.

const sha256Hex = (value: string) =>
	createHash("sha256").update(value).digest("hex");

let userId: string;

beforeEach(async () => {
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: "not-a-real-hash",
	});
});

afterEach(async () => {
	// Its sessions go with it (the foreign key cascades).
	await db.delete(users).where(eq(users.id, userId));
});

function sessionRowsOfTheUser() {
	return db.select().from(sessions).where(eq(sessions.userId, userId));
}

/**
 * A row as the release before this one wrote it, which is what a deploy
 * leaves behind for a couple of minutes: the raw token as the id, and the
 * expiry as a millisecond count in the column that is read as seconds.
 */
function insertRowTheOldReleaseWrote(rawToken: string, expiryMs: number) {
	sqlite
		.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
		.run(rawToken, userId, expiryMs);
}

describe("hashSessionToken", () => {
	it("is the plain SHA-256 of the token, as lowercase hex", () => {
		const token = randomBytes(32).toString("hex");

		expect(hashSessionToken(token)).toBe(sha256Hex(token));
		expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("gives different tokens different hashes", () => {
		expect(hashSessionToken("a")).not.toBe(hashSessionToken("b"));
	});
});

describe("session tokens are stored as hashes", () => {
	it("the stored session id is the token's SHA-256, never the token", async () => {
		const { token } = await createSession(userId);

		const rows = await sessionRowsOfTheUser();
		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(sha256Hex(token));
		expect(rows[0].id).not.toBe(token);
	});

	it("the token still finds its session", async () => {
		const { token } = await createSession(userId);

		const user = await validateSession(token);

		expect(user?.id).toBe(userId);
	});

	it("the stored hash used as a cookie value finds no session", async () => {
		await createSession(userId);
		const [row] = await sessionRowsOfTheUser();

		// What someone holding a copy of the database could present.
		expect(await validateSession(row.id)).toBeNull();
		// And presenting it does not disturb the real session.
		expect(await sessionRowsOfTheUser()).toHaveLength(1);
	});

	it("logout deletes by the token, and the stored hash deletes nothing", async () => {
		const { token } = await createSession(userId);
		const [row] = await sessionRowsOfTheUser();

		await deleteSession(row.id);
		expect(await sessionRowsOfTheUser()).toHaveLength(1);

		await deleteSession(token);
		expect(await sessionRowsOfTheUser()).toHaveLength(0);
		expect(await validateSession(token)).toBeNull();
	});
});

describe("a session cookie from before the deploy", () => {
	it("a pre-deploy raw-token cookie is treated as signed out", async () => {
		const rawToken = randomBytes(32).toString("hex");
		insertRowTheOldReleaseWrote(
			rawToken,
			Date.now() + 14 * 24 * 60 * 60 * 1000,
		);

		// No row has the hash of that token as its id, so it finds nothing. It
		// is a null, not a throw: the person is sent to sign in, never a 500.
		await expect(validateSession(rawToken)).resolves.toBeNull();
	});

	it("the old release's row stays out of the way of a real session of the same person", async () => {
		const rawToken = randomBytes(32).toString("hex");
		insertRowTheOldReleaseWrote(
			rawToken,
			Date.now() + 14 * 24 * 60 * 60 * 1000,
		);

		const { token } = await createSession(userId);

		expect((await validateSession(token))?.id).toBe(userId);
		await expect(validateSession(rawToken)).resolves.toBeNull();
	});
});
