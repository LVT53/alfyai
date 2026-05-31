import { getConversationCostSummary } from "$lib/server/services/analytics";
import { getChatFiles } from "$lib/server/services/chat-files";
import { buildContextSourcesState } from "$lib/server/services/chat-turn/context-sources";
import {
	listContextCompressionSnapshots,
	serializeContextCompressionSnapshot,
} from "$lib/server/services/context-compression";
import { getConversationDraft } from "$lib/server/services/conversation-drafts";
import {
	getConversationForkOrigin,
	listChildForksBySourceMessages,
} from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { listConversationDeepResearchJobs } from "$lib/server/services/deep-research";
import { listConversationFileProductionJobs } from "$lib/server/services/file-production/read-model";
import {
	getConversationContextStatus,
	getConversationWorkingSet,
	listConversationArtifacts,
} from "$lib/server/services/knowledge";
import { listMessages } from "$lib/server/services/messages";
import {
	getActiveSkillSession,
	serializePublicSkillSession,
} from "$lib/server/services/skills/sessions";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
} from "$lib/server/services/task-state";
import type { ConversationDetail } from "$lib/types";

export type ConversationDetailView = "full" | "bootstrap";

export interface GetConversationDetailInput {
	userId: string;
	conversationId: string;
	view?: ConversationDetailView;
}

export async function getConversationDetail({
	userId,
	conversationId,
	view = "full",
}: GetConversationDetailInput): Promise<ConversationDetail | null> {
	const conversation = await getConversation(userId, conversationId);
	if (!conversation) return null;

	if (view === "bootstrap") {
		const draft = await getConversationDraft(userId, conversationId).catch(
			() => null,
		);
		const activeSkillSession = await getActiveSkillSession(
			userId,
			conversationId,
		).catch(() => null);
		const forkOrigin = await getConversationForkOrigin(conversationId).catch(
			() => null,
		);
		return {
			conversation,
			messages: [],
			forkOrigin,
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			draft,
			fileProductionJobs: [],
			deepResearchJobs: [],
			contextCompressionSnapshots: [],
			activeSkillSession: serializePublicSkillSession(activeSkillSession),
			bootstrap: true,
		};
	}

	const [
		messageHistory,
		forkOrigin,
		attachedArtifacts,
		activeWorkingSet,
		contextStatus,
		taskState,
		contextDebug,
		draft,
		generatedFiles,
		fileProductionJobs,
		deepResearchJobs,
		contextCompressionSnapshots,
		costSummary,
		projectReference,
		activeSkillSession,
	] = await Promise.all([
		listMessages(conversationId),
		getConversationForkOrigin(conversationId),
		listConversationArtifacts(userId, conversationId),
		getConversationWorkingSet(userId, conversationId),
		getConversationContextStatus(userId, conversationId),
		getConversationTaskState(userId, conversationId),
		getContextDebugState(userId, conversationId),
		getConversationDraft(userId, conversationId),
		getChatFiles(conversationId),
		listConversationFileProductionJobs(userId, conversationId),
		listConversationDeepResearchJobs(userId, conversationId),
		listContextCompressionSnapshots(conversationId),
		getConversationCostSummary(conversationId),
		getProjectReferenceContext({ userId, conversationId }).catch(() => null),
		getActiveSkillSession(userId, conversationId).catch(() => null),
	]);
	const taskStateWithContinuity = await attachContinuityToTaskState(
		userId,
		taskState,
	).catch(() => taskState);
	const sourceForksByMessageId = await listChildForksBySourceMessages(
		userId,
		messageHistory
			.filter((message) => message.role === "assistant")
			.map((message) => message.id),
	).catch(() => ({}));
	const messagesWithSourceForks = messageHistory.map((message) => {
		if (message.role !== "assistant") return message;
		const sourceForks = sourceForksByMessageId[message.id];
		return sourceForks ? { ...message, sourceForks } : message;
	});
	const contextSources = buildContextSourcesState({
		userId,
		conversationId,
		contextStatus,
		contextDebug,
		attachedArtifacts,
		activeWorkingSet,
		projectReference,
	});
	return {
		conversation,
		messages: messagesWithSourceForks,
		forkOrigin,
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
		contextCompressionSnapshots: contextCompressionSnapshots.map(
			serializeContextCompressionSnapshot,
		),
		activeSkillSession: serializePublicSkillSession(activeSkillSession),
		bootstrap: false,
		totalCostUsdMicros: costSummary.totalCostUsdMicros,
		totalTokens: costSummary.totalTokens,
	};
}
