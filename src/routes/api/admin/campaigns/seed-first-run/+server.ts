import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { seedFirstRunOnboardingTemplate } from '$lib/server/services/announcement-campaigns';
import { campaignErrorResponse } from '../_shared';

export const POST: RequestHandler = async (event) => {
	requireAdmin(event);
	try {
		const result = await seedFirstRunOnboardingTemplate(event.locals.user!.id);
		return json(result, { status: result.created ? 201 : 200 });
	} catch (error) {
		return campaignErrorResponse(error, 'Failed to seed first-run onboarding template.');
	}
};
