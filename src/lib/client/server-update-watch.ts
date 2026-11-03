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
