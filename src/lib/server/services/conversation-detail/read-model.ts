import { getConversationCostSummary } from "$lib/server/services/analytics";
import {
	listArtifactsForConversation,
	listMissingArtifactIds,
} from "$lib/server/services/artifacts";
import type { ArtifactCardSummary } from "$lib/server/services/artifacts/types";
import { getAtlasAvailability } from "$lib/server/services/atlas/availability";
import { listConversationAtlasJobs } from "$lib/server/services/atlas/read-model";
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
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import {
	getConversationContextStatus,
	getConversationWorkingSet,
	listConversationArtifacts,
} from "$lib/server/services/knowledge";
import {
	artifactCallIdsFromMessages,
	CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT,
	listMessageWindow,
	regenerableArtifactIdsFromMessages,
} from "$lib/server/services/messages";
import type { ChatMessage } from "$lib/server/services/messages-types";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import { markRegenerable } from "$lib/shared/artifacts/artifact-calls";

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

/**
 * What became of the artifacts the given messages' own tool calls made or
 * edited — what an in-chat card needs to say "this document was deleted"
 * (gone) or "made in the original chat" (still there, out of this chat's
 * reach). The ids come off the messages the caller already loaded (this read
 * is pinned to one `messages` query); which of them are gone or unreachable
 * is the artifact service's to say, under the ownership scope.
 */
async function classifyMissingArtifacts(
	userId: string,
	conversationId: string,
	loadedMessages: ChatMessage[],
): Promise<{ deleted: string[]; unreachable: string[] }> {
	return listMissingArtifactIds({
		userId,
		conversationId,
		artifactIds: artifactCallIdsFromMessages(loadedMessages),
	});
}

/**
 * The artifact list with the items the chat can make again marked
 * (`ArtifactCardSummary.regenerable`), so the delete confirm can tell
 * "you can regenerate it from the chat" from "this can't be undone" for THIS
 * item. Documents and Apps come off the loaded messages (a successful create
 * call, or the message a Document was kept from); a produced file counts when
 * its finished job kept its request AND it is the only artifact that job made
 * — deleting one of two leaves the job a file, and a job with a file left
 * cannot be made again. Anything not known to be regenerable is left exactly
 * as the artifact service gave it, and the list itself when nothing is.
 */
function markRegenerableArtifacts(
	rows: ArtifactCardSummary[],
	messagesInWindow: ChatMessage[],
	jobs: FileProductionJob[],
): ArtifactCardSummary[] {
	const regenerable = new Set(
		regenerableArtifactIdsFromMessages(messagesInWindow),
	);
	for (const job of jobs) {
		if (!job.canRegenerate) continue;
		const madeArtifactIds = new Set(
			job.files.flatMap((file) => (file.artifactId ? [file.artifactId] : [])),
		);
		const [only] = madeArtifactIds;
		if (madeArtifactIds.size === 1 && only) regenerable.add(only);
	}
	return markRegenerable(rows, regenerable);
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
			taskState: null,
			contextDebug: null,
			draft,
			fileProductionJobs: [],
			atlasJobs: [],
			atlasAvailability,
			contextCompressionSnapshots: [],
			artifacts: [],
			bootstrap: true,
			sidecarPending: false,
			hasMoreMessages: false,
		};
	}

	const messageWindowRequest = listMessageWindow(conversationId, {
		limit: messageWindowLimit,
	});
	const [
		messageWindow,
		forkOrigin,
		attachedArtifacts,
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
		artifacts,
		missingArtifacts,
	] = await Promise.all([
		messageWindowRequest,
		getConversationForkOrigin(conversationId),
		listConversationArtifacts(userId, conversationId),
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
		// The panel list's and the header count's one source (Slice 0 Task
		// S7): the same listArtifactsForConversation call the panel needs, not
		// a second query per row.
		listArtifactsForConversation({ userId, conversationId }),
		messageWindowRequest.then((window) =>
			classifyMissingArtifacts(userId, conversationId, window.messages),
		),
	]);
	const taskStateWithContinuity = await attachContinuityToTaskState(
		userId,
		taskState,
	).catch(() => taskState);
	const messagesWithSourceForks = await attachSourceForksToAssistantMessages(
		userId,
		messageWindow.messages,
	);
	return {
		conversation,
		messages: messagesWithSourceForks,
		forkOrigin,
		attachedArtifacts,
		activeWorkingSet,
		contextStatus,
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
		artifacts: markRegenerableArtifacts(
			artifacts,
			messageWindow.messages,
			fileProductionJobs,
		),
		deletedArtifactIds: missingArtifacts.deleted,
		unreachableArtifactIds: missingArtifacts.unreachable,
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
// and does NOT re-run the rest of the ~14-way assembly (task state, atlas
// jobs, cost, …) — that state does not change by paging
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
	/** Of the artifacts these older messages' tool calls named, the ones that no longer exist — the same signal the detail carries for the loaded window. */
	deletedArtifactIds: string[];
	/** …and the ones that exist but are out of this conversation's reach (made in another chat). */
	unreachableArtifactIds: string[];
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
	const missing = await classifyMissingArtifacts(
		userId,
		conversationId,
		page.messages,
	);
	return {
		messages: messagesWithSourceForks,
		hasMoreBefore: page.hasMoreBefore,
		deletedArtifactIds: missing.deleted,
		unreachableArtifactIds: missing.unreachable,
	};
}
