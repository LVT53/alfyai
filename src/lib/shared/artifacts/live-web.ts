/**
 * What a live-web block and the reads behind it agree on, declared once: how
 * long a snapshot counts as live, and the reasons a web read on a board's behalf
 * can refuse with. Client-safe (no import), because the block that shows a
 * snapshot's age, the client call that reads the answer and the server that
 * gives it must not each keep their own copy of a number or a word.
 */

/**
 * How long a snapshot is called live. A search's answer is what the web said when
 * it was asked; an hour on, a price or a headline may have moved, so the block
 * says "not live" and offers a refresh. It is a label on a snapshot, never a
 * reason to refresh on its own: a refresh is a search the reader asked for.
 */
export const LIVEWEB_FRESH_MS = 60 * 60 * 1000;

/** Whether a snapshot taken at `fetchedAt` (epoch ms) is past its window. A time that cannot be read is not live. */
export function isLiveWebStale(
	fetchedAt: number,
	now: number = Date.now(),
): boolean {
	if (!Number.isFinite(fetchedAt)) return true;
	return now - fetchedAt > LIVEWEB_FRESH_MS;
}

/**
 * Why a web read on a board's behalf (a refresh, or a new search) answered
 * nothing: the board or block is not there for this reader; the block is not one
 * that can be refreshed; the search failed or found nothing; the query cannot be
 * searched; or the reader has asked too often.
 */
const CANVAS_WEB_FAILURES = [
	"not_found",
	"not_refreshable",
	"refresh_failed",
	"no_results",
	"invalid_query",
	"rate_limited",
] as const;

export type CanvasWebFailure = (typeof CANVAS_WEB_FAILURES)[number];

export function isCanvasWebFailure(value: unknown): value is CanvasWebFailure {
	return (
		typeof value === "string" &&
		(CANVAS_WEB_FAILURES as readonly string[]).includes(value)
	);
}
