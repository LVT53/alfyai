// Per-user throttle for the chat home's suggestion events
// (POST /api/home/summary). Modelled on `checkMemoryNoteRateLimit` in
// $lib/server/services/memory-profile/note-rate-limit: a small in-memory
// sliding window scoped to this process.
//
// Why this endpoint needs one at all. Every accepted POST inserts a row that
// lives for seven days, and the key it stores is whatever the client sent —
// bounded in length, but not in how many DIFFERENT keys one user can invent.
// Nothing else caps it: `purgeExpiredHomeSuggestionEvents` only drops rows
// that are already past their seven days, so a stuck client (or a loop in a
// console tab) could grow one user's slice of the table without limit, and
// every later `actedOnKeysFor` read would carry the weight.
//
// The cap is generous against real use: the home screen writes at most one
// event per chip the user actually touches, so a person acting on every chip
// of every deal is still single digits a minute.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 30;
const rateLimitBuckets = new Map<string, number[]>();

/**
 * How many distinct users the limiter remembers. A bucket is at most thirty
 * numbers, but one per user for the life of the process is still unbounded
 * growth, and this map must not be the thing that leaks while the table it
 * protects stays small.
 */
const MAX_TRACKED_USERS = 5_000;

export function checkHomeSuggestionEventRateLimit(
	userId: string,
	now: number = Date.now(),
): boolean {
	const windowStart = now - RATE_LIMIT_WINDOW_MS;
	const recent = (rateLimitBuckets.get(userId) ?? []).filter(
		(timestamp) => timestamp > windowStart,
	);
	if (recent.length >= RATE_LIMIT_MAX_REQUESTS) {
		rateLimitBuckets.set(userId, recent);
		return false;
	}
	recent.push(now);
	// Re-inserting moves the key to the end of the iteration order, so the
	// user evicted below is the one who has not posted for longest.
	rateLimitBuckets.delete(userId);
	rateLimitBuckets.set(userId, recent);
	if (rateLimitBuckets.size > MAX_TRACKED_USERS) {
		for (const [key, timestamps] of rateLimitBuckets) {
			const newest = timestamps.at(-1) ?? 0;
			if (newest <= windowStart) rateLimitBuckets.delete(key);
		}
		while (rateLimitBuckets.size > MAX_TRACKED_USERS) {
			const oldest = rateLimitBuckets.keys().next();
			if (oldest.done) break;
			rateLimitBuckets.delete(oldest.value);
		}
	}
	return true;
}

// Test-only: clears every bucket so rate-limit tests don't leak state across
// cases (the map is otherwise process-lifetime, matching production).
export function _resetHomeSuggestionEventRateLimitForTests(): void {
	rateLimitBuckets.clear();
}
