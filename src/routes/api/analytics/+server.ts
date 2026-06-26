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
	});

	return json(readModel);
};
