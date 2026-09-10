// Per-user throttle for POST /api/connections/[id]/recheck.
//
// That route is the one place a CLIENT can make this server open an outbound
// connection to a third-party provider on demand — every other provider call
// happens because a chat turn needed data. The tab fires it when a detail
// dialog opens, which is at most a few times a minute for a person; a stuck
// client (or a script) reopening the dialog in a loop would otherwise hammer
// the provider from our IP and invite rate-limiting or a block on the user's
// own account.
//
// Modelled on note-rate-limit.ts (which is itself modelled on
// checkClientActivityRateLimit): a small in-memory sliding window scoped to
// this process. Not persisted and not shared with any other limiter.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 12;
const rateLimitBuckets = new Map<string, number[]>();

export function checkConnectionRecheckRateLimit(
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
export function _resetConnectionRecheckRateLimitForTests(): void {
	rateLimitBuckets.clear();
}
