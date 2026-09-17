// Throttle for credential endpoints — POST /api/auth/login and the
// current-password check in PATCH /api/settings/password.
//
// Modelled on `checkHomeSuggestionEventRateLimit` in
// $lib/server/services/home-suggestion-rate-limit: a sliding window of
// timestamps per key in a process-local Map, with LRU eviction so the map
// cannot outgrow what it protects. Nothing here is persisted or shared between
// processes; a single node is the whole deployment.
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

const buckets = new Map<string, number[]>();

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
	/** Seconds until the oldest counted failure leaves the window. */
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

function blockFor(
	key: string,
	limit: number,
	scope: LoginRateLimitScope,
	now: number,
): LoginRateLimitBlock | null {
	const recent = recentFailures(key, now);
	if (recent.length < limit) return null;
	// The window opens again when the oldest counted failure falls out of it.
	const oldest = recent[0] ?? now;
	const retryAfterSeconds = Math.max(
		1,
		Math.ceil((oldest + WINDOW_MS - now) / 1000),
	);
	return { scope, retryAfterSeconds };
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

/**
 * Is this attempt allowed? Returns the blocking scope and a Retry-After, or
 * null when the attempt may proceed.
 *
 * Call this BEFORE the password comparison, so a throttled attacker never gets
 * the endpoint to do bcrypt work on their behalf.
 */
export function checkLoginRateLimit(
	keys: LoginRateLimitKeys,
	now: number = Date.now(),
): LoginRateLimitBlock | null {
	if (isLoginRateLimitDisabled()) return null;

	// Email first: it is the specific budget, so it gives the more accurate
	// Retry-After for the person actually being throttled.
	if (keys.email) {
		const block = blockFor(
			emailKey(keys.email),
			MAX_FAILURES_PER_EMAIL,
			"email",
			now,
		);
		if (block) return block;
	}
	if (keys.accountId) {
		const block = blockFor(
			accountKey(keys.accountId),
			MAX_FAILURES_PER_ACCOUNT,
			"account",
			now,
		);
		if (block) return block;
	}
	if (keys.clientAddress) {
		const block = blockFor(
			addressKey(keys.clientAddress),
			MAX_FAILURES_PER_ADDRESS,
			"address",
			now,
		);
		if (block) return block;
	}
	return null;
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
} as const;
