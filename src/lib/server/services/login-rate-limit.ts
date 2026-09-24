// Throttle for credential endpoints — POST /api/auth/login and the
// current-password check in PATCH /api/settings/password.
//
// A sliding window of timestamps per key in a process-local Map, with LRU
// eviction so the map cannot outgrow what it protects. Nothing here is
// persisted or shared between processes; a single node is the whole
// deployment.
//
// Two differences from the other limiters in this codebase, both deliberate:
//
//  1. Only FAILURES are counted. A limiter that counts successes throttles the
//     people who are getting it right, and would break the e2e suite, which
//     logs in dozens of times from one address as admin@local.
//  2. There are two independent keys. The per-email key is the real defence —
//     it caps guesses against one account regardless of where they come from.
//     The per-address key is the anti-spray backstop, and it is only applied
//     when the address is actually trustworthy (see
//     `resolveRateLimitClientAddress`).
//
// THE LOCKOUT QUESTION
//
// A limiter keyed on the submitted email is, by construction, a lever anybody
// can pull against anybody: the addresses are indistinguishable behind Apache,
// so "eight failures for owner@example.com" is eight failures a stranger can
// manufacture. If exceeding the budget simply refused the request, a stranger
// who knows the owner's email address could keep this single-box deployment's
// only entrance shut indefinitely by failing eight times every quarter hour.
// There is no second admin, no out-of-band unlock and no password-reset mail
// here — the recovery procedure would be an ssh session and a service restart.
// A permanent, unauthenticated denial of service on the login page is a worse
// bug than the online guessing this module exists to slow down.
//
// So exceeding the budget does not refuse the request. It makes the request
// EXPENSIVE, and it refuses only the ones that turn out to be wrong:
//
//   * Under the budget: nothing happens at all. No delay, no bookkeeping.
//   * Over the budget: the comparison still runs, but only after an escalating
//     delay (1s, 2s, 4s, capped at 8s), and only ONE such comparison per key
//     may be in flight at a time. Everything else on that key is refused
//     immediately, without reaching bcrypt.
//   * A CORRECT password over the budget succeeds, and clears the budget. The
//     owner is never locked out; the worst they suffer is one 8-second wait.
//   * A WRONG password over the budget gets 429 and Retry-After.
//
// What that buys, and what it costs, stated plainly:
//
//   - Guessing one account is capped at roughly one attempt per 8 seconds no
//     matter how many connections the attacker opens, because of the
//     single-flight rule. That is the rate limit; the 429 is only how a wrong
//     answer is reported.
//   - It is NOT a lockout, so an attacker with unlimited time still gets
//     unlimited attempts at ~450/hour. Against the 8+ character passwords this
//     product requires that is not a threat; against a password the attacker
//     already has from a breach, no lockout duration would have helped either.
//   - Admitting a correct password while throttled leaks nothing an attacker
//     does not already know. 429-vs-401 says only "this key is throttled",
//     which is true precisely because the attacker made it true, and the decoy
//     comparison still runs for unknown accounts so neither status nor timing
//     answers "does this account exist".
//
// `guardCredentialCheck` below is the only supported way to run a credential
// comparison: it owns the delay and the single-flight, so a route cannot get
// the ordering wrong.

/** One sliding window, shared by every policy below. */
const WINDOW_MS = 15 * 60_000;

/**
 * Failures per email per window. Eight is comfortably above a human who has
 * two passwords in their head and a caps-lock key, and far below anything
 * useful for guessing.
 */
const MAX_FAILURES_PER_EMAIL = 8;

/**
 * Failures per client address per window. Higher than the per-email cap
 * because one address is legitimately several people — an office, a VPN exit,
 * a household. This catches spraying across many accounts, not guessing at one.
 */
const MAX_FAILURES_PER_ADDRESS = 30;

/**
 * Wrong-current-password attempts per account per window, for the settings
 * password change. Its own namespace on purpose: a wrong current password in
 * settings must not lock the same person out of logging in, and vice versa.
 */
const MAX_FAILURES_PER_ACCOUNT = 8;

/**
 * How many distinct keys the limiter remembers. The address key space is
 * attacker-influenced whenever the app is directly exposed, so an unbounded
 * map here would be a memory-exhaustion lever rather than a defence.
 */
const MAX_TRACKED_KEYS = 20_000;

/**
 * The wait before an over-budget comparison, doubling per failure past the
 * limit and capped. The cap is what keeps this a throttle rather than a
 * lockout: a person who mistyped nine times and then gets it right waits eight
 * seconds, not fifteen minutes.
 */
const PENALTY_BASE_DELAY_MS = 1_000;
const PENALTY_MAX_DELAY_MS = 8_000;

const buckets = new Map<string, number[]>();

/**
 * Keys with an over-budget comparison in flight right now.
 *
 * Bounded by concurrency rather than by key space — every entry is removed in
 * a `finally` — so it needs no eviction of its own.
 */
const throttledInFlight = new Set<string>();

export type LoginRateLimitScope = "email" | "address" | "account";

export interface LoginRateLimitKeys {
	/** Raw, un-normalized address of the account. */
	email?: string | null;
	/** Trusted client address, or null when there is not one (see below). */
	clientAddress?: string | null;
	/** User id, for the authenticated password-change endpoint. */
	accountId?: string | null;
}

export interface LoginRateLimitBlock {
	scope: LoginRateLimitScope;
	/** The bucket this penalty came from, for the single-flight bookkeeping. */
	key: string;
	/** How long an over-budget comparison waits before it runs. */
	delayMs: number;
	/**
	 * What to put in `Retry-After`. This is the penalty delay, not the rest of
	 * the window: retrying sooner is genuinely allowed now, and a correct
	 * password on the next try is genuinely accepted.
	 */
	retryAfterSeconds: number;
}

/**
 * Emails are compared case-insensitively for limiting purposes even though the
 * user lookup is exact: otherwise `Ada@x.com` and `ada@x.com` would be two
 * budgets against one account.
 */
export function normalizeLoginEmail(value: string): string {
	return value.trim().toLowerCase();
}

/**
 * Playwright logs in dozens of times per run and
 * `tests/e2e/auth.spec.ts` deliberately submits wrong credentials, so the
 * harness turns the limiter off entirely. Following the precedent in
 * src/routes/api/conversations/[id]/title/+server.ts, this reads
 * PLAYWRIGHT_TEST directly rather than through env.ts.
 *
 * Only failures count, so the suite would very likely pass anyway — this is
 * the belt to that braces, so a future spec that adds a few more negative
 * cases does not fail mysteriously three months from now.
 */
export function isLoginRateLimitDisabled(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const flag = env.PLAYWRIGHT_TEST;
	return Boolean(flag) && flag !== "0";
}

/**
 * Loopback and RFC1918 ranges, i.e. "this is the reverse proxy talking, not a
 * client". Deliberately a small, literal list rather than a CIDR library: the
 * only question being asked is "could this possibly be a real internet peer".
 */
function isNonRoutableAddress(address: string): boolean {
	const normalized = address
		.trim()
		.toLowerCase()
		.replace(/^::ffff:/, "");
	if (normalized === "" || normalized === "::1" || normalized === "localhost") {
		return true;
	}
	if (/^127\./.test(normalized)) return true;
	if (/^10\./.test(normalized)) return true;
	if (/^192\.168\./.test(normalized)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(normalized)) return true;
	// fc00::/7, the IPv6 unique-local range.
	if (/^f[cd][0-9a-f]{2}:/.test(normalized)) return true;
	return false;
}

/**
 * The address to key the per-address budget on, or null to skip that budget.
 *
 * This is the load-bearing decision in the whole module. In production the app
 * sits behind Apache (`ProxyPass / http://127.0.0.1:3001/`) and adapter-node is
 * NOT configured with ADDRESS_HEADER/XFF_DEPTH — nothing in this repo sets
 * either. So `event.getClientAddress()` returns Apache's loopback address for
 * every request on the planet.
 *
 * Keying a 30-failures-per-15-minutes budget on that would not rate-limit
 * anybody: it would give the entire product a single shared budget, and the
 * first thirty typos of the afternoon would lock every user out of logging in.
 * That is a self-inflicted outage, and a worse bug than the one being fixed.
 *
 * So the per-address budget applies only when the address can mean something:
 *
 *   - ADDRESS_HEADER is set, i.e. the operator has told adapter-node which
 *     header to trust and it has resolved a real client address for us; or
 *   - the address is routable anyway, i.e. the app is directly exposed.
 *
 * Otherwise it returns null and only the per-email budget applies — which is
 * the budget that actually protects an account.
 *
 * The raw `x-forwarded-for` header is never read here. A header the app has
 * not been configured to trust is attacker-controlled, and keying a limiter on
 * attacker-controlled input means the attacker simply picks a fresh key per
 * request while everyone else shares the forged ones.
 */
export function resolveRateLimitClientAddress(
	address: string | null | undefined,
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const trimmed = address?.trim();
	if (!trimmed) return null;
	if (env.ADDRESS_HEADER?.trim()) return trimmed;
	return isNonRoutableAddress(trimmed) ? null : trimmed;
}

/**
 * Reads the client address without letting the adapter take the request down.
 *
 * adapter-node THROWS from `getClientAddress()` when `ADDRESS_HEADER` is
 * configured and the request arrived without that header — which is every
 * request that did not come through the reverse proxy: a health probe, a
 * script on the box, the verify harness. Those callers are local and trusted,
 * and an unknown address only means the per-address budget is skipped (the
 * per-email budget still applies), so a missing header degrades to `null`
 * instead of turning a login into a 500.
 */
export function readClientAddressSafely(
	getClientAddress: (() => string) | undefined,
): string | null {
	if (!getClientAddress) return null;
	try {
		return getClientAddress() ?? null;
	} catch {
		return null;
	}
}

function windowStartFrom(now: number): number {
	return now - WINDOW_MS;
}

function recentFailures(key: string, now: number): number[] {
	const stored = buckets.get(key);
	if (!stored) return [];
	const start = windowStartFrom(now);
	return stored.filter((timestamp) => timestamp > start);
}

function evictIfOverCapacity(now: number): void {
	if (buckets.size <= MAX_TRACKED_KEYS) return;
	const start = windowStartFrom(now);
	// Cheap pass first: anything whose newest failure has already aged out is
	// dead weight regardless of insertion order.
	for (const [key, timestamps] of buckets) {
		if ((timestamps.at(-1) ?? 0) <= start) buckets.delete(key);
	}
	// Then oldest-touched first, which Map iteration order gives us for free
	// because every write below re-inserts.
	while (buckets.size > MAX_TRACKED_KEYS) {
		const oldest = buckets.keys().next();
		if (oldest.done) break;
		buckets.delete(oldest.value);
	}
}

function pushFailure(key: string, now: number): void {
	const recent = recentFailures(key, now);
	recent.push(now);
	// Re-inserting moves the key to the end of the iteration order, so the key
	// evicted above is the one that has been quiet longest.
	buckets.delete(key);
	buckets.set(key, recent);
	evictIfOverCapacity(now);
}

function penaltyFor(
	key: string,
	limit: number,
	scope: LoginRateLimitScope,
	now: number,
): LoginRateLimitBlock | null {
	const recent = recentFailures(key, now);
	if (recent.length < limit) return null;
	// Doubles per failure past the limit, capped. `2 ** overBy` overflowing to
	// Infinity is harmless: Math.min clamps it to the cap like any other value.
	const overBy = recent.length - limit;
	const delayMs = Math.min(
		PENALTY_MAX_DELAY_MS,
		PENALTY_BASE_DELAY_MS * 2 ** overBy,
	);
	return {
		scope,
		key,
		delayMs,
		retryAfterSeconds: Math.max(1, Math.ceil(delayMs / 1000)),
	};
}

function emailKey(email: string): string {
	return `email:${normalizeLoginEmail(email)}`;
}

function addressKey(address: string): string {
	return `address:${address}`;
}

function accountKey(accountId: string): string {
	return `account:${accountId}`;
}

/** Every budget this attempt is currently over, in scope order. */
function collectPenalties(
	keys: LoginRateLimitKeys,
	now: number,
): LoginRateLimitBlock[] {
	const penalties: LoginRateLimitBlock[] = [];
	if (keys.email) {
		const penalty = penaltyFor(
			emailKey(keys.email),
			MAX_FAILURES_PER_EMAIL,
			"email",
			now,
		);
		if (penalty) penalties.push(penalty);
	}
	if (keys.accountId) {
		const penalty = penaltyFor(
			accountKey(keys.accountId),
			MAX_FAILURES_PER_ACCOUNT,
			"account",
			now,
		);
		if (penalty) penalties.push(penalty);
	}
	if (keys.clientAddress) {
		const penalty = penaltyFor(
			addressKey(keys.clientAddress),
			MAX_FAILURES_PER_ADDRESS,
			"address",
			now,
		);
		if (penalty) penalties.push(penalty);
	}
	return penalties;
}

/**
 * Is this attempt over any budget, and if so what does it cost? Returns null
 * when nothing is throttled.
 *
 * Reporting only. It does NOT decide whether the comparison runs — see
 * {@link guardCredentialCheck}, which is what the routes call.
 */
export function checkLoginRateLimit(
	keys: LoginRateLimitKeys,
	now: number = Date.now(),
): LoginRateLimitBlock | null {
	if (isLoginRateLimitDisabled()) return null;
	const penalties = collectPenalties(keys, now);
	if (penalties.length === 0) return null;
	// The most expensive one: it is the budget actually governing this attempt.
	return penalties.reduce((worst, candidate) =>
		candidate.delayMs > worst.delayMs ? candidate : worst,
	);
}

function realSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The wait used when a caller does not inject one. Overridable so route-level
 * suites can exercise the throttled paths without spending a real second per
 * case; production never touches it.
 */
let defaultSleep: (ms: number) => Promise<void> = realSleep;

/** Test-only. Pass nothing to restore the real timer. */
export function _setLoginRateLimitSleepForTests(
	sleep?: (ms: number) => Promise<void>,
): void {
	defaultSleep = sleep ?? realSleep;
}

export type CredentialCheckOutcome<T> =
	| {
			/** The comparison ran. `throttled` is set when it ran under a penalty. */
			outcome: "checked";
			value: T;
			throttled: LoginRateLimitBlock | null;
	  }
	| {
			/**
			 * The comparison did NOT run: another over-budget attempt on one of
			 * these keys is already in flight. No bcrypt work was done and no
			 * failure was recorded, because nothing was tested.
			 */
			outcome: "refused";
			block: LoginRateLimitBlock;
	  };

/**
 * Runs `verify` under the throttle described at the top of this file.
 *
 * Under budget this is a plain call with no added latency. Over budget it
 * waits out the penalty and then runs exactly one comparison per key at a
 * time; concurrent attempts on a throttled key are refused without reaching
 * `verify`, which is what caps an attacker's guess rate however many
 * connections they open.
 *
 * The caller still owns the verdict: it decides what `verify` returning means,
 * and calls {@link recordLoginFailure} or {@link recordLoginSuccess}.
 */
export async function guardCredentialCheck<T>(
	keys: LoginRateLimitKeys,
	verify: () => Promise<T>,
	options: { now?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<CredentialCheckOutcome<T>> {
	if (isLoginRateLimitDisabled()) {
		return { outcome: "checked", value: await verify(), throttled: null };
	}

	const now = options.now ?? Date.now();
	const penalties = collectPenalties(keys, now);
	if (penalties.length === 0) {
		return { outcome: "checked", value: await verify(), throttled: null };
	}

	const worst = penalties.reduce((current, candidate) =>
		candidate.delayMs > current.delayMs ? candidate : current,
	);

	if (penalties.some((penalty) => throttledInFlight.has(penalty.key))) {
		return { outcome: "refused", block: worst };
	}

	for (const penalty of penalties) throttledInFlight.add(penalty.key);
	try {
		await (options.sleep ?? defaultSleep)(worst.delayMs);
		return { outcome: "checked", value: await verify(), throttled: worst };
	} finally {
		for (const penalty of penalties) throttledInFlight.delete(penalty.key);
	}
}

/** Records one failed credential check against every key supplied. */
export function recordLoginFailure(
	keys: LoginRateLimitKeys,
	now: number = Date.now(),
): void {
	if (isLoginRateLimitDisabled()) return;
	if (keys.email) pushFailure(emailKey(keys.email), now);
	if (keys.accountId) pushFailure(accountKey(keys.accountId), now);
	if (keys.clientAddress) pushFailure(addressKey(keys.clientAddress), now);
}

/**
 * Clears the per-email (and per-account) budget after a successful check.
 *
 * The address budget is deliberately NOT cleared. An attacker spraying a
 * password list across many accounts only needs one correct guess to reset
 * their own spray counter, which would make the anti-spray budget decorative.
 */
export function recordLoginSuccess(
	keys: LoginRateLimitKeys,
	now: number = Date.now(),
): void {
	void now;
	if (keys.email) buckets.delete(emailKey(keys.email));
	if (keys.accountId) buckets.delete(accountKey(keys.accountId));
}

/** Test-only: the map is otherwise process-lifetime, matching production. */
export function _resetLoginRateLimitForTests(): void {
	buckets.clear();
	throttledInFlight.clear();
}

/** Test-only: proves the eviction above actually bounds the map. */
export function _loginRateLimitSizeForTests(): number {
	return buckets.size;
}

export const LOGIN_RATE_LIMIT_POLICY = {
	windowMs: WINDOW_MS,
	maxFailuresPerEmail: MAX_FAILURES_PER_EMAIL,
	maxFailuresPerAddress: MAX_FAILURES_PER_ADDRESS,
	maxFailuresPerAccount: MAX_FAILURES_PER_ACCOUNT,
	maxTrackedKeys: MAX_TRACKED_KEYS,
	penaltyBaseDelayMs: PENALTY_BASE_DELAY_MS,
	penaltyMaxDelayMs: PENALTY_MAX_DELAY_MS,
} as const;
