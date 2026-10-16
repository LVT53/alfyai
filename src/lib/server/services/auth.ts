import * as crypto from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import * as bcrypt from "bcryptjs";
import { and, eq, gt, lt, ne, or } from "drizzle-orm";
import type { SessionUser } from "$lib/server/services/auth-types";
import {
	isSameEmailAddress,
	normalizeEmailAddress,
} from "$lib/shared/email-address";
import { type DatabaseInstance, db } from "../db/index";
import { type QueryExecutor, queryExecutor } from "../db/query-executor";
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
/** bcrypt's cost for a stored password (the sign-in's decoy hash uses the same number). */
const PASSWORD_HASH_COST = 12;

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
 * for it again: the password change, the email change, the data archive, clear
 * memory, clear workspace and delete account. Every one of them goes through
 * here, so they share one budget of wrong answers.
 *
 * The same bcrypt comparison the sign-in uses, run through the same limiter
 * (`login-rate-limit.ts`): the lockout state is checked before comparing, a
 * wrong answer is recorded, and a right one clears the count. The count lives
 * in the limiter's `account:` namespace, on purpose: a fumbled password here
 * must not slow the person's sign-in down, and the sign-in's count (keyed on the
 * email) is not this one. These endpoints are already behind a session, so the
 * threat is a hijacked session guessing the password to change the email or to
 * take the data, not an anonymous guesser.
 *
 * A right password is still accepted while a penalty applies, as at sign-in:
 * the limiter slows a guesser down, it never locks the owner out.
 *
 * `database` is the connection the account is read from; a service that runs
 * on an injected one (the data archive) hands it over.
 */
export async function checkCurrentPassword(
	userId: string,
	password: string,
	database: DatabaseInstance = db,
): Promise<CurrentPasswordCheck> {
	const rateLimitKeys = { accountId: userId };

	const guarded = await guardCredentialCheck(rateLimitKeys, async () => {
		const [found] = await database
			.select()
			.from(users)
			.where(eq(users.id, userId));
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

/** What a person asks to change about themselves on the Profile card. */
export type ProfileUpdateInput = {
	/** A new display name; blank clears it. Asks for nothing. */
	name?: string;
	/**
	 * A new address. It is what signs the person in, so it asks for
	 * `currentPassword` when it is not the address already held (the same
	 * address in other letters is not a change).
	 */
	email?: string;
	currentPassword?: string;
};

/** How a Profile card change came out. */
export type ProfileUpdateResult =
	| { status: "updated"; name: string | null; email: string }
	| { status: "not_found" }
	/** The address differs and no password came with it. */
	| { status: "password_required" }
	/** The password check did not pass: wrong, or over the limiter's budget. */
	| {
			status: "password_refused";
			check: Exclude<CurrentPasswordCheck, { outcome: "ok" }>;
	  }
	| { status: "email_taken" };

/**
 * Changes the name and/or the email of the signed-in account, or says why not.
 * Nothing in the request is applied unless all of it is allowed.
 *
 * An email change asks for the account password (`checkCurrentPassword`: the
 * sign-in's comparison and limiter, so a stolen session alone cannot take over
 * the address), and the password is checked BEFORE the answer to "is this
 * address taken", so a session without it cannot learn which addresses have
 * accounts. The card sends the email along with a rename, so an address that
 * only differs in letters or spaces is not a change and needs no password.
 */
export async function updateOwnProfile(
	userId: string,
	input: ProfileUpdateInput,
): Promise<ProfileUpdateResult> {
	const updates: { updatedAt: Date; name?: string | null; email?: string } = {
		updatedAt: new Date(),
	};

	if (input.name !== undefined) {
		updates.name = input.name.trim() || null;
	}

	if (input.email !== undefined) {
		const email = normalizeEmailAddress(input.email);

		const [current] = await db
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, userId));
		if (!current) return { status: "not_found" };

		// The Profile card reads "is this a change" with the same function.
		if (!isSameEmailAddress(email, current.email)) {
			if (!input.currentPassword) return { status: "password_required" };

			const check = await checkCurrentPassword(userId, input.currentPassword);
			if (check.outcome !== "ok") return { status: "password_refused", check };

			const existing = await db
				.select({ id: users.id })
				.from(users)
				.where(and(eq(users.email, email), ne(users.id, userId)));
			if (existing.length > 0) return { status: "email_taken" };

			updates.email = email;
		}
	}

	await db.update(users).set(updates).where(eq(users.id, userId));

	const [updated] = await db
		.select({ name: users.name, email: users.email })
		.from(users)
		.where(eq(users.id, userId));
	if (!updated) return { status: "not_found" };
	return { status: "updated", name: updated.name, email: updated.email };
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
 * The latest moment a session this app wrote can end at, as of `now`: the
 * longest session it creates plus a day. Nothing the app writes ends later.
 * What does is a row the release before the one that hashes tokens wrote after
 * `db:prepare` had run, while it still served (about two minutes of a deploy):
 * the raw token as its id, and a millisecond count in the seconds column, which
 * reads back as a date tens of thousands of years away. No lookup can match
 * such a row, so it is no session at all.
 */
function latestPlausibleExpiry(now: Date): Date {
	return new Date(
		now.getTime() + REMEMBERED_SESSION_DURATION_MS + FAR_FUTURE_GRACE_MS,
	);
}

/**
 * Which rows of a person a revoke deletes: all of them, bar the session behind
 * `keepToken`. The token, not the stored id, hashed here like every other
 * lookup. With no token to keep (`null`) nothing is spared, which is the safe
 * reading of a request that carries no session of its own.
 */
function sessionsToRevoke(userId: string, keepToken: string | null) {
	const ofThePerson = eq(sessions.userId, userId);
	return keepToken === null
		? ofThePerson
		: and(ofThePerson, ne(sessions.id, hashSessionToken(keepToken)));
}

/**
 * How many of the rows a revoke deleted were sessions someone could still have
 * been using: they had not ended (as `validateSession` reads it) and were not
 * one of the stray rows a deploy leaves (see `latestPlausibleExpiry`). The
 * Profile card tells the person "you were signed out on your other devices"
 * while this is above zero, and a row that was already dead was no device.
 * Every row is deleted all the same; this only decides which ones are counted.
 */
function countLiveSessions(
	removed: ReadonlyArray<{ expiresAt: Date }>,
	now: Date,
): number {
	const latest = latestPlausibleExpiry(now).getTime();
	return removed.filter(({ expiresAt }) => {
		const endsAt = expiresAt.getTime();
		return endsAt >= now.getTime() && endsAt <= latest;
	}).length;
}

/**
 * Signs a person out of every device but one, and says how many sessions were
 * live when they ended (rows that had already expired go too, uncounted).
 *
 * `keepToken` is the session cookie of the device that is acting (the one that
 * just changed the password).
 *
 * The delete runs through `executor.run` (ADR-0059), so the seam times it and
 * counts its failures like any query a migrated service makes. A service that
 * runs on an executor of its own (user-admin) hands it over; the default is the
 * app's.
 */
export async function revokeOtherSessions(
	userId: string,
	keepToken: string | null,
	executor: QueryExecutor = queryExecutor,
): Promise<number> {
	const removed = await executor.run("auth.revokeSessions", (database) =>
		database
			.delete(sessions)
			.where(sessionsToRevoke(userId, keepToken))
			.returning({ expiresAt: sessions.expiresAt }),
	);
	return countLiveSessions(removed, new Date());
}

/** Signs a person out everywhere, and says how many live sessions that ended. */
export async function revokeAllSessions(
	userId: string,
	executor: QueryExecutor = queryExecutor,
): Promise<number> {
	return revokeOtherSessions(userId, null, executor);
}

/**
 * Changes a person's password and signs them out of every other device, as ONE
 * transaction, and says how many devices that was (live sessions only, see
 * `countLiveSessions`).
 *
 * The password a stolen cookie or a forgotten phone was signed in with is gone,
 * so those sessions go with it; `keepToken` is the session cookie of the device
 * that is acting, which stays signed in. They are one write on purpose: with two
 * statements, a revoke that failed left the new password stored and the other
 * devices signed in, the route answered 500, and the person's retry with the old
 * password was refused as wrong. Here a failed revoke rolls the password back.
 *
 * The caller has already checked the current password (`checkCurrentPassword`).
 * The hash is made first: bcrypt is slow, and a transaction holds SQLite's write
 * lock from its first statement.
 */
export async function changePassword(
	userId: string,
	newPassword: string,
	keepToken: string | null,
	database: DatabaseInstance = db,
): Promise<{ signedOutOtherDevices: number }> {
	const passwordHash = await bcrypt.hash(newPassword, PASSWORD_HASH_COST);
	const now = new Date();

	const signedOutOtherDevices = database.transaction((tx) => {
		tx.update(users)
			.set({ passwordHash, updatedAt: now })
			.where(eq(users.id, userId))
			.run();
		const removed = tx
			.delete(sessions)
			.where(sessionsToRevoke(userId, keepToken))
			.returning({ expiresAt: sessions.expiresAt })
			.all();
		return countLiveSessions(removed, now);
	});

	return { signedOutOtherDevices };
}

/**
 * Housekeeping for the sessions table, run by memory maintenance. Deletes the
 * rows nothing will ever use, and says how many it deleted:
 *
 *  - Expired sessions. `validateSession` already refuses an expired one and
 *    deletes it when it is presented; this removes the ones nobody presents (a
 *    phone that never came back). Strictly before `now`, as `validateSession`
 *    reads it, so a session is never swept that it would still accept.
 *  - Rows that end further away than `latestPlausibleExpiry`: the stray rows
 *    the release before the one that hashes tokens can leave during a deploy.
 *    No lookup can match their id, so they are inert; this makes sure they do
 *    not stay forever.
 */
export async function sweepExpiredSessions(now: Date): Promise<number> {
	const result = await db
		.delete(sessions)
		.where(
			or(
				lt(sessions.expiresAt, now),
				gt(sessions.expiresAt, latestPlausibleExpiry(now)),
			),
		);
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
