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
import { startSkillSession } from '$lib/server/services/skills/sessions';
import { getAvailableSkillSummary } from '$lib/server/services/skills/user-skills';
import type {
	ChatTurnRequestError,
	ParsedChatTurnRequest,
	PreflightedChatTurn,
	SkillPromptContext,
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

	let skillPromptContext = await resolveSkillPromptContext({
		userId,
		turn: {
			...request,
			linkedSources: resolvedLinkedSources,
		},
	});

	if (
		!request.deepResearchDepth &&
		request.pendingSkill &&
		skillPromptContext?.source !== 'pending_skill'
	) {
		return {
			ok: false,
			error: {
				status: 409,
				error: 'Selected skill is no longer available.',
				code: 'pending_skill_unavailable',
			},
		};
	}

	if (
		!request.deepResearchDepth &&
		request.pendingSkill &&
		skillPromptContext?.source === 'pending_skill' &&
		skillPromptContext.durationPolicy === 'session'
	) {
		try {
			const session = await startSkillSession(
				userId,
				request.conversationId,
				request.pendingSkill,
			);
			skillPromptContext = {
				source: 'active_session',
				sessionId: session.id,
				sessionStatus: session.status === 'paused' ? 'paused' : 'active',
				skillId: session.skillId,
				skillOwnership: session.skillOwnership,
				skillDisplayName: session.skillDisplayName,
				skillDescription: session.skillDescription,
				skillInstructions: session.skillInstructions,
				durationPolicy: session.durationPolicy,
				questionPolicy: session.questionPolicy,
				notesPolicy: session.notesPolicy,
				sourceScope: session.sourceScope,
				skillVersion: session.skillVersion,
				linkedSources: skillPromptContext.linkedSources,
			} satisfies SkillPromptContext;
		} catch (error) {
			const code =
				error instanceof Error && 'code' in error
					? (error as { code?: unknown }).code
					: undefined;
			const status =
				error instanceof Error && 'status' in error
					? (error as { status?: unknown }).status
					: undefined;
			if (code === 'skill_unavailable') {
				return {
					ok: false,
					error: {
						status: 409,
						error: 'Selected skill is no longer available.',
						code: 'pending_skill_unavailable',
					},
				};
			}
			if (code === 'active_skill_session_conflict') {
				return {
					ok: false,
					error: {
						status: typeof status === 'number' ? status : 409,
						error: 'Another skill session is already active.',
						code: 'active_skill_session_conflict',
					},
				};
			}
			throw error;
		}
	}

	return {
		ok: true,
		value: {
			...request,
			linkedSources: resolvedLinkedSources,
			skillPromptContext,
		},
	};
}
