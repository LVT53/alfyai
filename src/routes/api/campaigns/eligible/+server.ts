import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { getEligibleCampaignForUser } from '$lib/server/services/announcement-campaigns';

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const campaign = await getEligibleCampaignForUser(event.locals.user!.id);
	return json({ campaign });
};
