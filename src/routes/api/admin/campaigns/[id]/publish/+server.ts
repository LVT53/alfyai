import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { publishCampaign } from '$lib/server/services/announcement-campaigns';
import { campaignErrorResponse } from '../../_shared';

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		const campaign = await publishCampaign(event.params.id, event.locals.user!.id);
		return json({ campaign });
	} catch (error) {
		return campaignErrorResponse(error, 'Failed to publish campaign.');
	}
};
