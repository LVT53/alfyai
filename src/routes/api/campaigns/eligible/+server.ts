import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getEligibleCampaignForUser } from "$lib/server/services/announcement-campaigns";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const campaign = await getEligibleCampaignForUser(event.locals.user?.id);
	return json({ campaign });
};
