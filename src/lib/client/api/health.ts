import type { FetchLike } from "./http";

/**
 * What `/api/health` says of the server this page is served by: whether it
 * answers at all, and whether it is draining for a deploy restart (it still
 * answers, and turns new messages away). The app's own words for an update in
 * progress read it: the shell's banner and its watch, and a message that waits
 * for the update (`normal-chat-client-turn-runtime.ts`).
 */
export type ServerHealth = {
	reachable: boolean;
	draining: boolean;
};

const UNREACHABLE: ServerHealth = { reachable: false, draining: false };

/** An answer that has not come by now is no answer: a stalled request must not hold a poll back. */
export const HEALTH_REQUEST_MAX_MS = 5000;

/**
 * Reads `/api/health` once. `reachable` is false when the request fails or does
 * not answer in time, when the status is not OK, and when the body is not the
 * health JSON: during the restart the reverse proxy answers its own maintenance
 * page (a 503 with HTML), and that is the server being away, not a server that is
 * well.
 *
 * Plain `fetch`, deliberately not the wrapper in `http.ts`. The route is public,
 * so a 200 from it says nothing about this tab's session, and the wrapper reads
 * every success as "the session works" (`observeSessionFromResponse` takes down
 * the shell's signed-out row). A health check must not do that.
 */
export async function fetchServerHealth(
	fetchImpl: FetchLike = fetch,
): Promise<ServerHealth> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HEALTH_REQUEST_MAX_MS);
	try {
		const response = await fetchImpl("/api/health", {
			cache: "no-store",
			signal: controller.signal,
		});
		if (!response.ok) return UNREACHABLE;
		const body: unknown = await response.json();
		if (!isHealthBody(body)) return UNREACHABLE;
		return { reachable: true, draining: body.draining === true };
	} catch {
		return UNREACHABLE;
	} finally {
		clearTimeout(timer);
	}
}

/** `{ "status": "OK", ... }`: the legacy shape that `deploy/README.md` documents, `draining` and `activeStreams` beside it. */
function isHealthBody(
	value: unknown,
): value is { status: "OK"; draining?: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { status?: unknown }).status === "OK"
	);
}
