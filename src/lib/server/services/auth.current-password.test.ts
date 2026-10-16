import { randomUUID } from "node:crypto";
import * as bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "$lib/server/db";
import { users } from "$lib/server/db/schema";
import { checkCurrentPassword } from "./auth";
import {
	_resetLoginRateLimitForTests,
	_setLoginRateLimitSleepForTests,
	checkLoginRateLimit,
	LOGIN_RATE_LIMIT_POLICY,
} from "./login-rate-limit";

// The one place the account password is checked for a settings action that
// asks for it again (the password change, the email change). Same bcrypt
// comparison the login uses, same limiter, in its own `account:` namespace so
// a fumbled password here never costs the person their sign-in. Real account
// row and the real limiter.

const PASSWORD = "current-password-1";
const BUDGET = LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount;

let userId: string;

beforeEach(async () => {
	_resetLoginRateLimitForTests();
	_setLoginRateLimitSleepForTests(async () => {});
	userId = randomUUID();
	await db.insert(users).values({
		id: userId,
		email: `${userId}@example.com`,
		passwordHash: bcrypt.hashSync(PASSWORD, 4),
	});
});

afterEach(async () => {
	_setLoginRateLimitSleepForTests();
	await db.delete(users).where(eq(users.id, userId));
});

async function failTimes(count: number) {
	for (let attempt = 0; attempt < count; attempt += 1) {
		await checkCurrentPassword(userId, "not-the-password");
	}
}

describe("checkCurrentPassword", () => {
	it("says ok for the right password", async () => {
		expect(await checkCurrentPassword(userId, PASSWORD)).toEqual({
			outcome: "ok",
		});
	});

	it("says wrong for another one, and counts it against the account", async () => {
		expect(await checkCurrentPassword(userId, "not-the-password")).toEqual({
			outcome: "wrong",
		});

		expect(checkLoginRateLimit({ accountId: userId })).toBeNull();
		await failTimes(BUDGET - 1);
		// The BUDGETth failure has been recorded: the account is now over budget.
		expect(checkLoginRateLimit({ accountId: userId })).not.toBeNull();
	});

	it("keeps its count apart from the sign-in's, which keys on the email", async () => {
		await failTimes(BUDGET + 1);

		expect(checkLoginRateLimit({ email: `${userId}@example.com` })).toBeNull();
	});

	it("reports a wrong answer under a penalty as the throttle it is, with the wait", async () => {
		await failTimes(BUDGET);

		const outcome = await checkCurrentPassword(userId, "not-the-password");

		expect(outcome).toMatchObject({ outcome: "throttled" });
		expect(
			(outcome as { retryAfterSeconds: number }).retryAfterSeconds,
		).toBeGreaterThan(0);
	});

	it("still accepts the right password under a penalty, and clears the count", async () => {
		await failTimes(BUDGET + 2);

		expect(await checkCurrentPassword(userId, PASSWORD)).toEqual({
			outcome: "ok",
		});
		expect(checkLoginRateLimit({ accountId: userId })).toBeNull();
		expect(await checkCurrentPassword(userId, "not-the-password")).toEqual({
			outcome: "wrong",
		});
	});

	it("says there is no such person for an account that is gone", async () => {
		expect(await checkCurrentPassword(randomUUID(), PASSWORD)).toEqual({
			outcome: "no_user",
		});
	});

	// Over budget, one comparison per key runs at a time, after its wait; the
	// others are turned away at once. That cap on guesses is the point of the
	// limiter, so a second attempt is refused as throttled, not compared.
	it("turns a second attempt away while one is still waiting out the penalty, without comparing it", async () => {
		await failTimes(BUDGET + 1);
		const delayBefore = checkLoginRateLimit({ accountId: userId })?.delayMs;
		expect(delayBefore).toBeGreaterThan(0);

		let endPenalty!: () => void;
		_setLoginRateLimitSleepForTests(
			() =>
				new Promise<void>((resolve) => {
					endPenalty = resolve;
				}),
		);
		const first = checkCurrentPassword(userId, PASSWORD);

		const second = await checkCurrentPassword(userId, "not-the-password");

		expect(second).toMatchObject({ outcome: "throttled" });
		// Nothing was compared, so nothing was recorded against the account.
		expect(checkLoginRateLimit({ accountId: userId })?.delayMs).toBe(
			delayBefore,
		);

		endPenalty();
		expect(await first).toEqual({ outcome: "ok" });
	});
});
