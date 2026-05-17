import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { archiveCampaign } from '$lib/server/services/announcement-campaigns';
import { campaignErrorResponse } from '../../_shared';

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		const campaign = await archiveCampaign(event.params.id);
		return json({ campaign });
	} catch (error) {
		return campaignErrorResponse(error, 'Failed to archive campaign.');
	}
};
