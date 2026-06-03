import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { clearProvidersCache, refreshConfig } from '$lib/server/config-store';
import {
	deleteProvider,
	updateProvider,
	type UpdateProviderInput,
} from '$lib/server/services/providers';

export const PUT: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		const input: UpdateProviderInput = {};

		if (body.displayName !== undefined) {
			if (typeof body.displayName !== 'string') {
				return json({ error: 'displayName must be a string' }, { status: 400 });
			}
			input.displayName = body.displayName.trim();
		}

		if (body.baseUrl !== undefined) {
			if (typeof body.baseUrl !== 'string') {
				return json({ error: 'baseUrl must be a string' }, { status: 400 });
			}
			input.baseUrl = body.baseUrl.trim();
		}

		if (body.apiKey !== undefined) {
			if (typeof body.apiKey !== 'string') {
				return json({ error: 'apiKey must be a string' }, { status: 400 });
			}
			input.apiKey = body.apiKey;
		}

		if (body.iconAssetId !== undefined) {
			input.iconAssetId =
				typeof body.iconAssetId === 'string' && body.iconAssetId.trim()
					? body.iconAssetId.trim()
					: null;
		}

		if (body.rateLimitFallbackEnabled !== undefined) {
			if (typeof body.rateLimitFallbackEnabled !== 'boolean') {
				return json(
					{ error: 'rateLimitFallbackEnabled must be a boolean' },
					{ status: 400 },
				);
			}
			input.rateLimitFallbackEnabled = body.rateLimitFallbackEnabled;
		}

		if (body.rateLimitFallbackBaseUrl !== undefined) {
			input.rateLimitFallbackBaseUrl =
				typeof body.rateLimitFallbackBaseUrl === 'string'
					? body.rateLimitFallbackBaseUrl.trim()
					: null;
		}

		if (body.rateLimitFallbackApiKey !== undefined) {
			input.rateLimitFallbackApiKey =
				typeof body.rateLimitFallbackApiKey === 'string'
					? body.rateLimitFallbackApiKey
					: null;
		}

		if (body.rateLimitFallbackModelName !== undefined) {
			input.rateLimitFallbackModelName =
				typeof body.rateLimitFallbackModelName === 'string'
					? body.rateLimitFallbackModelName.trim()
					: null;
		}

		if (body.rateLimitFallbackTimeoutMs !== undefined) {
			if (
				typeof body.rateLimitFallbackTimeoutMs !== 'number' ||
				body.rateLimitFallbackTimeoutMs < 0
			) {
				return json(
					{ error: 'rateLimitFallbackTimeoutMs must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.rateLimitFallbackTimeoutMs = body.rateLimitFallbackTimeoutMs;
		}

		if (body.sortOrder !== undefined) {
			if (typeof body.sortOrder !== 'number') {
				return json({ error: 'sortOrder must be a number' }, { status: 400 });
			}
			input.sortOrder = body.sortOrder;
		}

		if (body.enabled !== undefined) {
			if (typeof body.enabled !== 'boolean') {
				return json({ error: 'enabled must be a boolean' }, { status: 400 });
			}
			input.enabled = body.enabled;
		}

		const provider = await updateProvider(id, input);

		if (!provider) {
			return json({ error: 'Provider not found' }, { status: 404 });
		}

		clearProvidersCache();
		await refreshConfig();
		return json({ provider });
	} catch (error) {
		console.error('[ADMIN] Failed to update provider:', error);
		return json({ error: 'Failed to update provider' }, { status: 500 });
	}
};

export const DELETE: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		const deleted = await deleteProvider(id);

		if (!deleted) {
			return json({ error: 'Provider not found' }, { status: 404 });
		}

		clearProvidersCache();
		await refreshConfig();
		return json({ success: true });
	} catch (error) {
		console.error('[ADMIN] Failed to delete provider:', error);
		return json({ error: 'Failed to delete provider' }, { status: 500 });
	}
};
