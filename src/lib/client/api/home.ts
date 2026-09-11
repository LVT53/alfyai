import type {
	HomeSuggestion,
	HomeSuggestionEventKind,
} from "$lib/server/services/home-suggestions";
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
	HomeSuggestion,
	HomeSummary,
	HomeWeeklyBucket,
};

/** What the home screen draws when the summary has not arrived (or failed). */
export const EMPTY_HOME_SUMMARY: HomeSummary = {
	weekly: [],
	weeklyTotal: 0,
	recent: [],
	running: null,
	suggestions: [],
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
		suggestions: Array.isArray(response.suggestions)
			? response.suggestions
			: [],
		generatedAt:
			typeof response.generatedAt === "number" ? response.generatedAt : 0,
	};
}

/**
 * Records that a suggestion was used or dismissed, which drops it out of the
 * rail for seven days. Fire-and-forget: the home screen has already navigated
 * by the time this resolves, and a failed write only means a chip the user
 * already acted on may come back.
 *
 * `keepalive` is the whole reason the "used" half of that ever lands. Picking a
 * chip sends a message and hands the landing page to `window.location.assign`
 * one tick later, and a browser cancels the document's in-flight fetches when
 * it navigates — so without this the event that the ranking's demotion is built
 * on would be dropped exactly when it is earned. The body is two short strings,
 * far inside the 64 KB a keepalive request is allowed.
 */
export async function recordHomeSuggestionEvent(
	candidateKey: string,
	event: HomeSuggestionEventKind,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestJson(
		"/api/home/summary",
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ candidateKey, event }),
			keepalive: true,
		},
		"Failed to record suggestion event",
		fetchImpl,
	);
}
