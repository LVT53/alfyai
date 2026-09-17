import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	_loginRateLimitSizeForTests,
	_resetLoginRateLimitForTests,
	checkLoginRateLimit,
	guardCredentialCheck,
	isLoginRateLimitDisabled,
	LOGIN_RATE_LIMIT_POLICY,
	normalizeLoginEmail,
	recordLoginFailure,
	recordLoginSuccess,
	resolveRateLimitClientAddress,
} from "./login-rate-limit";

const NOW = 1_800_000_000_000;
const {
	windowMs,
	maxFailuresPerEmail,
	maxFailuresPerAddress,
	maxTrackedKeys,
	penaltyBaseDelayMs,
	penaltyMaxDelayMs,
} = LOGIN_RATE_LIMIT_POLICY;

function failTimes(
	count: number,
	keys: Parameters<typeof recordLoginFailure>[0],
	now = NOW,
): void {
	for (let attempt = 0; attempt < count; attempt += 1) {
		recordLoginFailure(keys, now);
	}
}

beforeEach(() => {
	_resetLoginRateLimitForTests();
});

describe("normalizeLoginEmail", () => {
	it("folds case and surrounding whitespace so one account is one budget", () => {
		expect(normalizeLoginEmail("  Ada@Example.COM ")).toBe("ada@example.com");
	});
});

describe("per-email budget", () => {
	const keys = { email: "ada@example.com" };

	it("allows attempts up to the cap and blocks the one after", () => {
		for (let attempt = 0; attempt < maxFailuresPerEmail; attempt += 1) {
			expect(checkLoginRateLimit(keys, NOW)).toBeNull();
			recordLoginFailure(keys, NOW);
		}
		const block = checkLoginRateLimit(keys, NOW);
		expect(block?.scope).toBe("email");
	});

	it("treats different spellings of the same address as one budget", () => {
		failTimes(maxFailuresPerEmail, { email: "ADA@example.com" });
		expect(
			checkLoginRateLimit({ email: "ada@EXAMPLE.com" }, NOW),
		).not.toBeNull();
	});

	it("escalates the penalty per failure past the cap, up to the ceiling", () => {
		failTimes(maxFailuresPerEmail, keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)?.delayMs).toBe(penaltyBaseDelayMs);

		recordLoginFailure(keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)?.delayMs).toBe(
			penaltyBaseDelayMs * 2,
		);

		failTimes(50, keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)?.delayMs).toBe(penaltyMaxDelayMs);
	});

	it("reports a Retry-After of the penalty, not the rest of the window", () => {
		// Retrying sooner is genuinely allowed — the next attempt is throttled,
		// not refused — so advertising the full 15 minutes would be a lie that
		// keeps a legitimate person out far longer than the policy requires.
		failTimes(maxFailuresPerEmail, keys, NOW);
		const block = checkLoginRateLimit(keys, NOW);
		expect(block?.retryAfterSeconds).toBe(penaltyBaseDelayMs / 1000);
		expect(block?.retryAfterSeconds).toBeLessThan(windowMs / 1000);
	});

	it("slides: the budget frees up as old failures age out", () => {
		failTimes(maxFailuresPerEmail, keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)).not.toBeNull();
		expect(checkLoginRateLimit(keys, NOW + windowMs + 1)).toBeNull();
	});

	it("does not free up early when failures are spread across the window", () => {
		for (let attempt = 0; attempt < maxFailuresPerEmail; attempt += 1) {
			recordLoginFailure(keys, NOW + attempt * 1000);
		}
		// The newest failure is still well inside the window.
		expect(checkLoginRateLimit(keys, NOW + windowMs - 1000)).not.toBeNull();
	});

	it("is cleared by a success", () => {
		failTimes(maxFailuresPerEmail, keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)).not.toBeNull();

		recordLoginSuccess(keys, NOW);
		expect(checkLoginRateLimit(keys, NOW)).toBeNull();
	});

	it("keeps one account's failures away from another's", () => {
		failTimes(maxFailuresPerEmail, { email: "ada@example.com" });
		expect(checkLoginRateLimit({ email: "grace@example.com" }, NOW)).toBeNull();
	});
});

describe("guardCredentialCheck", () => {
	const keys = { email: "ada@example.com" };
	/** Collapses the penalty wait so the suite does not actually sleep. */
	const sleep = vi.fn(async () => {});

	beforeEach(() => {
		sleep.mockClear();
	});

	it("does not touch an attempt that is under budget", async () => {
		const verify = vi.fn(async () => "ran");
		const result = await guardCredentialCheck(keys, verify, {
			now: NOW,
			sleep,
		});

		expect(result).toEqual({
			outcome: "checked",
			value: "ran",
			throttled: null,
		});
		expect(sleep).not.toHaveBeenCalled();
	});

	// THE anti-lockout property. A stranger can put anybody's email over the
	// budget, so being over the budget must never be the end of the story for
	// the person who actually knows the password.
	it("still runs the comparison once the budget is blown", async () => {
		failTimes(maxFailuresPerEmail * 4, keys, NOW);
		const verify = vi.fn(async () => "ran");

		const result = await guardCredentialCheck(keys, verify, {
			now: NOW,
			sleep,
		});

		expect(verify).toHaveBeenCalledTimes(1);
		expect(result.outcome).toBe("checked");
		expect(result.outcome === "checked" && result.throttled?.scope).toBe(
			"email",
		);
	});

	it("waits out the penalty before comparing", async () => {
		failTimes(maxFailuresPerEmail, keys, NOW);
		const order: string[] = [];
		const trackedSleep = vi.fn(async (ms: number) => {
			order.push(`slept:${ms}`);
		});

		await guardCredentialCheck(
			keys,
			async () => {
				order.push("verified");
				return true;
			},
			{ now: NOW, sleep: trackedSleep },
		);

		expect(order).toEqual([`slept:${penaltyBaseDelayMs}`, "verified"]);
	});

	// The single-flight rule is what makes this a rate limit rather than a
	// speed bump: without it an attacker just opens a thousand connections and
	// pays the delay once.
	it("refuses a second over-budget attempt on the same key while one is in flight", async () => {
		failTimes(maxFailuresPerEmail, keys, NOW);

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const slowVerify = vi.fn(async () => {
			await gate;
			return "first";
		});
		const secondVerify = vi.fn(async () => "second");

		const first = guardCredentialCheck(keys, slowVerify, { now: NOW, sleep });
		// Let the first call get past its (stubbed) sleep and into `verify`.
		await Promise.resolve();
		await Promise.resolve();

		const second = await guardCredentialCheck(keys, secondVerify, {
			now: NOW,
			sleep,
		});

		expect(second.outcome).toBe("refused");
		expect(secondVerify).not.toHaveBeenCalled();

		release?.();
		expect((await first).outcome).toBe("checked");

		// And the lane is free again afterwards.
		const third = await guardCredentialCheck(keys, secondVerify, {
			now: NOW,
			sleep,
		});
		expect(third.outcome).toBe("checked");
	});

	it("does not serialize two different accounts against each other", async () => {
		failTimes(maxFailuresPerEmail, { email: "ada@example.com" }, NOW);
		failTimes(maxFailuresPerEmail, { email: "grace@example.com" }, NOW);

		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = guardCredentialCheck(
			{ email: "ada@example.com" },
			async () => {
				await gate;
				return "ada";
			},
			{ now: NOW, sleep },
		);
		await Promise.resolve();
		await Promise.resolve();

		const second = await guardCredentialCheck(
			{ email: "grace@example.com" },
			async () => "grace",
			{ now: NOW, sleep },
		);

		expect(second.outcome).toBe("checked");
		release?.();
		await first;
	});

	it("frees the in-flight lane even when the comparison throws", async () => {
		failTimes(maxFailuresPerEmail, keys, NOW);

		await expect(
			guardCredentialCheck(
				keys,
				async () => {
					throw new Error("bcrypt exploded");
				},
				{ now: NOW, sleep },
			),
		).rejects.toThrow("bcrypt exploded");

		const after = await guardCredentialCheck(keys, async () => "ok", {
			now: NOW,
			sleep,
		});
		expect(after.outcome).toBe("checked");
	});

	it("is a straight passthrough under PLAYWRIGHT_TEST", async () => {
		const previous = process.env.PLAYWRIGHT_TEST;
		process.env.PLAYWRIGHT_TEST = "1";
		try {
			failTimes(maxFailuresPerEmail * 4, keys, NOW);
			const result = await guardCredentialCheck(keys, async () => "ran", {
				now: NOW,
				sleep,
			});
			expect(result).toEqual({
				outcome: "checked",
				value: "ran",
				throttled: null,
			});
			expect(sleep).not.toHaveBeenCalled();
		} finally {
			if (previous === undefined) delete process.env.PLAYWRIGHT_TEST;
			else process.env.PLAYWRIGHT_TEST = previous;
		}
	});
});

describe("per-address budget", () => {
	const address = "203.0.113.10";

	it("blocks a spray across many accounts from one address", () => {
		for (let attempt = 0; attempt < maxFailuresPerAddress; attempt += 1) {
			recordLoginFailure(
				{ email: `victim-${attempt}@example.com`, clientAddress: address },
				NOW,
			);
		}
		const block = checkLoginRateLimit(
			{ email: "victim-final@example.com", clientAddress: address },
			NOW,
		);
		expect(block?.scope).toBe("address");
	});

	it("is NOT cleared by a success", () => {
		// Otherwise an attacker spraying a password list only has to get one
		// account right to reset their own spray counter.
		for (let attempt = 0; attempt < maxFailuresPerAddress; attempt += 1) {
			recordLoginFailure(
				{ email: `victim-${attempt}@example.com`, clientAddress: address },
				NOW,
			);
		}
		recordLoginSuccess({ email: "victim-0@example.com" }, NOW);

		expect(
			checkLoginRateLimit(
				{ email: "victim-0@example.com", clientAddress: address },
				NOW,
			)?.scope,
		).toBe("address");
	});

	it("reports the email scope first when both budgets are exhausted", () => {
		// The per-email Retry-After is the accurate one for the person actually
		// being throttled.
		failTimes(maxFailuresPerAddress, {
			email: "ada@example.com",
			clientAddress: address,
		});
		expect(
			checkLoginRateLimit(
				{ email: "ada@example.com", clientAddress: address },
				NOW,
			)?.scope,
		).toBe("email");
	});
});

describe("resolveRateLimitClientAddress", () => {
	it("returns null for a proxy's loopback address when ADDRESS_HEADER is unset", () => {
		// Production's shape today: Apache proxies from 127.0.0.1 and nothing in
		// this repo configures adapter-node's ADDRESS_HEADER, so
		// getClientAddress() is identical for every client. Keying a shared
		// budget on it would lock the entire product out, not rate-limit anyone.
		for (const address of [
			"127.0.0.1",
			"::1",
			"::ffff:127.0.0.1",
			"10.1.2.3",
			"192.168.0.5",
			"172.20.0.9",
			"fd00::1",
		]) {
			expect(resolveRateLimitClientAddress(address, {})).toBeNull();
		}
	});

	it("uses a routable address even without ADDRESS_HEADER (direct exposure)", () => {
		expect(resolveRateLimitClientAddress("203.0.113.10", {})).toBe(
			"203.0.113.10",
		);
		expect(resolveRateLimitClientAddress("2001:db8::1", {})).toBe(
			"2001:db8::1",
		);
	});

	it("trusts whatever adapter-node resolved once ADDRESS_HEADER is configured", () => {
		const env = { ADDRESS_HEADER: "x-forwarded-for" } as NodeJS.ProcessEnv;
		expect(resolveRateLimitClientAddress("198.51.100.7", env)).toBe(
			"198.51.100.7",
		);
		// Including a private one — behind a corporate proxy chain that is what
		// the real client address legitimately is.
		expect(resolveRateLimitClientAddress("10.1.2.3", env)).toBe("10.1.2.3");
	});

	it("returns null for an absent or blank address", () => {
		expect(resolveRateLimitClientAddress(null, {})).toBeNull();
		expect(resolveRateLimitClientAddress(undefined, {})).toBeNull();
		expect(resolveRateLimitClientAddress("   ", {})).toBeNull();
	});
});

describe("account budget (settings password change)", () => {
	it("is namespaced away from the login budget", () => {
		// A fumbled current password in Settings must not lock the same person
		// out of signing in.
		failTimes(LOGIN_RATE_LIMIT_POLICY.maxFailuresPerAccount, {
			accountId: "user-1",
		});
		expect(checkLoginRateLimit({ accountId: "user-1" }, NOW)?.scope).toBe(
			"account",
		);
		expect(checkLoginRateLimit({ email: "ada@example.com" }, NOW)).toBeNull();
	});
});

describe("memory bounds", () => {
	it("evicts rather than growing without limit under a flood of distinct keys", () => {
		const flood = maxTrackedKeys + 2_000;
		for (let index = 0; index < flood; index += 1) {
			recordLoginFailure({ email: `person-${index}@example.com` }, NOW);
		}
		expect(_loginRateLimitSizeForTests()).toBeLessThanOrEqual(maxTrackedKeys);
	});

	it("drops keys whose failures have aged out", () => {
		for (let index = 0; index < 100; index += 1) {
			recordLoginFailure({ email: `old-${index}@example.com` }, NOW);
		}
		// One write far enough in the future to push the map over capacity and
		// trigger the sweep would need 20k keys; instead assert the cheaper
		// invariant: an aged-out key no longer blocks.
		expect(
			checkLoginRateLimit({ email: "old-0@example.com" }, NOW + windowMs + 1),
		).toBeNull();
	});
});

describe("isLoginRateLimitDisabled", () => {
	it("is off under the Playwright harness", () => {
		expect(isLoginRateLimitDisabled({ PLAYWRIGHT_TEST: "1" })).toBe(true);
	});

	it("is on everywhere else", () => {
		expect(isLoginRateLimitDisabled({})).toBe(false);
		expect(isLoginRateLimitDisabled({ PLAYWRIGHT_TEST: "0" })).toBe(false);
		expect(isLoginRateLimitDisabled({ PLAYWRIGHT_TEST: "" })).toBe(false);
	});
});
