import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import { batchCreateProviderModels } from '$lib/server/services/provider-models';

export const POST: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		if (!Array.isArray(body.models)) {
			return json(
				{ error: 'models must be an array' },
				{ status: 400 },
			);
		}

		const entries = body.models as Array<Record<string, unknown>>;

		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			if (typeof entry.name !== 'string' || !entry.name.trim()) {
				return json(
					{ error: `models[${i}].name is required and must be a non-empty string` },
					{ status: 400 },
				);
			}
			if (
				entry.displayName !== undefined &&
				typeof entry.displayName !== 'string'
			) {
				return json(
					{ error: `models[${i}].displayName must be a string` },
					{ status: 400 },
				);
			}
		}

		const models = await batchCreateProviderModels(
			id,
			entries.map((e) => ({
				name: (e.name as string).trim(),
				displayName:
					typeof e.displayName === 'string'
						? e.displayName.trim()
						: undefined,
			})),
		);

		return json({ models }, { status: 201 });
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes('does not exist')
		) {
			return json({ error: error.message }, { status: 404 });
		}
		console.error('[ADMIN] Failed to batch create provider models:', error);
		return json(
			{ error: 'Failed to batch create provider models' },
			{ status: 500 },
		);
	}
};
