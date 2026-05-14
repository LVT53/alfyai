import { getConfig } from '$lib/server/config-store';
import { getConversation } from '$lib/server/services/conversations';
import {
	assertPromptReadyAttachments,
	isAttachmentReadinessError,
} from '$lib/server/services/knowledge';
import {
	addConversationLinkedContextSources,
	isLinkedContextSourceError,
} from '$lib/server/services/linked-context-sources';
import { resolveSkillPromptContext } from '$lib/server/services/skills/prompt-context';
import { getAvailableSkillSummary } from '$lib/server/services/skills/user-skills';
import type {
	ChatTurnRequestError,
	ParsedChatTurnRequest,
	PreflightedChatTurn,
} from './types';

type PreflightResult =
	| { ok: true; value: PreflightedChatTurn }
	| { ok: false; error: ChatTurnRequestError };

export async function preflightChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<PreflightResult> {
	const { userId, request } = params;
	let resolvedLinkedSources = request.linkedSources;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return { ok: false, error: { status: 404, error: 'Conversation not found' } };
	}

	if (request.attachmentIds.length > 0) {
		try {
			await assertPromptReadyAttachments({
				userId,
				conversationId: request.conversationId,
				attachmentIds: request.attachmentIds,
				traceId: request.attachmentTraceId,
			});
		} catch (error) {
			if (isAttachmentReadinessError(error)) {
				return {
					ok: false,
					error: {
						status: error.status,
						error: error.message,
						code: error.code,
						attachmentIds: error.attachmentIds,
					},
				};
			}
			throw error;
		}
	}

	if (!request.deepResearchDepth && request.linkedSources.length > 0) {
		if (!getConfig().composerCommandRegistryEnabled) {
			return {
				ok: false,
				error: {
					status: 403,
					error: 'Composer Command Registry is disabled.',
					code: 'composer_commands_disabled',
				},
			};
		}
		try {
			resolvedLinkedSources = await addConversationLinkedContextSources({
				userId,
				conversationId: request.conversationId,
				linkedSources: request.linkedSources,
				attachmentIds: request.attachmentIds,
			});
		} catch (error) {
			if (isLinkedContextSourceError(error)) {
				return {
					ok: false,
					error: {
						status: error.status,
						error: error.message,
						code: error.code,
					},
				};
			}
			throw error;
		}
	}

	if (!request.deepResearchDepth && request.pendingSkill) {
		if (!getConfig().composerCommandRegistryEnabled) {
			return {
				ok: false,
				error: {
					status: 403,
					error: 'Composer Command Registry is disabled.',
					code: 'composer_commands_disabled',
				},
			};
		}
		const availableSkill = await getAvailableSkillSummary(userId, {
			id: request.pendingSkill.id,
			ownership: request.pendingSkill.ownership,
		});
		if (!availableSkill) {
			return {
				ok: false,
				error: {
					status: 409,
					error: 'Selected skill is no longer available.',
					code: 'pending_skill_unavailable',
				},
			};
		}
	}

	return {
		ok: true,
		value: {
			...request,
			linkedSources: resolvedLinkedSources,
			skillPromptContext: await resolveSkillPromptContext({
				userId,
				turn: {
					...request,
					linkedSources: resolvedLinkedSources,
				},
			}),
		},
	};
}
