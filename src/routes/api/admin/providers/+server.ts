import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { refreshConfig } from '$lib/server/config-store';
import {
	createProvider,
	listProviders,
	validateProviderConnection,
	validateProviderName,
} from '$lib/server/services/providers';

export const GET: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const providers = await listProviders();
		return json({ providers });
	} catch (error) {
		console.error('[ADMIN] Failed to list providers:', error);
		return json({ error: 'Failed to list providers' }, { status: 500 });
	}
};

export const POST: RequestHandler = async (event) => {
	try {
		requireAdmin(event);

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		const name = typeof body.name === 'string' ? body.name.trim() : '';
		const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
		const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim() : '';
		const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';

		if (!name || !displayName || !baseUrl || !apiKey) {
			return json(
				{ error: 'name, displayName, baseUrl, and apiKey are required' },
				{ status: 400 },
			);
		}

		if (!validateProviderName(name)) {
			return json(
				{ error: 'Name must contain only letters, numbers, underscores, and hyphens' },
				{ status: 400 },
			);
		}

		const connectionTest = await validateProviderConnection(baseUrl, apiKey);
		const connectionWarning = connectionTest.valid ? null : connectionTest.error ?? null;

		const provider = await createProvider({
			name,
			displayName,
			baseUrl,
			apiKey,
			iconAssetId:
				typeof body.iconAssetId === 'string' && body.iconAssetId.trim()
					? body.iconAssetId.trim()
					: null,
			rateLimitFallbackEnabled:
				typeof body.rateLimitFallbackEnabled === 'boolean'
					? body.rateLimitFallbackEnabled
					: undefined,
			rateLimitFallbackBaseUrl:
				typeof body.rateLimitFallbackBaseUrl === 'string'
					? body.rateLimitFallbackBaseUrl.trim()
					: undefined,
			rateLimitFallbackApiKey:
				typeof body.rateLimitFallbackApiKey === 'string'
					? body.rateLimitFallbackApiKey
					: undefined,
			rateLimitFallbackModelName:
				typeof body.rateLimitFallbackModelName === 'string'
					? body.rateLimitFallbackModelName.trim()
					: undefined,
			rateLimitFallbackTimeoutMs:
				typeof body.rateLimitFallbackTimeoutMs === 'number'
					? body.rateLimitFallbackTimeoutMs
					: undefined,
			sortOrder:
				typeof body.sortOrder === 'number' ? body.sortOrder : undefined,
			enabled:
				typeof body.enabled === 'boolean' ? body.enabled : undefined,
		});

		await refreshConfig();
		return json({ provider, connectionWarning }, { status: 201 });
	} catch (error) {
		if (error instanceof Error && error.message.includes('UNIQUE constraint')) {
			return json(
				{ error: 'A provider with this name already exists' },
				{ status: 409 },
			);
		}
		console.error('[ADMIN] Failed to create provider:', error);
		return json({ error: 'Failed to create provider' }, { status: 500 });
	}
};
