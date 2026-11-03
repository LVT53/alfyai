import {
	HEALTH_REQUEST_MAX_MS,
	type ServerHealth,
} from "$lib/client/api/health";

/**
 * How the app reads the signs of a server update (a deploy): the pieces that
 * decide, with nothing in them that fetches or draws. The reads they decide on
 * are passed in, so they are tested without a browser (rules:
 * `src/lib/components/chat/AGENTS.md`, "An Update During A Turn").
 */

/** What the pieces that set timers are given: the page's own clock, or a test's. */
type Timers = {
	setTimer: (callback: () => void, delayMs: number) => unknown;
	clearTimer: (handle: unknown) => void;
};

/** A read that has not answered in this long is no answer: the same five seconds as the health request. */
export const SERVER_UPDATE_READ_MAX_MS = HEALTH_REQUEST_MAX_MS;

/**
 * What `read` answers, or `fallback` when it fails or has not answered within
 * `maxMs`. A stalled request (SvelteKit's `updated.check()` has no timeout of its
 * own) must not hold a question or the watch back for ever. The read is left to
 * finish; its late answer is dropped.
 */
export function answerOrFallBack<T>(
	read: () => Promise<T>,
	fallback: T,
	timers: Timers,
	maxMs = SERVER_UPDATE_READ_MAX_MS,
): Promise<T> {
	return new Promise<T>((resolve) => {
		const handle = timers.setTimer(() => resolve(fallback), maxMs);
		const settle = (value: T) => {
			timers.clearTimer(handle);
			resolve(value);
		};
		try {
			read().then(settle, () => settle(fallback));
		} catch {
			settle(fallback);
		}
	});
}

/**
 * What the server is doing, as far as a reply that was cut off is concerned.
 *
 * - `none`: nothing says an update. A lost connection is no update: the health
 *   read failed (`unreachable`, which a phone without signal gives), or the
 *   server is well and no new version went live during this turn.
 * - `draining`: the old process is alive and is finishing the replies it runs. It
 *   did not cut the reply, and probably still runs it.
 * - `restarting`: the proxy answers its maintenance page instead of the app
 *   (`proxy_down`). The restart cut the reply.
 * - `new_version`: the server answers and runs a version that went live during
 *   this turn. The restart is over, and it cut the reply.
 */
export type ServerUpdateKind =
	| "none"
	| "draining"
	| "restarting"
	| "new_version";

/**
 * Whether the server is being updated, and how. Asked when a reply was cut by a
 * connection that failed, before the failure is put down to the model provider: a
 * restart looks like that from a reply that was running.
 *
 * A new version counts only if it went live during this turn: `versionWasLive` is
 * what the page knew when the failure was handled (`updated.current`, read before
 * any await), and only a version that was not live then and is when it is looked
 * for now (`checkVersion`, bounded) was brought by an update this turn saw. A tab
 * that missed a deploy long ago has `updated.check()` true for ever, and that is
 * not this reply's update.
 *
 * A browser that reports itself offline is not witnessing an update, only its own
 * lost connection, so it is not asked at all.
 */
export async function judgeServerUpdate(
	reads: {
		fetchHealth: () => Promise<ServerHealth>;
		checkVersion: () => Promise<boolean>;
		versionWasLive: boolean;
		isOffline: () => boolean;
	} & Timers,
): Promise<ServerUpdateKind> {
	if (reads.isOffline()) return "none";
	const health = await answerOrFallBack<ServerHealth>(
		reads.fetchHealth,
		{ state: "unreachable" },
		reads,
	);
	if (health.state === "draining") return "draining";
	if (health.state === "proxy_down") return "restarting";
	if (health.state === "unreachable") return "none";
	if (reads.versionWasLive) return "none";
	const changed = await answerOrFallBack(reads.checkVersion, false, reads);
	return changed ? "new_version" : "none";
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
	/** The proxy answers instead of the app: the restart. A server that cannot be reached at all is not this. */
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
 * while the server drains and while the proxy answers instead of it, and the new
 * version is asked for each time, so the Refresh notice comes up within seconds
 * of the restart. The watch ends when the new version is live, after 8 minutes, or
 * after a minute of a server that answers, is not draining and runs this version
 * (a false alarm).
 *
 * Each read is bounded (the same five seconds as a health request): a version
 * fetch that never answers must not stop the watch for good, which it would if the
 * next look waited for it.
 *
 * It owns nothing the page draws: `onLook` and `onEnd` tell the layout, which owns
 * the banner and the notice. A sign while it watches starts its clock again.
 */
export function createServerUpdateWatch(
	deps: {
		fetchHealth: () => Promise<ServerHealth>;
		checkVersion: () => Promise<boolean>;
		now: () => number;
		onLook: (look: ServerUpdateLook) => void;
		onEnd: (end: ServerUpdateWatchEnd) => void;
	} & Timers,
) {
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
			answerOrFallBack<ServerHealth>(
				deps.fetchHealth,
				{ state: "unreachable" },
				deps,
			),
			answerOrFallBack(deps.checkVersion, false, deps),
		]);
		// Stopped while the look was out.
		if (!watching) return;
		const now = deps.now();
		deps.onLook({
			draining: health.state === "draining",
			away: health.state === "proxy_down",
			versionChanged,
		});
		if (versionChanged) return finish("update_ready");
		const calm = health.state === "up";
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
