// Per-reader throttle for a board's web reads (`canvas-web.ts`).
//
// A refresh or a new search is one of the few places a browser can make this
// server call a paid provider on demand: every other search happens because a chat
// turn needed one. A Refresh button pressed in a loop, a stuck client or a script
// would otherwise spend the reader's search allowance in seconds, so each reader
// gets a few searches a minute and a couple at a time. Modelled on the app's other
// per-user throttles (`connections/recheck-rate-limit.ts`): in memory, scoped to
// this process, not persisted — a restart forgets it, which only ever errs towards
// letting one more search through.

/** How long a search counts against the reader's allowance. */
export const WEB_READ_WINDOW_MS = 60_000;
/** Searches a reader may start within that window. */
export const WEB_READ_MAX_PER_WINDOW = 10;
/** Searches a reader may have running at once (a slow one is up to a minute). */
export const WEB_READ_MAX_IN_FLIGHT = 2;
/** What a reader who has too many running at once is told to wait, in seconds. */
const BUSY_RETRY_AFTER_SECONDS = 5;

interface Allowance {
	/** When each search in the window started. */
	starts: number[];
	inFlight: number;
}

const allowances = new Map<string, Allowance>();

export type WebReadSlot =
	| { ok: true; release: () => void }
	| { ok: false; retryAfterSeconds: number };

/** Forgets the readers who have nothing running and nothing left in the window, so the table never outgrows the readers who are searching. */
function sweep(now: number): void {
	for (const [userId, allowance] of allowances) {
		if (
			allowance.inFlight === 0 &&
			allowance.starts.every(
				(startedAt) => startedAt <= now - WEB_READ_WINDOW_MS,
			)
		) {
			allowances.delete(userId);
		}
	}
}

/**
 * Takes a place for one search, or says when to come back. A place taken must be
 * released when the search ends, however it ends (`release` is safe to call twice);
 * a refused request takes nothing.
 */
export function acquireWebReadSlot(
	userId: string,
	now: number = Date.now(),
): WebReadSlot {
	sweep(now);
	const allowance = allowances.get(userId) ?? { starts: [], inFlight: 0 };
	allowance.starts = allowance.starts.filter(
		(startedAt) => startedAt > now - WEB_READ_WINDOW_MS,
	);
	if (allowance.inFlight >= WEB_READ_MAX_IN_FLIGHT) {
		allowances.set(userId, allowance);
		return { ok: false, retryAfterSeconds: BUSY_RETRY_AFTER_SECONDS };
	}
	if (allowance.starts.length >= WEB_READ_MAX_PER_WINDOW) {
		allowances.set(userId, allowance);
		const oldest = allowance.starts[0] ?? now;
		return {
			ok: false,
			retryAfterSeconds: Math.max(
				1,
				Math.ceil((oldest + WEB_READ_WINDOW_MS - now) / 1000),
			),
		};
	}
	allowance.starts.push(now);
	allowance.inFlight += 1;
	allowances.set(userId, allowance);
	let released = false;
	return {
		ok: true,
		release() {
			if (released) return;
			released = true;
			allowance.inFlight = Math.max(0, allowance.inFlight - 1);
		},
	};
}

/** Test-only: forgets every reader, so one case's searches do not count against the next. */
export function resetWebReadLimitForTests(): void {
	allowances.clear();
}
