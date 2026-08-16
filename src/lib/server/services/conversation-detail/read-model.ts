import { getConversationCostSummary } from "$lib/server/services/analytics";
import { getAtlasAvailability } from "$lib/server/services/atlas/availability";
import { listConversationAtlasJobs } from "$lib/server/services/atlas/read-model";
import { buildContextSourcesState } from "$lib/server/services/chat-turn/context-sources";
import {
	listContextCompressionSnapshots,
	serializeContextCompressionSnapshot,
} from "$lib/server/services/context-compression";
import type { ConversationDetail } from "$lib/server/services/conversation-detail/types";
import { getConversationDraft } from "$lib/server/services/conversation-drafts";
import type { MessageSourceForks } from "$lib/server/services/conversation-forks";
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
import {
	CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT,
	listMessageWindow,
} from "$lib/server/services/messages";
import type { ChatMessage } from "$lib/server/services/messages-types";
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

// O1 (ADR-0022 amendment) — "full" is the only assembled view left; the
// former "bootstrap"-vs-"first-render"-vs-"full" three-way split existed to
// make the initial page load cheap by deferring the expensive assembly to a
// second, client-triggered fetch. In practice that second fetch was
// unconditional (`sidecarPending` was always `true` for "first-render"), so
// every conversation open paid for two full read-model invocations instead
// of one. Folding the initial load into "full" — now backed by a bounded
// message window rather than the entire history — removes the second read
// instead of just deferring it. "bootstrap" is unchanged: a brand-new
// conversation with no persisted messages yet has nothing for "full" to
// assemble, so skipping straight to a stream is still the cheaper, correct
// path.
export type ConversationDetailView = "full" | "bootstrap";

export interface GetConversationDetailInput {
	userId: string;
	conversationId: string;
	view?: ConversationDetailView;
	/**
	 * Overrides the default initial message window size
	 * (`CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT`). Exists for tests that
	 * need to exercise pagination without seeding hundreds of rows.
	 */
	messageWindowLimit?: number;
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
	messageWindowLimit = CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT,
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
			hasMoreMessages: false,
		};
	}

	const [
		messageWindow,
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
		listMessageWindow(conversationId, { limit: messageWindowLimit }),
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
		listConversationFileProductionJobs(userId, conversationId, {
			includeDismissed: false,
		}),
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
		messageWindow.messages,
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
		hasMoreMessages: messageWindow.hasMoreBefore,
		totalCostUsdMicros: costSummary.totalCostUsdMicros,
		totalTokens: costSummary.totalTokens,
	};
}

// O1 pagination — the initial window loaded by `getConversationDetail`
// covers only the most recent `messageWindowLimit` messages. This is the
// on-demand path for scrolling further back: it re-runs only the
// message-window query plus the same child-fork decoration `full` view
// messages get (so the assembled `ChatMessage[]` shape matches exactly),
// and does NOT re-run the rest of the ~16-way assembly (context sources,
// task state, atlas jobs, cost, …) — that state does not change by paging
// older messages into view, so re-fetching it would be pure waste.
export interface GetOlderConversationMessagesInput {
	userId: string;
	conversationId: string;
	/** Number of messages already loaded, counted from the newest end. */
	offset: number;
	limit?: number;
}

export interface OlderConversationMessagesPage {
	messages: ChatMessage[];
	hasMoreBefore: boolean;
}

export async function getOlderConversationMessages({
	userId,
	conversationId,
	offset,
	limit = CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT,
}: GetOlderConversationMessagesInput): Promise<OlderConversationMessagesPage | null> {
	const conversation = await getConversation(userId, conversationId);
	if (!conversation) return null;

	const page = await listMessageWindow(conversationId, { limit, offset });
	const messagesWithSourceForks = await attachSourceForksToAssistantMessages(
		userId,
		page.messages,
	);
	return {
		messages: messagesWithSourceForks,
		hasMoreBefore: page.hasMoreBefore,
	};
}
