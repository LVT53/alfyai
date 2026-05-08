import { createAttachmentTraceId } from '$lib/server/services/attachment-trace';
import {
	getProviderById,
	normalizeModelSelection,
	getMaxMessageLength,
	type RuntimeConfig,
} from '$lib/server/config-store';
import type { DeepResearchDepth, ModelId, ThinkingMode } from '$lib/types';
import type {
	ChatTurnRequestError,
	ChatTurnRoute,
	ParsedChatTurnRequest,
} from './types';

type ParseResult =
	| { ok: true; value: ParsedChatTurnRequest }
	| { ok: false; error: ChatTurnRequestError };

type RequestBody = {
	message?: unknown;
	userMessage?: unknown;
	conversationId?: unknown;
	streamId?: unknown;
	model?: unknown;
	skipPersistUserMessage?: unknown;
	attachmentIds?: unknown;
	activeDocumentArtifactId?: unknown;
	personalityProfileId?: unknown;
	deepResearch?: unknown;
	deepResearchDepth?: unknown;
	thinkingMode?: unknown;
};

export async function parseChatTurnRequest(
	request: Request,
	runtimeConfig: RuntimeConfig,
	route: ChatTurnRoute
): Promise<ParseResult> {
	let body: RequestBody;
	try {
		body = await request.json();
	} catch {
		return { ok: false, error: { status: 400, error: 'Invalid JSON body' } };
	}

	const {
		message,
		userMessage,
		conversationId,
		streamId,
		model,
		skipPersistUserMessage,
		attachmentIds,
		activeDocumentArtifactId,
		personalityProfileId,
		deepResearch,
		deepResearchDepth,
		thinkingMode,
	} = body;

	// Allow empty message when reconnecting to an existing stream (streamId provided)
	const isReconnect = typeof streamId === 'string' && streamId.trim().length > 0;

	const rawMessage = isReconnect && typeof userMessage === 'string' ? userMessage : message;
	const normalizedMessage = typeof rawMessage === 'string' ? rawMessage.trim() : '';

	if (!isReconnect && normalizedMessage.length === 0) {
		return {
			ok: false,
			error: { status: 400, error: 'Message must be a non-empty string' },
		};
	}
	// Message length validation deferred to after model resolution below
	// (per-model maxMessageLength may differ from global)

	if (typeof conversationId !== 'string' || conversationId.trim().length === 0) {
		return { ok: false, error: { status: 400, error: 'conversationId is required' } };
	}

	let modelId: ModelId | undefined;
	let modelDisplayName: string;
	let resolvedMaxMessageLength: number | null = null;

	const modelStr = typeof model === 'string' ? model.trim() : '';

	if (modelStr === 'model1' || modelStr === 'model2') {
		modelId = normalizeModelSelection(modelStr, runtimeConfig);
		modelDisplayName =
			modelId === 'model2' ? runtimeConfig.model2.displayName : runtimeConfig.model1.displayName;
	} else if (modelStr.startsWith('provider:')) {
		const providerId = modelStr.slice('provider:'.length);
		if (providerId.length > 0) {
			const provider = await getProviderById(providerId);
			if (!provider || !provider.enabled) {
				return {
					ok: false,
					error: { status: 400, error: 'Selected provider model is not available' },
				};
			}
			modelId = modelStr as ModelId;
			modelDisplayName = provider.displayName;
			resolvedMaxMessageLength = provider.maxMessageLength;
		} else {
			modelId = undefined;
			modelDisplayName = runtimeConfig.model1.displayName;
		}
	} else if (modelStr !== '') {
		modelId = undefined;
		modelDisplayName = runtimeConfig.model1.displayName;
	} else {
		modelId = 'model1';
		modelDisplayName = runtimeConfig.model1.displayName;
	}

	// Per-model message length check
	const maxLen = resolvedMaxMessageLength ?? getMaxMessageLength(modelId);
	if (normalizedMessage.length > maxLen) {
		return {
			ok: false,
			error: {
				status: 400,
				error: `Message exceeds maximum length of ${maxLen} characters`,
			},
		};
	}

	const safeAttachmentIds = Array.isArray(attachmentIds)
		? attachmentIds.filter((id): id is string => typeof id === 'string')
		: [];
	const selectedDeepResearchDepth = parseDeepResearchDepth(deepResearch, deepResearchDepth);
	const selectedThinkingMode = parseThinkingMode(thinkingMode);

	return {
		ok: true,
		value: {
			conversationId,
			normalizedMessage,
			streamId:
				typeof streamId === 'string' && streamId.trim().length > 0
					? streamId.trim()
					: undefined,
			modelId,
			modelDisplayName,
			attachmentIds: safeAttachmentIds,
			activeDocumentArtifactId:
				typeof activeDocumentArtifactId === 'string' && activeDocumentArtifactId.trim().length > 0
					? activeDocumentArtifactId.trim()
					: undefined,
			personalityProfileId:
				typeof personalityProfileId === 'string' && personalityProfileId.trim().length > 0
					? personalityProfileId.trim()
					: undefined,
			deepResearchDepth: selectedDeepResearchDepth,
			thinkingMode: selectedThinkingMode,
			skipPersistUserMessage: skipPersistUserMessage === true,
			attachmentTraceId:
				safeAttachmentIds.length > 0 ? createAttachmentTraceId(route) : undefined,
		},
	};
}

function parseDeepResearchDepth(
	deepResearch: unknown,
	deepResearchDepth: unknown
): DeepResearchDepth | undefined {
	const directDepth = typeof deepResearchDepth === 'string' ? deepResearchDepth.trim() : '';
	if (isDeepResearchDepth(directDepth)) return directDepth;

	if (typeof deepResearch !== 'object' || deepResearch === null) return undefined;
	const maybeDepth = (deepResearch as { depth?: unknown }).depth;
	const nestedDepth = typeof maybeDepth === 'string' ? maybeDepth.trim() : '';
	return isDeepResearchDepth(nestedDepth) ? nestedDepth : undefined;
}

function isDeepResearchDepth(value: string): value is DeepResearchDepth {
	return value === 'focused' || value === 'standard' || value === 'max';
}

function parseThinkingMode(value: unknown): ThinkingMode {
	return value === 'on' || value === 'off' || value === 'auto' ? value : 'auto';
}
