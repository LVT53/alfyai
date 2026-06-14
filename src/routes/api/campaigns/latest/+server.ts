import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getLatestPublishedCampaign } from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	return json({ campaign: await getLatestPublishedCampaign() });
};
