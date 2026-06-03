import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAdmin } from '$lib/server/auth/hooks';
import {
	deleteProviderModel,
	updateProviderModel,
} from '$lib/server/services/provider-models';
import type { UpdateProviderModelInput } from '$lib/server/services/provider-models';

export const PUT: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;

		let body: Record<string, unknown>;
		try {
			body = await event.request.json();
		} catch {
			return json({ error: 'Invalid JSON' }, { status: 400 });
		}

		const input: UpdateProviderModelInput = {};

		if (body.displayName !== undefined) {
			if (typeof body.displayName !== 'string') {
				return json({ error: 'displayName must be a string' }, { status: 400 });
			}
			input.displayName = body.displayName.trim();
		}

		if (body.maxModelContext !== undefined) {
			if (body.maxModelContext === null) {
				input.maxModelContext = null;
			} else if (
				typeof body.maxModelContext !== 'number' ||
				body.maxModelContext < 0
			) {
				return json(
					{ error: 'maxModelContext must be a non-negative number or null' },
					{ status: 400 },
				);
			} else {
				input.maxModelContext = body.maxModelContext;
			}
		}

		if (body.compactionUiThreshold !== undefined) {
			if (body.compactionUiThreshold === null) {
				input.compactionUiThreshold = null;
			} else if (
				typeof body.compactionUiThreshold !== 'number' ||
				body.compactionUiThreshold < 0
			) {
				return json(
					{ error: 'compactionUiThreshold must be a non-negative number or null' },
					{ status: 400 },
				);
			} else {
				input.compactionUiThreshold = body.compactionUiThreshold;
			}
		}

		if (body.targetConstructedContext !== undefined) {
			if (body.targetConstructedContext === null) {
				input.targetConstructedContext = null;
			} else if (
				typeof body.targetConstructedContext !== 'number' ||
				body.targetConstructedContext < 0
			) {
				return json(
					{ error: 'targetConstructedContext must be a non-negative number or null' },
					{ status: 400 },
				);
			} else {
				input.targetConstructedContext = body.targetConstructedContext;
			}
		}

		if (body.maxMessageLength !== undefined) {
			if (body.maxMessageLength === null) {
				input.maxMessageLength = null;
			} else if (
				typeof body.maxMessageLength !== 'number' ||
				body.maxMessageLength < 0
			) {
				return json(
					{ error: 'maxMessageLength must be a non-negative number or null' },
					{ status: 400 },
				);
			} else {
				input.maxMessageLength = body.maxMessageLength;
			}
		}

		if (body.maxTokens !== undefined) {
			if (body.maxTokens === null) {
				input.maxTokens = null;
			} else if (
				typeof body.maxTokens !== 'number' ||
				body.maxTokens < 0
			) {
				return json(
					{ error: 'maxTokens must be a non-negative number or null' },
					{ status: 400 },
				);
			} else {
				input.maxTokens = body.maxTokens;
			}
		}

		if (body.reasoningEffort !== undefined) {
			if (typeof body.reasoningEffort !== 'string') {
				return json(
					{ error: 'reasoningEffort must be a string' },
					{ status: 400 },
				);
			}
			input.reasoningEffort = body.reasoningEffort || null;
		}

		if (body.thinkingType !== undefined) {
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

		const model = await updateProviderModel(modelId, input);

		if (!model) {
			return json({ error: 'Model not found' }, { status: 404 });
		}

		return json({ model });
	} catch (error) {
		console.error('[ADMIN] Failed to update provider model:', error);
		return json(
			{ error: 'Failed to update provider model' },
			{ status: 500 },
		);
	}
};

export const DELETE: RequestHandler = async (event) => {
	try {
		requireAdmin(event);
		const { modelId } = event.params;

		const deleted = await deleteProviderModel(modelId);

		if (!deleted) {
			return json({ error: 'Model not found' }, { status: 404 });
		}

		return json({ success: true });
	} catch (error) {
		console.error('[ADMIN] Failed to delete provider model:', error);
		return json(
			{ error: 'Failed to delete provider model' },
			{ status: 500 },
		);
	}
};
