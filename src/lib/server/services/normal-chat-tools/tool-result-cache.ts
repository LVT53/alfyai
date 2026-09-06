// Per-conversation, in-process cache for the raw Parallel result behind
// research_web / fetch_url (and the pasted-URL server prefetch in
// normal-chat-context.ts, which shares this cache so a prefetch followed by
// the model's own fetch_url of the same URL is served from cache instead of
// paying and waiting for Parallel twice).
//
// Keyed on conversationId + tool name + a stable hash of the normalized tool
// input (shortHash/stableStringify from ./shared), so a repeated identical
// call — same query/objective/searchQueries, or the same URL set — inside
// ONE conversation is served from memory. Deliberately process-local (no
// cross-instance sharing, no persistence): a cold start or a different
// server instance just misses and re-fetches, which is safe and matches the
// existing per-process posture of tool-health snapshots.
//
// Bounded LRU: a `Map`'s insertion order gives cheap LRU semantics — a hit
// deletes-then-reinserts its entry (moving it to the "most recently used"
// end), and eviction always removes from the front (`.keys().next()`).

import { shortHash, stableStringify } from "./shared";

const TOOL_RESULT_CACHE_TTL_MS = 30 * 60 * 1000;
const TOOL_RESULT_CACHE_MAX_ENTRIES = 500;

interface ToolResultCacheEntry<TResult> {
	result: TResult;
	expiresAt: number;
}

// A single untyped map backs every cached result (research_web's and
// fetch_url's GroundedWebResult shapes are structurally compatible; callers
// supply the type parameter at the read site). One cache, not one per tool,
// keeps the LRU eviction bound (500 entries) meaningful across the whole
// per-conversation tool surface rather than per-tool.
const cache = new Map<string, ToolResultCacheEntry<unknown>>();

export function buildToolResultCacheKey(params: {
	conversationId: string;
	toolName: string;
	input: unknown;
}): string {
	return `${params.conversationId}::${params.toolName}::${shortHash(
		params.input,
	)}`;
}

/**
 * Returns the cached result for `key`, or `null` on a miss (never cached,
 * expired, or evicted). A hit refreshes the entry's LRU position.
 */
export function getCachedToolResult<TResult>(key: string): TResult | null {
	const entry = cache.get(key);
	if (!entry) return null;
	if (Date.now() >= entry.expiresAt) {
		cache.delete(key);
		return null;
	}
	// Refresh LRU order: delete + re-insert moves this key to the end (most
	// recently used), so eviction below always drops the true least-recently
	// used entry rather than the least-recently-inserted one.
	cache.delete(key);
	cache.set(key, entry);
	return entry.result as TResult;
}

/**
 * Stores `result` under `key` with a fresh 30-minute TTL, evicting the
 * least-recently-used entry/entries once the bounded size is exceeded.
 */
export function setCachedToolResult<TResult>(
	key: string,
	result: TResult,
): void {
	// Re-inserting an existing key would otherwise keep its old position in
	// a Map's iteration order; delete first so the set below both refreshes
	// the TTL and moves it to the most-recently-used end.
	cache.delete(key);
	cache.set(key, { result, expiresAt: Date.now() + TOOL_RESULT_CACHE_TTL_MS });
	while (cache.size > TOOL_RESULT_CACHE_MAX_ENTRIES) {
		const oldestKey = cache.keys().next().value;
		if (oldestKey === undefined) break;
		cache.delete(oldestKey);
	}
}

/** Test-only: clears every entry so test cases don't leak cache state. */
export function resetToolResultCacheForTests(): void {
	cache.clear();
}

/** Test-only: current entry count, for eviction-boundary assertions. */
export function toolResultCacheSizeForTests(): number {
	return cache.size;
}

// Re-exported so callers building a cache key don't need a second import
// just to normalize/hash an input the same way the key does internally.
export { shortHash, stableStringify };
