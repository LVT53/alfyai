import { type FetchLike, GATEWAY_STATUSES } from "./http";

/**
 * What `/api/health` says of the server this page is served by, in the four ways
 * the app has to tell apart (rules: `src/lib/components/chat/AGENTS.md`, "An
 * Update During A Turn"):
 *
 * - `up`: the app answers and is not draining.
 * - `draining`: the app answers and is draining for a deploy restart. It is alive,
 *   finishes the replies it runs, and turns new messages away.
 * - `proxy_down`: the reverse proxy answered instead of the app (a 502, 503 or
 *   504 whose body is not the health JSON). The app process is away: a restart.
 * - `unreachable`: nothing says what the server is doing. The request failed or
 *   did not answer in time, or the answer is none of the above. A phone without
 *   signal looks like this too, and that is not an update.
 */
export type ServerHealthState =
	| "up"
	| "draining"
	| "proxy_down"
	| "unreachable";

export type ServerHealth = { state: ServerHealthState };

const UNREACHABLE: ServerHealth = { state: "unreachable" };

/** An answer that has not come by now is no answer: a stalled request must not hold a poll back. */
export const HEALTH_REQUEST_MAX_MS = 5000;

/**
 * Reads `/api/health` once. A 200 with the health JSON is `up` or `draining`. The
 * proxy's maintenance page, a 502, 503 or 504 with a body that is not the health
 * JSON, is `proxy_down`: the app is away, which is what a restart looks like. Every
 * other answer, a request that fails and one that does not answer in time are
 * `unreachable`: they say nothing of the server, and the caller must not take them
 * for an update.
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
		const body = await readJsonBody(response);
		if (isHealthBody(body)) {
			if (response.ok) {
				return { state: body.draining === true ? "draining" : "up" };
			}
			return UNREACHABLE;
		}
		return GATEWAY_STATUSES.has(response.status)
			? { state: "proxy_down" }
			: UNREACHABLE;
	} catch {
		return UNREACHABLE;
	} finally {
		clearTimeout(timer);
	}
}

async function readJsonBody(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return undefined;
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
