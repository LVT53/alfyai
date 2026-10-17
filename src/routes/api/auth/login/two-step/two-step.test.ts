import { randomUUID } from "node:crypto";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "$lib/server/db";
import {
	sessions,
	signInChallenges,
	userSecondFactors,
	users,
} from "$lib/server/db/schema";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	checkLoginRateLimit,
	LOGIN_RATE_LIMIT_POLICY,
} from "$lib/server/services/login-rate-limit";
import {
	beginTwoStepSetup,
	confirmTwoStepSetup,
	createSignInChallenge,
	SIGN_IN_ATTEMPT_COOKIE,
} from "$lib/server/services/two-step";
import { POST as loginPOST } from "../+server";
import { POST } from "./+server";

type Event = Parameters<typeof POST>[0];
type LoginEvent = Parameters<typeof loginPOST>[0];
const STEP_MS = 30_000;
const CLIENT_ADDRESS = "203.0.113.10";
const userIds: string[] = [];

type CookieJar = {
	values: Map<string, string>;
	set: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	shown: ReturnType<typeof vi.fn>;
};

function makeCookies(...tokens: string[]): CookieJar {
	const values = new Map<string, string>();
	if (tokens[0]) values.set(SIGN_IN_ATTEMPT_COOKIE, tokens[0]);
	const shown = vi.fn((name: string) => values.get(name));
	const set = vi.fn((name: string, value: string) => {
		values.set(name, value);
	});
	const del = vi.fn((name: string) => {
		values.delete(name);
	});
	return {
		values,
		set,
		delete: del,
		shown,
	};
}

function makeEvent(cookies: CookieJar, body: unknown): Event {
	return {
		request: new Request("http://localhost/api/auth/login/two-step", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		cookies: {
			get: cookies.shown,
			set: cookies.set,
			delete: cookies.delete,
		},
		getClientAddress: () => CLIENT_ADDRESS,
	} as unknown as Event;
}

/** The password step of the REAL login route, sharing the attempt cookie jar. */
function makeLoginEvent(cookies: CookieJar, body: unknown): LoginEvent {
	return {
		request: new Request("http://localhost/api/auth/login", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		cookies: { set: cookies.set },
		getClientAddress: () => CLIENT_ADDRESS,
	} as unknown as LoginEvent;
}

async function createUser(
	passwordHash = "hash",
): Promise<{ userId: string; email: string }> {
	const userId = randomUUID();
	const email = `${userId}@example.com`;
	userIds.push(userId);
	await db.insert(users).values({ id: userId, email, passwordHash });
	return { userId, email };
}

function totpAt(secret: Uint8Array, at: Date): string {
	return generateHOTP(secret, BigInt(Math.floor(at.getTime() / STEP_MS)), 6);
}

/**
 * Turns the factor on two steps in the past, so the test's sign-in code for
 * "now" is above the step confirm recorded and the replay guard accepts it.
 */
async function enableTwoStep(userId: string, email: string) {
	const issued = new Date(Date.now() - 2 * STEP_MS);
	const started = await beginTwoStepSetup(userId, email);
	if (!started.ok) throw new Error("setup refused");
	const secret = decodeBase32IgnorePadding(started.key.replaceAll(" ", ""));
	const confirmed = await confirmTwoStepSetup(
		userId,
		totpAt(secret, issued),
		issued,
		null,
	);
	if (!confirmed.ok) throw new Error("confirm refused");
	return { secret, codes: confirmed.backupCodes };
}

/** A code that is certainly wrong at `now`. */
function wrongCode(secret: Uint8Array, now: Date): string {
	const right = totpAt(secret, now);
	const first = right[0] === "0" ? "1" : "0";
	return `${first}${right.slice(1)}`;
}

async function sessionCount(userId: string): Promise<number> {
	return (await db.select().from(sessions).where(eq(sessions.userId, userId)))
		.length;
}

beforeEach(() => {
	_resetLoginRateLimitForTests();
	_setLoginRateLimitSleepForTests(async () => {});
});

afterEach(async () => {
	for (const userId of userIds) {
		await db.delete(users).where(eq(users.id, userId));
	}
	userIds.length = 0;
});

describe("POST /api/auth/login/two-step", () => {
	it("the right code creates the session and clears the attempt cookie", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, true, new Date());
		const cookies = makeCookies(challenge.token);

		const response = await POST(
			makeEvent(cookies, { code: totpAt(secret, new Date()) }),
		);

		expect(response.status).toBe(200);
		expect((await response.json()).ok).toBe(true);
		expect(cookies.delete).toHaveBeenCalledWith(SIGN_IN_ATTEMPT_COOKIE, {
			path: "/api/auth",
		});
		expect(cookies.set).toHaveBeenCalledWith(
			"session",
			expect.any(String),
			expect.objectContaining({ httpOnly: true }),
		);
		expect(await sessionCount(userId)).toBe(1);

		// The attempt is spent: one code cannot open a second session.
		const [row] = await db
			.select()
			.from(signInChallenges)
			.where(eq(signInChallenges.userId, userId));
		expect(row).toBeUndefined();
	});

	it("remember-me from the password step decides the session length", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, true, new Date());

		await POST(
			makeEvent(makeCookies(challenge.token), {
				code: totpAt(secret, new Date()),
			}),
		);

		const [row] = await db
			.select()
			.from(sessions)
			.where(eq(sessions.userId, userId));
		expect(row?.expiresAt.getTime()).toBeGreaterThan(
			Date.now() + 13 * 24 * 60 * 60 * 1000,
		);
	});

	it("a wrong code says how many tries are left and creates no session", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		const now = new Date();

		const response = await POST(
			makeEvent(makeCookies(challenge.token), { code: wrongCode(secret, now) }),
		);
		const data = await response.json();

		expect(response.status).toBe(401);
		expect(data.errorKey).toBe("login.twoStepWrongCode");
		expect(data.details.triesLeft).toBe(4);
		expect(await sessionCount(userId)).toBe(0);
	});

	it("five wrong codes end the attempt", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		const cookies = makeCookies(challenge.token);

		for (let attempt = 0; attempt < 4; attempt += 1) {
			const response = await POST(
				makeEvent(cookies, { code: wrongCode(secret, new Date()) }),
			);
			const data = await response.json();
			expect(response.status).toBe(401);
			expect(data.details.triesLeft).toBe(4 - attempt);
		}

		const fifth = await POST(
			makeEvent(cookies, { code: wrongCode(secret, new Date()) }),
		);
		const fifthData = await fifth.json();

		expect(fifth.status).toBe(401);
		expect(fifthData.errorKey).toBe("login.twoStepTooManyTries");
		expect(
			await db
				.select()
				.from(signInChallenges)
				.where(eq(signInChallenges.userId, userId)),
		).toHaveLength(0);
		expect(await sessionCount(userId)).toBe(0);
	});

	it("an expired attempt answers restart", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		await db
			.update(signInChallenges)
			.set({ expiresAt: new Date(Date.now() - 1_000) })
			.where(eq(signInChallenges.userId, userId));

		const response = await POST(
			makeEvent(makeCookies(challenge.token), {
				code: totpAt(secret, new Date()),
			}),
		);

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe("login.twoStepExpired");
		expect(await sessionCount(userId)).toBe(0);
	});

	it("no attempt cookie answers restart", async () => {
		const response = await POST(makeEvent(makeCookies(), { code: "123456" }));

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe("login.twoStepRestart");
	});

	it("a backup code signs in and reports how many are left", async () => {
		const { userId, email } = await createUser();
		const { codes } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		const backupCode = codes[0];
		if (!backupCode) throw new Error("no backup code");

		const response = await POST(
			makeEvent(makeCookies(challenge.token), { backupCode }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data).toEqual({
			ok: true,
			usedBackupCode: true,
			backupCodesLeft: 9,
		});
		expect(await sessionCount(userId)).toBe(1);
	});

	it("a double submit with one code yields exactly one session", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		const body = { code: totpAt(secret, new Date()) };

		const results = await Promise.all([
			POST(makeEvent(makeCookies(challenge.token), body)),
			POST(makeEvent(makeCookies(challenge.token), body)),
		]);

		expect(results.map((response) => response.status).sort()).toEqual([
			200, 401,
		]);
		expect(await sessionCount(userId)).toBe(1);
	});

	it("wrong codes are counted by the login limiter", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);

		for (
			let attempt = 0;
			attempt < LOGIN_RATE_LIMIT_POLICY.maxFailuresPerEmail;
			attempt += 1
		) {
			const challenge = await createSignInChallenge(userId, false, new Date());
			const response = await POST(
				makeEvent(makeCookies(challenge.token), {
					code: wrongCode(secret, new Date()),
				}),
			);
			expect(response.status).toBe(401);
		}

		// Over the account's budget: a wrong answer is the limiter's 429 (the
		// comparison still ran, under the penalty), never a 500.
		const challenge = await createSignInChallenge(userId, false, new Date());
		const response = await POST(
			makeEvent(makeCookies(challenge.token), {
				code: wrongCode(secret, new Date()),
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(429);
		expect(data.errorKey).toBe("login.twoStepTooManyAttempts");
		expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
		expect(await sessionCount(userId)).toBe(0);
	});

	it("the fifth wrong code counts in the limiter", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);

		// One full attempt: four wrong codes report the tries left, and the
		// fifth ends the challenge. R11 counts every wrong code, so that fifth
		// one must reach the limiter too.
		const challenge = await createSignInChallenge(userId, false, new Date());
		const cookies = makeCookies(challenge.token);
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const response = await POST(
				makeEvent(cookies, { code: wrongCode(secret, new Date()) }),
			);
			expect(response.status).toBe(401);
			expect((await response.json()).errorKey).toBe("login.twoStepWrongCode");
		}
		const fifth = await POST(
			makeEvent(cookies, { code: wrongCode(secret, new Date()) }),
		);
		expect(fifth.status).toBe(401);
		expect((await fifth.json()).errorKey).toBe("login.twoStepTooManyTries");

		// Three single-failure challenges: with the fifth counted the bucket is
		// at eight, so the next wrong code is the limiter's 429. Without it,
		// the bucket is at seven and that request is an ordinary 401 (M1).
		for (let attempt = 0; attempt < 3; attempt += 1) {
			const next = await createSignInChallenge(userId, false, new Date());
			const response = await POST(
				makeEvent(makeCookies(next.token), {
					code: wrongCode(secret, new Date()),
				}),
			);
			expect(response.status).toBe(401);
		}

		const last = await createSignInChallenge(userId, false, new Date());
		const response = await POST(
			makeEvent(makeCookies(last.token), {
				code: wrongCode(secret, new Date()),
			}),
		);

		expect(response.status).toBe(429);
		expect((await response.json()).errorKey).toBe(
			"login.twoStepTooManyAttempts",
		);
		expect(checkLoginRateLimit({ email })).not.toBeNull();
	});

	it("a correct password does not clear the two-step code budget", async () => {
		const password = "correct horse battery staple";
		// Cost 4 keeps nine real bcrypt comparisons cheap; the comparison is
		// the point (the REAL login route), not the cost.
		const { userId, email } = await createUser(await bcrypt.hash(password, 4));
		const { secret } = await enableTwoStep(userId, email);
		const cookies = makeCookies();

		// Nine rounds of "the password works, the code does not". R11's budget
		// must survive every password success: if the password step clears it,
		// the bucket never fills and the 429 never comes (C1).
		const responses: Response[] = [];
		for (let round = 0; round < 9; round += 1) {
			const login = await loginPOST(
				makeLoginEvent(cookies, { email, password }),
			);
			expect(login.status).toBe(200);
			expect((await login.json()).twoStep).toBe(true);
			expect(cookies.values.get(SIGN_IN_ATTEMPT_COOKIE)).toBeTruthy();

			responses.push(
				await POST(makeEvent(cookies, { code: wrongCode(secret, new Date()) })),
			);
		}

		expect(responses.slice(0, 8).map((response) => response.status)).toEqual([
			401, 401, 401, 401, 401, 401, 401, 401,
		]);
		const ninth = responses[8];
		if (!ninth) throw new Error("the ninth code attempt did not answer");
		expect(ninth.status).toBe(429);
		expect((await ninth.json()).errorKey).toBe("login.twoStepTooManyAttempts");
		expect(checkLoginRateLimit({ email })).not.toBeNull();

		// Only the full sign-in clears it: the right password and then the
		// right code. The password step alone must not.
		const login = await loginPOST(makeLoginEvent(cookies, { email, password }));
		expect(login.status).toBe(200);
		const signedIn = await POST(
			makeEvent(cookies, { code: totpAt(secret, new Date()) }),
		);
		expect(signedIn.status).toBe(200);
		expect(checkLoginRateLimit({ email })).toBeNull();
	});

	it("an attempt whose factor was reset meanwhile cannot sign in", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		const challenge = await createSignInChallenge(userId, false, new Date());
		// Simulate the reset's effect on the factor while the attempt survives
		// (the reset deletes both; this proves the read re-checks the factor).
		await db
			.delete(userSecondFactors)
			.where(eq(userSecondFactors.userId, userId));

		const response = await POST(
			makeEvent(makeCookies(challenge.token), {
				code: totpAt(secret, new Date()),
			}),
		);

		expect(response.status).toBe(401);
		expect((await response.json()).errorKey).toBe("login.twoStepRestart");
		expect(await sessionCount(userId)).toBe(0);
	});

	it("an unreadable secret answers 409 contact-your-admin, never a 500", async () => {
		const { userId, email } = await createUser();
		const { secret } = await enableTwoStep(userId, email);
		await db
			.update(userSecondFactors)
			.set({ secretCiphertext: "corrupt" })
			.where(eq(userSecondFactors.userId, userId));
		const challenge = await createSignInChallenge(userId, false, new Date());

		const response = await POST(
			makeEvent(makeCookies(challenge.token), {
				code: totpAt(secret, new Date()),
			}),
		);

		expect(response.status).toBe(409);
		expect((await response.json()).errorKey).toBe("login.twoStepUnavailable");
		expect(await sessionCount(userId)).toBe(0);
	});
});
