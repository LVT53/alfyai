import * as crypto from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { and, eq, gt, lt, ne, or } from "drizzle-orm";
import type { SessionUser } from "$lib/server/services/auth-types";
import { type DatabaseInstance, db } from "../db/index";
import { sessions, users } from "../db/schema";
import {
	guardCredentialCheck,
	recordLoginFailure,
	recordLoginSuccess,
} from "./login-rate-limit";

const SHORT_SESSION_DURATION_MS = 24 * 60 * 60 * 1000;
const REMEMBERED_SESSION_DURATION_MS = 14 * 24 * 60 * 60 * 1000;
/** How far past the longest session a row may end before it is called what it is. */
const FAR_FUTURE_GRACE_MS = 24 * 60 * 60 * 1000;

export async function verifyPassword(
	plaintext: string,
	hash: string,
): Promise<boolean> {
	return bcrypt.compare(plaintext, hash);
}

/** How a check of the account password for a settings action came out. */
export type CurrentPasswordCheck =
	| { outcome: "ok" }
	| { outcome: "wrong" }
	| { outcome: "no_user" }
	/**
	 * Over the limiter's budget: the comparison did not run, or a wrong answer
	 * was given while a penalty applies. `retryAfterSeconds` is the wait.
	 */
	| { outcome: "throttled"; retryAfterSeconds: number };

/**
 * Checks the password of the signed-in account for a settings action that asks
 * for it again (changing the password, changing the email).
 *
 * The same bcrypt comparison the sign-in uses, run through the same limiter
 * (`login-rate-limit.ts`): the lockout state is checked before comparing, a
 * wrong answer is recorded, and a right one clears the count. The count lives
 * in the limiter's `account:` namespace, on purpose: a fumbled password here
 * must not slow the person's sign-in down, and the sign-in's count (keyed on the
 * email) is not this one. This endpoint is already behind a session, so the
 * threat is a hijacked session guessing the password to change it, not an
 * anonymous guesser.
 *
 * A right password is still accepted while a penalty applies, as at sign-in:
 * the limiter slows a guesser down, it never locks the owner out.
 */
export async function checkCurrentPassword(
	userId: string,
	password: string,
): Promise<CurrentPasswordCheck> {
	const rateLimitKeys = { accountId: userId };

	const guarded = await guardCredentialCheck(rateLimitKeys, async () => {
		const [found] = await db.select().from(users).where(eq(users.id, userId));
		if (!found) return { exists: false, valid: false };
		return {
			exists: true,
			valid: await verifyPassword(password, found.passwordHash),
		};
	});

	if (guarded.outcome === "refused") {
		return {
			outcome: "throttled",
			retryAfterSeconds: guarded.block.retryAfterSeconds,
		};
	}

	if (!guarded.value.exists) return { outcome: "no_user" };

	if (!guarded.value.valid) {
		recordLoginFailure(rateLimitKeys);
		// A wrong answer under a penalty is reported as the throttle it is.
		if (guarded.throttled) {
			return {
				outcome: "throttled",
				retryAfterSeconds: guarded.throttled.retryAfterSeconds,
			};
		}
		return { outcome: "wrong" };
	}

	recordLoginSuccess(rateLimitKeys);
	return { outcome: "ok" };
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

/**
 * Housekeeping for the sessions table, run by memory maintenance. Deletes the
 * rows nothing will ever use, and says how many it deleted:
 *
 *  - Expired sessions. `validateSession` already refuses an expired one and
 *    deletes it when it is presented; this removes the ones nobody presents (a
 *    phone that never came back). Strictly before `now`, as `validateSession`
 *    reads it, so a session is never swept that it would still accept.
 *  - Rows that end further away than the longest session the app creates plus a
 *    day. Nothing the app writes does that. What does is a row the release
 *    before the one that hashes tokens wrote after `db:prepare` had run, while
 *    it still served (about two minutes of a deploy): the raw token as its id,
 *    and a millisecond count in the seconds column, which reads back as a date
 *    tens of thousands of years away. No lookup can match its id, so it is
 *    inert; this makes sure it does not stay forever.
 */
export async function sweepExpiredSessions(now: Date): Promise<number> {
	const farFuture = new Date(
		now.getTime() + REMEMBERED_SESSION_DURATION_MS + FAR_FUTURE_GRACE_MS,
	);
	const result = await db
		.delete(sessions)
		.where(or(lt(sessions.expiresAt, now), gt(sessions.expiresAt, farFuture)));
	return result.changes;
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
