import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireAuth } from '$lib/server/auth/hooks';
import {
	getConversation,
	updateConversationTitle,
	moveConversationToProject
} from '$lib/server/services/conversations';
import { deleteConversationWithCleanup } from '$lib/server/services/cleanup';
import { listMessages } from '$lib/server/services/messages';
import {
	getConversationWorkingSet,
	getConversationContextStatus,
	listConversationArtifacts
} from '$lib/server/services/knowledge';
import { getChatFiles } from '$lib/server/services/chat-files';
import { listConversationFileProductionJobs } from '$lib/server/services/file-production';
import { listConversationDeepResearchJobs } from '$lib/server/services/deep-research';
import { getConversationDraft } from '$lib/server/services/conversation-drafts';
import { getConversationCostSummary } from '$lib/server/services/analytics';
import {
	getActiveSkillSession,
	serializePublicSkillSession,
} from '$lib/server/services/skills/sessions';
import { buildContextSourcesState } from '$lib/server/services/chat-turn/context-sources';
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
} from '$lib/server/services/task-state';

function isConversationDeleteBlockedByDeepResearchError(
	error: unknown
): error is { code: 'active_deep_research_jobs' } {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === 'active_deep_research_jobs'
	);
}

export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
		const user = event.locals.user!;
		const { id } = event.params;

		const conversation = await getConversation(user.id, id);
		if (!conversation) {
			return json({ error: 'Conversation not found' }, { status: 404 });
		}

		if (event.url.searchParams.get('view') === 'bootstrap') {
			const draft = await getConversationDraft(user.id, id).catch(() => null);
			const activeSkillSession = await getActiveSkillSession(user.id, id).catch(() => null);
			return json({
				conversation,
				messages: [],
				attachedArtifacts: [],
				activeWorkingSet: [],
				contextStatus: null,
				contextSources: null,
				taskState: null,
				contextDebug: null,
				draft,
				fileProductionJobs: [],
				deepResearchJobs: [],
				activeSkillSession: serializePublicSkillSession(activeSkillSession),
				bootstrap: true,
			});
		}

		const [
			messageHistory,
			attachedArtifacts,
			activeWorkingSet,
			contextStatus,
			taskState,
			contextDebug,
			draft,
			generatedFiles,
			fileProductionJobs,
			deepResearchJobs,
			costSummary,
			projectReference,
			activeSkillSession,
		] = await Promise.all([
			listMessages(id),
			listConversationArtifacts(user.id, id),
			getConversationWorkingSet(user.id, id),
			getConversationContextStatus(user.id, id),
			getConversationTaskState(user.id, id),
			getContextDebugState(user.id, id),
			getConversationDraft(user.id, id),
			getChatFiles(id),
			listConversationFileProductionJobs(user.id, id),
			listConversationDeepResearchJobs(user.id, id),
			getConversationCostSummary(id),
			getProjectReferenceContext({ userId: user.id, conversationId: id }).catch(
				() => null,
			),
			getActiveSkillSession(user.id, id).catch(() => null),
		]);
		const taskStateWithContinuity = await attachContinuityToTaskState(user.id, taskState).catch(
			() => taskState
		);
		const contextSources = buildContextSourcesState({
			userId: user.id,
			conversationId: id,
			contextStatus,
			contextDebug,
			attachedArtifacts,
			activeWorkingSet,
			projectReference,
		});
		return json({
			conversation,
			messages: messageHistory,
			attachedArtifacts,
			activeWorkingSet,
			contextStatus,
			contextSources,
			taskState: taskStateWithContinuity,
			contextDebug,
			draft,
			generatedFiles,
			fileProductionJobs,
			deepResearchJobs,
			activeSkillSession: serializePublicSkillSession(activeSkillSession),
			bootstrap: false,
			totalCostUsdMicros: costSummary.totalCostUsdMicros,
			totalTokens: costSummary.totalTokens,
		});
	} catch (err) {
		console.error('Error loading conversation:', err);
		return json({ error: 'Failed to load conversation' }, { status: 500 });
	}
};

export const PATCH: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const { id } = event.params;

	const body = await event.request.json().catch(() => null);
	if (!body) {
		return json({ error: 'Body is required' }, { status: 400 });
	}

	// Handle project assignment
	if ('projectId' in body) {
		const projectId = body.projectId === null || typeof body.projectId === 'string' ? body.projectId : undefined;
		if (projectId === undefined) {
			return json({ error: 'projectId must be a string or null' }, { status: 400 });
		}
		const conversation = await moveConversationToProject(user.id, id, projectId);
		if (!conversation) {
			return json({ error: 'Conversation not found' }, { status: 404 });
		}
		return json(conversation);
	}

	// Handle title rename
	if (typeof body.title !== 'string' || body.title.trim().length === 0) {
		return json({ error: 'Title is required' }, { status: 400 });
	}

	const conversation = await updateConversationTitle(user.id, id, body.title.trim());
	if (!conversation) {
		return json({ error: 'Conversation not found' }, { status: 404 });
	}

	return json(conversation);
};

export const DELETE: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user!;
	const { id } = event.params;

	let deleted;
	try {
		deleted = await deleteConversationWithCleanup(user.id, id);
	} catch (error) {
		if (isConversationDeleteBlockedByDeepResearchError(error)) {
			return json(
				{
					error: 'Conversation has active Deep Research jobs',
					code: error.code,
				},
				{ status: 409 }
			);
		}
		console.error('[CONVERSATION_DELETE] Failed to fully delete conversation:', error);
		return json({ error: 'Failed to fully delete conversation' }, { status: 500 });
	}

	if (!deleted) {
		return json({ error: 'Conversation not found' }, { status: 404 });
	}

	return json({
		success: true,
		deletedArtifactIds: deleted.deletedArtifactIds,
		preservedArtifactIds: deleted.preservedArtifactIds,
	});
};
