import * as crypto from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { and, eq, ne } from "drizzle-orm";
import type { SessionUser } from "$lib/server/services/auth-types";
import { type DatabaseInstance, db } from "../db/index";
import { sessions, users } from "../db/schema";

const SHORT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;

export async function verifyPassword(
	plaintext: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(plaintext, hash);
}

/**
 * What `sessions.id` holds for a session token: its SHA-256, as lowercase hex.
 *
 * The cookie holds the token and the database holds only this, so a copy of the
 * database (a backup, a stolen file) holds no session anyone can present.
 * Tokens are 32 random bytes, which is why a plain hash is enough: there is
 * nothing to guess and nothing to stretch.
 *
 * Every reader and writer of a session by its token goes through this, and
 * nothing else in the app turns a token into a row id. `createSession`,
 * `validateSession`, `deleteSession` and `revokeOtherSessions` hash inside, so
 * a caller hands over the token it has (the cookie's value) and never the
 * stored id.
 */
export function hashSessionToken(token: string): string {
	return crypto.createHash("sha256").update(token).digest("hex");
}

export async function createSession(
	userId: string,
	options: SessionCookieOptions = { rememberMe: true },
): Promise<{ token: string; expiresAt: Date }> {
	const token = crypto.randomBytes(32).toString("hex");
	const durationMs =
		options.rememberMe === false
			? SHORT_SESSION_DURATION_MS
			: REMEMBERED_SESSION_DURATION_MS;
	const expiresAt = new Date(Date.now() + durationMs);

	// A Date, so Drizzle writes the column in the unit it reads it back in
	// (seconds: `integer` in `timestamp` mode). A raw millisecond count here
	// used to read back as a date tens of thousands of years away, so the check
	// in `validateSession` never fired and only the cookie's Max-Age ended a
	// session.
	await db.insert(sessions).values({
		id: hashSessionToken(token),
		userId: userId,
		expiresAt,
	});

	// The raw token goes back to the caller for the cookie and is never stored.
	return { token, expiresAt };
}

/**
 * The person behind a session cookie, or null.
 *
 * A cookie from before the release that started hashing finds no row (its
 * raw value is not any row's id), so it is "signed out" like any unknown
 * cookie: null, not a throw, and the request gate sends the person to sign in.
 */
export async function validateSession(
	token: string,
): Promise<SessionUser | null> {
	const sessionId = hashSessionToken(token);
	const sessionResult = await db
		.select()
		.from(sessions)
		.innerJoin(users, eq(sessions.userId, users.id))
		.where(eq(sessions.id, sessionId));

	const [session] = sessionResult;
	if (!session) {
		return null;
	}

	const { sessions: sessionObj, users: userObj } = session;

	if (sessionObj.expiresAt.getTime() < Date.now()) {
		await db.delete(sessions).where(eq(sessions.id, sessionId));
		return null;
	}

	return {
		id: userObj.id,
		email: userObj.email,
		displayName: userObj.name ?? userObj.email,
		role: (userObj.role ??
			"user") as import("$lib/server/services/auth-types").UserRole,
		profilePicture: userObj.profilePicture ?? null,
		titleLanguage: (userObj.titleLanguage ?? "auto") as "auto" | "en" | "hu",
		uiLanguage: (userObj.uiLanguage ?? "en") as "en" | "hu",
	};
}

/** Ends the session behind a cookie's token (sign out). Hashes before it looks up. */
export async function deleteSession(token: string): Promise<void> {
	await db.delete(sessions).where(eq(sessions.id, hashSessionToken(token)));
}

/**
 * Signs a person out of every device but one, and says how many sessions ended.
 *
 * `keepToken` is the session cookie of the device that is acting (the one that
 * just changed the password): the token, not the stored id, hashed here like
 * every other lookup. With no token to keep (`null`) nothing is spared, which
 * is the safe reading of a request that carries no session of its own.
 *
 * `database` is the connection the delete runs on; a service that runs on a
 * `QueryExecutor` (user-admin) hands over the executor's, so the seam it was
 * given is the one that is written to.
 */
export async function revokeOtherSessions(
	userId: string,
	keepToken: string | null,
	database: DatabaseInstance = db,
): Promise<number> {
	const ofThePerson = eq(sessions.userId, userId);
	const result = await database
		.delete(sessions)
		.where(
			keepToken === null
				? ofThePerson
				: and(ofThePerson, ne(sessions.id, hashSessionToken(keepToken))),
		);
	return result.changes;
}

/** Signs a person out everywhere, and says how many sessions ended. */
export async function revokeAllSessions(
	userId: string,
	database: DatabaseInstance = db,
): Promise<number> {
	return revokeOtherSessions(userId, null, database);
}

type SessionCookieOptions = {
	rememberMe?: boolean;
};

export function setSessionCookie(
	cookies: Pick<Cookies, "set">,
	token: string,
	expiresAt: Date,
	_options: SessionCookieOptions = { rememberMe: true },
): void {
	const maxAge = Math.floor((expiresAt.getTime() - Date.now()) / 1000);

	const cookieOptions: Parameters<Cookies["set"]>[2] = {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "lax",
		path: "/",
	};

	cookieOptions.maxAge = maxAge;

	cookies.set("session", token, cookieOptions);
}

export function clearSessionCookie(cookies: Pick<Cookies, "delete">): void {
	cookies.delete("session", {
		path: "/",
	});
}
