import { writable } from "svelte/store";
import { isSessionExpiredResponse } from "$lib/session-expiry";

/**
 * Whether this tab's login session is still good, as the server last answered.
 *
 * `expired` drives the persistent row at the top of the app shell. `alertCount`
 * is a monotonic counter the shell watches to announce the same fact once more
 * in the moment it bites — the user pressed something and the server refused
 * it. It only ever moves forward, including across a `clearSessionExpiry()`, so
 * a watcher can compare it against the last value it announced.
 */
type SessionExpiryState = {
	expired: boolean;
	alertCount: number;
};

/**
 * One announcement per window, however many requests were refused. A page with
 * an expired session fires a handful of parallel calls, and coming back to the
 * tab refreshes the conversation list — each of those is a refusal, and without
 * this the user would get a queue of identical toasts at the toast component's
 * own 4s cadence. Long enough not to be that queue, short enough that taking
 * another run at something a minute later says so again instead of failing
 * quietly behind the row.
 */
const ALERT_THROTTLE_MS = 30_000;

export const sessionExpiry = writable<SessionExpiryState>({
	expired: false,
	alertCount: 0,
});

// Mirrored outside the store so non-reactive callers can ask without a
// subscription, the same way the other stores in this folder expose their
// current value to plain functions.
let expired = false;
let lastAlertAt = 0;

export function isSessionExpired(): boolean {
	return expired;
}

/**
 * Record that the server has refused a request because the session is gone.
 * Idempotent for the row; throttled for the announcement.
 */
export function markSessionExpired(): void {
	const now = Date.now();
	const announce = now - lastAlertAt >= ALERT_THROTTLE_MS;
	if (announce) lastAlertAt = now;
	expired = true;
	sessionExpiry.update((state) =>
		state.expired && !announce
			? state
			: {
					expired: true,
					alertCount: state.alertCount + (announce ? 1 : 0),
				},
	);
}

/**
 * Forget the expiry: a request has just succeeded, so this tab has a working
 * session again (signing in on the login screen, or in another tab). The
 * announcement counter deliberately survives — resetting it would make the next
 * announcement look like one a watcher had already shown.
 */
export function clearSessionExpiry(): void {
	if (!expired) return;
	expired = false;
	lastAlertAt = 0;
	sessionExpiry.update((state) => ({
		expired: false,
		alertCount: state.alertCount,
	}));
}

/**
 * The single place a browser transport hands a response to this store. Reads
 * two fields off the response and nothing else — the store stays out of the
 * business of making requests, per the boundary in this folder's AGENTS.md.
 */
export function observeSessionFromResponse(
	response:
		| {
				ok?: boolean;
				status: number;
				headers?: { get(name: string): string | null } | null;
		  }
		| null
		| undefined,
): void {
	if (!response) return;
	if (isSessionExpiredResponse(response)) {
		markSessionExpired();
		return;
	}
	const ok =
		typeof response.ok === "boolean"
			? response.ok
			: response.status >= 200 && response.status < 300;
	if (ok) clearSessionExpiry();
}
