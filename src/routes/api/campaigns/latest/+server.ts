import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { getLatestPublishedCampaign } from '$lib/server/services/announcement-campaigns';

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	return json({ campaign: await getLatestPublishedCampaign() });
};
