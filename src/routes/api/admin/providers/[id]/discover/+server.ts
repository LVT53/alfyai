import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { decryptApiKey, getProviderWithSecrets, modelDiscovery } from '$lib/server/services/providers';

export const POST: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		const provider = await getProviderWithSecrets(id);

		if (!provider) {
			return json({ error: 'Provider not found' }, { status: 404 });
		}

		let apiKey: string;
		try {
			apiKey = decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv);
		} catch {
			return json({ error: 'Failed to decrypt API key' }, { status: 500 });
		}

		const models = await modelDiscovery(provider.baseUrl, apiKey);
		return json({ models });
	} catch (error) {
		if (error instanceof Error) {
			if (error.message === 'Invalid API key') {
				return json({ error: 'Invalid API key' }, { status: 400 });
			}
			if (error.message.startsWith('Model discovery endpoint')) {
				return json({ error: error.message }, { status: 400 });
			}
			if (error.message.startsWith('Model discovery')) {
				return json({ error: error.message }, { status: 502 });
			}
		}
		console.error('[ADMIN] Failed to discover models:', error);
		return json({ error: 'Failed to discover models' }, { status: 500 });
	}
};
