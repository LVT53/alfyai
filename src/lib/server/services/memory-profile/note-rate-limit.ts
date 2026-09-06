// Per-user throttle for the composer's `/remember` writes
// (POST /api/memory/notes). Modelled on `checkClientActivityRateLimit` in
// $lib/server/services/activity-events: a small in-memory sliding window
// scoped to this process, which is all a hand-typed composer command needs
// — a note write is a deliberate user action, so the cap only has to stop a
// stuck client (or a script) from flooding the memory profile projection.
// Not persisted and not shared with any other limiter in the codebase.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitBuckets = new Map<string, number[]>();

export function checkMemoryNoteRateLimit(
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
	rateLimitBuckets.set(userId, recent);
	return true;
}

// Test-only: clears every bucket so rate-limit tests don't leak state across
// cases (the map is otherwise process-lifetime, matching production).
export function _resetMemoryNoteRateLimitForTests(): void {
	rateLimitBuckets.clear();
}
