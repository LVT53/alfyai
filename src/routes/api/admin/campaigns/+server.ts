import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import {
	createCampaignDraft,
	listCampaigns,
} from '$lib/server/services/announcement-campaigns';
import { campaignErrorResponse } from './_shared';

export const GET: RequestHandler = async (event) => {
	requireAdmin(event);
	return json({ campaigns: await listCampaigns() });
};

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	const body = await event.request.json().catch(() => ({}));
	try {
		const campaign = await createCampaignDraft({
			type: body?.type,
			releaseVersion: body?.releaseVersion,
			name: body?.name,
			createdByUserId: event.locals.user!.id,
		});
		return json({ campaign }, { status: 201 });
	} catch (error) {
		return campaignErrorResponse(error, 'Failed to create campaign draft.');
	}
};
