import { createHash, randomBytes } from "node:crypto";
import type { Cookies } from "@sveltejs/kit";
import { eq, sql } from "drizzle-orm";
import { db } from "$lib/server/db";
import { signInChallenges, users } from "$lib/server/db/schema";
import type { SecondFactorInput } from "./store";
import { isTwoStepEnabled, verifySecondFactor } from "./store";

/**
 * The five-minute, single-use attempt a correct password opens when the
 * account has a confirmed second factor. Only consuming it creates a session.
 *
 * The cookie carries a 32-byte token; the row's id is its SHA-256, so the
 * database holds nothing that could be presented as the cookie. The attempt
 * remembers the password step's "remember me" choice, so the session the
 * second step creates has the length the person asked for.
 */

export const SIGN_IN_ATTEMPT_COOKIE = "signin_attempt";
export const MAX_TRIES = 5;
export const ATTEMPT_TTL_MS = 300_000;

/** The row id for an attempt token: SHA-256 hex, as `sessions.id` does for sessions. */
export function hashSignInAttemptToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export type SignInChallenge = {
	token: string;
	expiresAt: Date;
};

/** Opens an attempt after the password step proved the password. */
export async function createSignInChallenge(
	userId: string,
	rememberMe: boolean,
	now: Date,
): Promise<SignInChallenge> {
	const token = randomBytes(32).toString("hex");
	const expiresAt = new Date(now.getTime() + ATTEMPT_TTL_MS);

	await db.insert(signInChallenges).values({
		id: hashSignInAttemptToken(token),
		userId,
		rememberMe,
		attempts: 0,
		expiresAt,
		createdAt: now,
	});

	return { token, expiresAt };
}

/**
 * The cookie the code step reads. `path: "/api/auth"` keeps it off every other
 * request; `sameSite: "strict"` keeps another site from presenting it; it is
 * httpOnly because page script has no reason to see it, and `secure` wherever
 * the app runs in production.
 */
export function setSignInAttemptCookie(
	cookies: Pick<Cookies, "set">,
	token: string,
): void {
	cookies.set(SIGN_IN_ATTEMPT_COOKIE, token, {
		httpOnly: true,
		secure: process.env.NODE_ENV === "production",
		sameSite: "strict",
		path: "/api/auth",
		maxAge: ATTEMPT_TTL_MS / 1000,
	});
}

export function clearSignInAttemptCookie(
	cookies: Pick<Cookies, "delete">,
): void {
	cookies.delete(SIGN_IN_ATTEMPT_COOKIE, { path: "/api/auth" });
}

/**
 * The account an attempt belongs to, for the rate limiter's keys. The attempt
 * may be expired or already gone; the caller's consume call answers that.
 * Null when the token matches no row.
 */
export async function findSignInChallengeAccount(
	token: string,
): Promise<{ userId: string; email: string } | null> {
	const [row] = await db
		.select({ userId: signInChallenges.userId, email: users.email })
		.from(signInChallenges)
		.innerJoin(users, eq(signInChallenges.userId, users.id))
		.where(eq(signInChallenges.id, hashSignInAttemptToken(token)))
		.limit(1);
	return row ?? null;
}

export type SignInChallengeResult =
	| {
			ok: true;
			userId: string;
			rememberMe: boolean;
			usedBackupCode: boolean;
			backupCodesLeft: number;
	  }
	| { ok: false; reason: "wrong_code"; triesLeft: number }
	| {
			ok: false;
			reason: "restart";
			why: "expired" | "too_many" | "missing";
	  }
	| { ok: false; reason: "unreadable_secret" };

/**
 * Checks a code against the attempt's account and, when it works, spends the
 * attempt (the caller creates the session). Every refusal is a value, never a
 * throw.
 *
 * The four refusals the screen must tell apart:
 *  - a wrong code, with the tries left (the fifth ends the attempt);
 *  - an attempt that is over (expired, out of tries, or missing) → start again;
 *  - a factor whose secret no longer decrypts (a changed SESSION_SECRET) →
 *    "contact your admin", never a 500.
 *
 * A wrong code that loses the replay guard (two requests with the same valid
 * code) is a wrong code here, not a 500: exactly one of them creates a session.
 */
export async function consumeSignInChallenge(
	token: string,
	input: SecondFactorInput,
	now: Date,
): Promise<SignInChallengeResult> {
	const id = hashSignInAttemptToken(token);
	const [challenge] = await db
		.select()
		.from(signInChallenges)
		.where(eq(signInChallenges.id, id))
		.limit(1);

	if (!challenge) return restart("missing");

	if (challenge.expiresAt.getTime() < now.getTime()) {
		await db.delete(signInChallenges).where(eq(signInChallenges.id, id));
		return restart("expired");
	}

	// A reset in the meantime deletes the factor (and the attempt); this also
	// covers a factor that was never confirmed, so an account cannot be asked
	// for a code it does not have.
	if (!(await isTwoStepEnabled(challenge.userId))) {
		await db.delete(signInChallenges).where(eq(signInChallenges.id, id));
		return restart("missing");
	}

	const verified = await verifySecondFactor(challenge.userId, input, now);
	if (verified.ok) {
		await db.delete(signInChallenges).where(eq(signInChallenges.id, id));
		return {
			ok: true,
			userId: challenge.userId,
			rememberMe: challenge.rememberMe,
			usedBackupCode: verified.usedBackupCode,
			backupCodesLeft: verified.backupCodesLeft,
		};
	}

	if (verified.reason === "unreadable_secret") {
		return { ok: false, reason: "unreadable_secret" };
	}
	if (verified.reason === "not_enabled") {
		await db.delete(signInChallenges).where(eq(signInChallenges.id, id));
		return restart("missing");
	}

	const [bumped] = await db
		.update(signInChallenges)
		.set({ attempts: sql`${signInChallenges.attempts} + 1` })
		.where(eq(signInChallenges.id, id))
		.returning({ attempts: signInChallenges.attempts });
	const attempts = bumped?.attempts ?? challenge.attempts + 1;

	if (attempts >= MAX_TRIES) {
		await db.delete(signInChallenges).where(eq(signInChallenges.id, id));
		console.info("[AUTH] two-step attempt ran out of tries", {
			userId: challenge.userId,
		});
		return restart("too_many");
	}

	return { ok: false, reason: "wrong_code", triesLeft: MAX_TRIES - attempts };
}

function restart(
	why: Extract<SignInChallengeResult, { reason: "restart" }>["why"],
): SignInChallengeResult {
	return { ok: false, reason: "restart", why };
}
