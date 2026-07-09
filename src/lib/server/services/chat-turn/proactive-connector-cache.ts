// Issue 8.1 — short-TTL, in-memory cache for the proactive_connector_context
// stage. Mirrors web-research/extraction.ts's cache shape exactly (a
// Map<key, {expiresAt, value}>, capped size, oldest-first eviction via Map
// insertion order) — same pattern, different payload: here the cached value
// is the FETCHED+SUMMARIZED, PRE-DISTILL compact line list for one
// connection+capability, not a whole extracted web page.
//
// Deliberately keyed by `userId:connectionId:capability` only — NEVER by
// message content. The underlying data (upcoming events in the next ~48h,
// recent unread mail) is a function of time and the connector, not of what
// the user asked this turn, so every relevant turn within the TTL should hit
// the same cache entry regardless of wording.
//
// This cache is purely an in-memory performance/rate-limiting aid, not a
// persistence or telemetry surface — nothing here is written to the
// database, and nothing here is fed into memory intake (see
// proactive-connector-context.ts's module doc for the memory-boundary
// guarantee this cache sits behind).

export type ProactiveConnectorCacheKey = {
	userId: string;
	connectionId: string;
	capability: string;
};

// A handful of minutes: long enough that a multi-turn conversation about
// "my day" doesn't re-hit Google/Apple/IMAP on every message, short enough
// that a meeting starting/ending or a new email arriving is reflected again
// soon without the user having to do anything.
const DEFAULT_TTL_MS = 3 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;

const cache = new Map<string, { expiresAt: number; value: string[] }>();

function cacheKey(params: ProactiveConnectorCacheKey): string {
	return `${params.userId}:${params.connectionId}:${params.capability}`;
}

export function readProactiveConnectorContextCache(
	params: ProactiveConnectorCacheKey,
	now: number = Date.now(),
): string[] | null {
	const key = cacheKey(params);
	const entry = cache.get(key);
	if (!entry || entry.expiresAt <= now) {
		if (entry) cache.delete(key);
		return null;
	}
	return entry.value;
}

export function writeProactiveConnectorContextCache(
	params: ProactiveConnectorCacheKey,
	value: string[],
	now: number = Date.now(),
	ttlMs: number = DEFAULT_TTL_MS,
): void {
	if (ttlMs <= 0) return;
	const key = cacheKey(params);
	if (!cache.has(key) && cache.size >= MAX_CACHE_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest) cache.delete(oldest);
	}
	cache.set(key, { expiresAt: now + ttlMs, value });
}

/** Test-only: clears the module-level cache between test cases. */
export function __resetProactiveConnectorContextCacheForTests(): void {
	cache.clear();
}
