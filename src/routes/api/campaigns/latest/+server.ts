import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getLatestPublishedCampaign } from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	// The version badge replays the release note. A published first-open tour
	// is a different campaign type and must never be what the badge opens.
	return json({ campaign: await getLatestPublishedCampaign("release_update") });
};
