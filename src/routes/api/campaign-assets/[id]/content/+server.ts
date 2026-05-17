import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import { getCampaignAssetForServing } from '$lib/server/services/campaign-assets';

export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	const result = await getCampaignAssetForServing(event.params.id, {
		id: event.locals.user!.id,
		role: event.locals.user!.role,
	});

	if (!result.ok) {
		return json({ error: result.error }, { status: result.status });
	}

	return new Response(new Uint8Array(result.content), {
		status: 200,
		headers: {
			'Content-Type': result.asset.mimeType,
			'Content-Length': result.content.length.toString(),
			'Cache-Control': 'private, max-age=300',
		},
	});
};
