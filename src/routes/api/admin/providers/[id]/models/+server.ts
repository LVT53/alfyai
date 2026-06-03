import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import {
	createProviderModel,
	listProviderModels,
} from '$lib/server/services/provider-models';
import type { CreateProviderModelInput } from '$lib/server/services/provider-models';

export const GET: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { id } = event.params;
		const models = await listProviderModels(id);
		return json({ models });
	} catch (error) {
		console.error('[ADMIN] Failed to list provider models:', error);
		return json({ error: 'Failed to list provider models' }, { status: 500 });
	}
};

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

		const name = typeof body.name === 'string' ? body.name.trim() : '';

		if (!name) {
			return json({ error: 'name is required' }, { status: 400 });
		}

		const input: CreateProviderModelInput = {
			providerId: id,
			name,
		};

		if (body.displayName !== undefined) {
			if (typeof body.displayName !== 'string') {
				return json({ error: 'displayName must be a string' }, { status: 400 });
			}
			input.displayName = body.displayName.trim();
		}

		if (body.maxModelContext !== undefined) {
			if (typeof body.maxModelContext !== 'number' || body.maxModelContext < 0) {
				return json(
					{ error: 'maxModelContext must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.maxModelContext = body.maxModelContext;
		}

		if (body.compactionUiThreshold !== undefined) {
			if (
				typeof body.compactionUiThreshold !== 'number' ||
				body.compactionUiThreshold < 0
			) {
				return json(
					{ error: 'compactionUiThreshold must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.compactionUiThreshold = body.compactionUiThreshold;
		}

		if (body.targetConstructedContext !== undefined) {
			if (
				typeof body.targetConstructedContext !== 'number' ||
				body.targetConstructedContext < 0
			) {
				return json(
					{ error: 'targetConstructedContext must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.targetConstructedContext = body.targetConstructedContext;
		}

		if (body.maxMessageLength !== undefined) {
			if (typeof body.maxMessageLength !== 'number' || body.maxMessageLength < 0) {
				return json(
					{ error: 'maxMessageLength must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.maxMessageLength = body.maxMessageLength;
		}

		if (body.maxTokens !== undefined) {
			if (typeof body.maxTokens !== 'number' || body.maxTokens < 0) {
				return json(
					{ error: 'maxTokens must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.maxTokens = body.maxTokens;
		}

		if (body.reasoningEffort !== undefined && body.reasoningEffort !== null) {
			if (typeof body.reasoningEffort !== 'string') {
				return json(
					{ error: 'reasoningEffort must be a string' },
					{ status: 400 },
				);
			}
			input.reasoningEffort = body.reasoningEffort || null;
		}

		if (body.thinkingType !== undefined && body.thinkingType !== null) {
			if (typeof body.thinkingType !== 'string') {
				return json({ error: 'thinkingType must be a string' }, { status: 400 });
			}
			input.thinkingType = body.thinkingType || null;
		}

		if (body.capabilitiesJson !== undefined) {
			if (typeof body.capabilitiesJson !== 'string') {
				return json(
					{ error: 'capabilitiesJson must be a string' },
					{ status: 400 },
				);
			}
			input.capabilitiesJson = body.capabilitiesJson || null;
		}

		if (body.inputUsdMicrosPer1m !== undefined) {
			if (
				typeof body.inputUsdMicrosPer1m !== 'number' ||
				body.inputUsdMicrosPer1m < 0
			) {
				return json(
					{ error: 'inputUsdMicrosPer1m must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.inputUsdMicrosPer1m = body.inputUsdMicrosPer1m;
		}

		if (body.cachedInputUsdMicrosPer1m !== undefined) {
			if (
				typeof body.cachedInputUsdMicrosPer1m !== 'number' ||
				body.cachedInputUsdMicrosPer1m < 0
			) {
				return json(
					{ error: 'cachedInputUsdMicrosPer1m must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.cachedInputUsdMicrosPer1m = body.cachedInputUsdMicrosPer1m;
		}

		if (body.cacheHitUsdMicrosPer1m !== undefined) {
			if (
				typeof body.cacheHitUsdMicrosPer1m !== 'number' ||
				body.cacheHitUsdMicrosPer1m < 0
			) {
				return json(
					{ error: 'cacheHitUsdMicrosPer1m must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.cacheHitUsdMicrosPer1m = body.cacheHitUsdMicrosPer1m;
		}

		if (body.cacheMissUsdMicrosPer1m !== undefined) {
			if (
				typeof body.cacheMissUsdMicrosPer1m !== 'number' ||
				body.cacheMissUsdMicrosPer1m < 0
			) {
				return json(
					{ error: 'cacheMissUsdMicrosPer1m must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.cacheMissUsdMicrosPer1m = body.cacheMissUsdMicrosPer1m;
		}

		if (body.outputUsdMicrosPer1m !== undefined) {
			if (
				typeof body.outputUsdMicrosPer1m !== 'number' ||
				body.outputUsdMicrosPer1m < 0
			) {
				return json(
					{ error: 'outputUsdMicrosPer1m must be a non-negative number' },
					{ status: 400 },
				);
			}
			input.outputUsdMicrosPer1m = body.outputUsdMicrosPer1m;
		}

		if (body.enabled !== undefined) {
			if (typeof body.enabled !== 'boolean') {
				return json({ error: 'enabled must be a boolean' }, { status: 400 });
			}
			input.enabled = body.enabled;
		}

		if (body.sortOrder !== undefined) {
			if (typeof body.sortOrder !== 'number') {
				return json({ error: 'sortOrder must be a number' }, { status: 400 });
			}
			input.sortOrder = body.sortOrder;
		}

		const model = await createProviderModel(input);

		return json({ model }, { status: 201 });
	} catch (error) {
		if (
			error instanceof Error &&
			error.message.includes('does not exist')
		) {
			return json({ error: error.message }, { status: 404 });
		}
		console.error('[ADMIN] Failed to create provider model:', error);
		return json(
			{ error: 'Failed to create provider model' },
			{ status: 500 },
		);
	}
};
