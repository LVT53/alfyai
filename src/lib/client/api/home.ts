import type {
	HomeRecentConversation,
	HomeRunningJob,
	HomeSummary,
	HomeWeeklyBucket,
} from "$lib/server/services/home-summary";
import { type FetchLike, requestJson } from "./http";

export type {
	HomeRecentConversation,
	HomeRunningJob,
	HomeSummary,
	HomeWeeklyBucket,
};

/** What the home screen draws when the summary has not arrived (or failed). */
export const EMPTY_HOME_SUMMARY: HomeSummary = {
	weekly: [],
	weeklyTotal: 0,
	recent: [],
	running: null,
	memoryReviewCount: 0,
	memoryReviewNoticeDismissed: false,
	generatedAt: 0,
};

export async function fetchHomeSummary(
	fetchImpl: FetchLike = fetch,
): Promise<HomeSummary> {
	const response = await requestJson<Partial<HomeSummary>>(
		"/api/home/summary",
		undefined,
		"Failed to load home summary",
		fetchImpl,
	);
	return {
		weekly: Array.isArray(response.weekly) ? response.weekly : [],
		weeklyTotal:
			typeof response.weeklyTotal === "number" ? response.weeklyTotal : 0,
		recent: Array.isArray(response.recent) ? response.recent : [],
		running: response.running ?? null,
		memoryReviewCount:
			typeof response.memoryReviewCount === "number"
				? response.memoryReviewCount
				: 0,
		memoryReviewNoticeDismissed: response.memoryReviewNoticeDismissed === true,
		generatedAt:
			typeof response.generatedAt === "number" ? response.generatedAt : 0,
	};
}

/**
 * Dismisses the home "memories need review" notice for the signed-in user.
 * Fire-and-forget-ish: callers should also hide the notice locally right away
 * rather than waiting on this to resolve, since the point of the click is an
 * immediate response.
 *
 * `keepalive` is what lets that write survive the click that usually follows a
 * dismissal — a browser cancels a document's in-flight fetches when it
 * navigates, and the dismissal is worth nothing if it dies with the page. The
 * body is one short action name, far inside the 64 KB a keepalive request is
 * allowed.
 */
export async function dismissMemoryReviewNotice(
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson(
		"/api/home/summary",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "dismissMemoryReviewNotice" }),
			keepalive: true,
		},
		"Failed to dismiss memory review notice",
		fetchImpl,
	);
}
