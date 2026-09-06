import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getAnalyticsExcludedUserIds } from "$lib/server/config-store";
import { getAnalyticsDashboardReadModel } from "$lib/server/services/analytics";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);

	const readModel = await getAnalyticsDashboardReadModel({
		user: event.locals.user,
		mock: event.url.searchParams.get("mock") === "1",
		month: event.url.searchParams.get("month"),
		systemMonth: event.url.searchParams.get("systemMonth"),
		timeline: event.url.searchParams.get("timeline"),
		excludedUserIds: getAnalyticsExcludedUserIds(),
		// Analytics overhaul (backend half) — admin-only narrowing filters;
		// getAnalyticsDashboardReadModel ignores them for a non-admin caller.
		userId: event.url.searchParams.get("userId"),
		modelId: event.url.searchParams.get("modelId"),
		providerId: event.url.searchParams.get("providerId"),
	});

	return json(readModel);
};
