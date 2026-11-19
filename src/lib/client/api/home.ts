import type {
	HomeProjectCard,
	HomeRecentConversation,
	HomeRunningJob,
	HomeSummary,
	HomeWeeklyBucket,
} from "$lib/server/services/home-summary";
import { type FetchLike, requestJson } from "./http";

export type {
	HomeProjectCard,
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
	projects: [],
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
		// An older server that does not send `projects` yet, or a truncated body,
		// leaves the row empty rather than undefined — the surface indexes into it.
		projects: Array.isArray(response.projects) ? response.projects : [],
		memoryReviewCount:
			typeof response.memoryReviewCount === "number"
				? response.memoryReviewCount
				: 0,
		memoryReviewNoticeDismissed: response.memoryReviewNoticeDismissed === true,
		generatedAt:
			typeof response.generatedAt === "number" ? response.generatedAt : 0,
	};
}
