import { getConfig } from "$lib/server/config-store";
import { getConversationCostSummary } from "$lib/server/services/analytics";
import { listConversationAtlasJobs } from "$lib/server/services/atlas/read-model";
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
import {
	listConversationFileProductionJobs,
	listConversationGeneratedFiles,
} from "$lib/server/services/file-production/read-model";
import {
	getConversationContextStatus,
	getConversationWorkingSet,
	listConversationArtifacts,
} from "$lib/server/services/knowledge";
import { listConversationLinkedContextSources } from "$lib/server/services/linked-context-sources";
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
import type {
	AtlasAvailability,
	ChatMessage,
	ConversationDetail,
	MessageSourceForks,
} from "$lib/types";

export type ConversationDetailView = "full" | "bootstrap" | "first-render";

export interface GetConversationDetailInput {
	userId: string;
	conversationId: string;
	view?: ConversationDetailView;
}

function getAtlasAvailability(): AtlasAvailability {
	const config = getConfig();
	if (!config.atlasWorkerEnabled) {
		return {
			enabled: false,
			configured: Boolean(config.searxngBaseUrl?.trim()),
			reasonCode: "disabled",
			reason: "Atlas is disabled by the administrator.",
		};
	}
	if (!config.searxngBaseUrl?.trim()) {
		return {
			enabled: true,
			configured: false,
			reasonCode: "missing_searxng",
			reason: "Atlas requires SearXNG web search configuration.",
		};
	}
	return { enabled: true, configured: true, reasonCode: null, reason: null };
}

async function attachSourceForksToAssistantMessages(
	userId: string,
	messageHistory: ChatMessage[],
): Promise<ChatMessage[]> {
	const sourceForksByMessageId = (await listChildForksBySourceMessages(
		userId,
		messageHistory
			.filter((message) => message.role === "assistant")
			.map((message) => message.id),
	).catch(() => ({}))) as Record<string, MessageSourceForks>;
	return messageHistory.map((message) => {
		if (message.role !== "assistant") return message;
		const sourceForks = sourceForksByMessageId[message.id];
		return sourceForks ? { ...message, sourceForks } : message;
	});
}

export async function getConversationDetail({
	userId,
	conversationId,
	view = "full",
}: GetConversationDetailInput): Promise<ConversationDetail | null> {
	const conversation = await getConversation(userId, conversationId);
	if (!conversation) return null;
	const atlasAvailability = getAtlasAvailability();

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
			atlasJobs: [],
			atlasAvailability,
			contextCompressionSnapshots: [],
			activeSkillSession: serializePublicSkillSession(activeSkillSession),
			bootstrap: true,
			sidecarPending: false,
		};
	}

	if (view === "first-render") {
		const [messageHistory, forkOrigin, draft, activeSkillSession] =
			await Promise.all([
				listMessages(conversationId),
				getConversationForkOrigin(conversationId),
				getConversationDraft(userId, conversationId),
				getActiveSkillSession(userId, conversationId).catch(() => null),
			]);
		const messagesWithSourceForks = await attachSourceForksToAssistantMessages(
			userId,
			messageHistory,
		);
		return {
			conversation,
			messages: messagesWithSourceForks,
			forkOrigin,
			attachedArtifacts: [],
			activeWorkingSet: [],
			contextStatus: null,
			contextSources: null,
			taskState: null,
			contextDebug: null,
			draft,
			generatedFiles: [],
			fileProductionJobs: [],
			atlasJobs: [],
			atlasAvailability,
			contextCompressionSnapshots: [],
			activeSkillSession: serializePublicSkillSession(activeSkillSession),
			bootstrap: false,
			sidecarPending: true,
			totalCostUsdMicros: 0,
			totalTokens: 0,
		};
	}

	const [
		messageHistory,
		forkOrigin,
		attachedArtifacts,
		linkedSources,
		activeWorkingSet,
		contextStatus,
		taskState,
		contextDebug,
		draft,
		generatedFiles,
		fileProductionJobs,
		atlasJobs,
		contextCompressionSnapshots,
		costSummary,
		projectReference,
		activeSkillSession,
	] = await Promise.all([
		listMessages(conversationId),
		getConversationForkOrigin(conversationId),
		listConversationArtifacts(userId, conversationId),
		listConversationLinkedContextSources({ userId, conversationId }).catch(
			() => [],
		),
		getConversationWorkingSet(userId, conversationId),
		getConversationContextStatus(userId, conversationId),
		getConversationTaskState(userId, conversationId),
		getContextDebugState(userId, conversationId),
		getConversationDraft(userId, conversationId),
		listConversationGeneratedFiles(conversationId),
		listConversationFileProductionJobs(userId, conversationId),
		listConversationAtlasJobs(userId, conversationId),
		listContextCompressionSnapshots(conversationId),
		getConversationCostSummary(conversationId),
		getProjectReferenceContext({ userId, conversationId }).catch(() => null),
		getActiveSkillSession(userId, conversationId).catch(() => null),
	]);
	const taskStateWithContinuity = await attachContinuityToTaskState(
		userId,
		taskState,
	).catch(() => taskState);
	const messagesWithSourceForks = await attachSourceForksToAssistantMessages(
		userId,
		messageHistory,
	);
	const contextSources = buildContextSourcesState({
		userId,
		conversationId,
		contextStatus,
		contextDebug,
		attachedArtifacts,
		linkedSources,
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
		atlasJobs,
		atlasAvailability,
		contextCompressionSnapshots: contextCompressionSnapshots.map(
			serializeContextCompressionSnapshot,
		),
		activeSkillSession: serializePublicSkillSession(activeSkillSession),
		bootstrap: false,
		sidecarPending: false,
		totalCostUsdMicros: costSummary.totalCostUsdMicros,
		totalTokens: costSummary.totalTokens,
	};
}
