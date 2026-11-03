import type { ServerHealth } from "$lib/client/api/health";

/**
 * How the app reads the signs of a server update (a deploy): the pieces that
 * decide, with nothing in them that fetches or draws. The reads they decide on
 * are passed in, so they are tested without a browser (rules:
 * `src/lib/components/chat/AGENTS.md`, "An Update During A Turn").
 */

/**
 * Whether the server is being updated right now. Asked when a reply was cut by a
 * connection that failed, before the failure is put down to the model provider:
 * a restart looks like that from a reply that was running.
 *
 * - The server says so: its health answers and it is draining.
 * - The server does not answer. During the restart the version file cannot be
 *   read either, so a new version cannot be what tells; "away" counts by itself.
 * - A new version is live (`checkVersion`, SvelteKit's `updated.check()`).
 *
 * A browser that reports itself offline is the exception: it is not witnessing
 * an update, only its own lost connection. (`navigator.onLine` is trustworthy
 * only when it says false, so a flaky connection that is still "online" can be
 * taken for an update for as long as the server cannot be reached.)
 */
export async function isServerBeingUpdated(reads: {
	fetchHealth: () => Promise<ServerHealth>;
	checkVersion: () => Promise<boolean>;
	isOffline: () => boolean;
}): Promise<boolean> {
	if (reads.isOffline()) return false;
	const health = await reads.fetchHealth();
	if (!health.reachable || health.draining) return true;
	try {
		return await reads.checkVersion();
	} catch {
		return false;
	}
}

/** How often the shell looks at the server while it watches for an update. */
export const SERVER_UPDATE_WATCH_POLL_MS = 3000;

/**
 * How long the watch lasts at most, 8 minutes: the same reasoning as a turn that
 * waits for the update (`AWAIT_UPDATE_MAX_MS`): the deploy's drain (3 minutes), a
 * stop of up to 2 minutes (the unit's TimeoutStopSec=120), then the health wait
 * after the cutover and some slack.
 */
export const SERVER_UPDATE_WATCH_MAX_MS = 8 * 60 * 1000;

/** A server that answers, is not draining and runs the version this page has, for this long, was a false alarm. */
export const SERVER_UPDATE_WATCH_FALSE_ALARM_MS = 60_000;

/** One look at the server while watching. */
export type ServerUpdateLook = {
	/** The health route answers and says it is draining. */
	draining: boolean;
	/** It does not answer: the restart. */
	away: boolean;
	/** A new version is live. */
	versionChanged: boolean;
};

export type ServerUpdateWatchEnd = "update_ready" | "false_alarm" | "timed_out";

/**
 * The shell's watch over a server update. Something in the app saw a sign of one
 * (a message turned away for it, a reply it cut off), and the shell would
 * otherwise hear of the new version only from SvelteKit's own poll, up to a
 * minute later, after the person has usually reloaded by hand or given up. So on
 * a sign it looks at the server every few seconds: the draining banner shows
 * while the server drains and while it does not answer, and the new version is
 * asked for each time, so the Refresh notice comes up within seconds of the
 * restart. The watch ends when the new version is live, after 8 minutes, or after
 * a minute of a server that answers, is not draining and runs this version (a
 * false alarm).
 *
 * It owns nothing the page draws: `onLook` and `onEnd` tell the layout, which owns
 * the banner and the notice. A sign while it watches starts its clock again.
 */
export function createServerUpdateWatch(deps: {
	fetchHealth: () => Promise<ServerHealth>;
	checkVersion: () => Promise<boolean>;
	now: () => number;
	setTimer: (callback: () => void, delayMs: number) => unknown;
	clearTimer: (handle: unknown) => void;
	onLook: (look: ServerUpdateLook) => void;
	onEnd: (end: ServerUpdateWatchEnd) => void;
}) {
	let watching = false;
	let timer: unknown = null;
	let startedAt = 0;
	let calmSince: number | null = null;

	function finish(end: ServerUpdateWatchEnd) {
		watching = false;
		timer = null;
		deps.onEnd(end);
	}

	async function look() {
		timer = null;
		if (!watching) return;
		const [health, versionChanged] = await Promise.all([
			deps.fetchHealth(),
			deps.checkVersion().catch(() => false),
		]);
		// Stopped while the look was out.
		if (!watching) return;
		const now = deps.now();
		deps.onLook({
			draining: health.reachable && health.draining,
			away: !health.reachable,
			versionChanged,
		});
		if (versionChanged) return finish("update_ready");
		const calm = health.reachable && !health.draining;
		calmSince = calm ? (calmSince ?? now) : null;
		if (
			calmSince !== null &&
			now - calmSince >= SERVER_UPDATE_WATCH_FALSE_ALARM_MS
		) {
			return finish("false_alarm");
		}
		if (now - startedAt >= SERVER_UPDATE_WATCH_MAX_MS) {
			return finish("timed_out");
		}
		timer = deps.setTimer(() => void look(), SERVER_UPDATE_WATCH_POLL_MS);
	}

	return {
		/** A sign of an update: start watching, or give a watch that runs a fresh clock. */
		sign() {
			startedAt = deps.now();
			calmSince = null;
			if (watching) return;
			watching = true;
			void look();
		},
		/** The shell is going away: no more looks, and no end is reported. */
		stop() {
			watching = false;
			if (timer !== null) deps.clearTimer(timer);
			timer = null;
		},
	};
}
