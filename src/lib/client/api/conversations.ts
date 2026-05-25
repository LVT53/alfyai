import type {
	ChatMessage,
	ContextCompressionMarker,
	ContextDebugState,
	Conversation,
	ConversationDetail,
	ConversationForkOrigin,
	ConversationListItem,
	LinkedContextSource,
	PendingSkillSelection,
	SkillSession,
	TaskState,
	TaskSteeringPayload,
} from "$lib/types";
import { _unwrapList } from "./_utils";
import { type FetchLike, requestJson, requestVoid } from "./http";

type ConversationSummary = Pick<
	ConversationListItem,
	"id" | "title" | "updatedAt" | "projectId"
>;
type MessageEvidenceSummary = ChatMessage["evidenceSummary"];

export interface ConversationForkResponse {
	conversation: Conversation;
	forkOrigin: ConversationForkOrigin;
}

export type MessageEvidenceResult =
	| { status: "pending" }
	| { status: "none" }
	| { status: "missing" }
	| { status: "ready"; evidenceSummary?: MessageEvidenceSummary };

interface TitleGenerationResponse {
	title: string | null;
}

interface TaskSteeringResponse {
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
}

interface ContextCompressionResponse {
	snapshot: ContextCompressionMarker;
}

interface ConversationDraftPayload {
	draftText: string;
	selectedAttachmentIds: string[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
}

interface CreateConversationOptions {
	projectId?: string | null;
}

export async function fetchConversations(): Promise<ConversationListItem[]> {
	const payload = await requestJson<{ conversations?: ConversationListItem[] }>(
		"/api/conversations",
		undefined,
		"Failed to load conversations",
	);
	return _unwrapList<ConversationListItem>(payload, "conversations");
}

export async function fetchConversationDetail(
	id: string,
	options?: { view?: "bootstrap" },
): Promise<ConversationDetail> {
	const viewParam = options?.view
		? `?view=${encodeURIComponent(options.view)}`
		: "";

	return requestJson<ConversationDetail>(
		`/api/conversations/${id}${viewParam}`,
		undefined,
		"Failed to load conversation",
	);
}

export async function conversationExists(
	id: string,
	fetchImpl: FetchLike = fetch,
): Promise<boolean | null> {
	try {
		const response = await fetchImpl(`/api/conversations/${id}`);
		if (response.status === 404) {
			return false;
		}
		if (response.ok) {
			return true;
		}
		return null;
	} catch {
		return null;
	}
}

export async function createConversation(
	title?: string,
	options: CreateConversationOptions = {},
): Promise<ConversationSummary> {
	const body: Record<string, unknown> = {};
	if (title) body.title = title;
	if (options.projectId !== undefined) body.projectId = options.projectId;
	const payload = await requestJson<ConversationSummary>(
		"/api/conversations",
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		"We could not create a new conversation at this time. Please try again later.",
	);

	if (!payload || typeof payload.id !== "string") {
		throw new Error("The server returned unexpected data. Please try again.");
	}

	return payload;
}

export async function createConversationFork(
	conversationId: string,
	payload: { messageId: string },
	fetchImpl: FetchLike = fetch,
): Promise<ConversationForkResponse> {
	const result = await requestJson<ConversationForkResponse>(
		`/api/conversations/${conversationId}/forks`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to create conversation fork",
		fetchImpl,
	);

	if (
		!result?.conversation?.id ||
		!result?.forkOrigin?.copiedForkPointMessageId
	) {
		throw new Error(
			"The server returned unexpected fork data. Please try again.",
		);
	}

	return result;
}

export async function renameConversation(
	id: string,
	title: string,
): Promise<ConversationSummary> {
	return requestJson<ConversationSummary>(
		`/api/conversations/${id}`,
		{
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ title }),
		},
		"Failed to rename conversation",
	);
}

export async function moveConversationToProject(
	id: string,
	projectId: string | null,
): Promise<ConversationSummary> {
	return requestJson<ConversationSummary>(
		`/api/conversations/${id}`,
		{
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ projectId }),
		},
		"Failed to move conversation",
	);
}

export async function setConversationSidebarPinned(
	id: string,
	sidebarPinned: boolean,
	fetchImpl: FetchLike = fetch,
): Promise<Conversation> {
	return requestJson<Conversation>(
		`/api/conversations/${id}`,
		{
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ sidebarPinned }),
		},
		"Failed to update conversation pin",
		fetchImpl,
	);
}

export async function savePinnedConversationSidebarOrder(
	orderedIds: string[],
	fetchImpl: FetchLike = fetch,
): Promise<ConversationListItem[]> {
	const payload = await requestJson<{ conversations?: ConversationListItem[] }>(
		"/api/conversations/sidebar-order",
		{
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ orderedIds }),
		},
		"Failed to save conversation order",
		fetchImpl,
	);
	return _unwrapList<ConversationListItem>(payload, "conversations");
}

export async function deleteConversation(id: string): Promise<void> {
	await requestVoid(
		`/api/conversations/${id}`,
		{
			method: "DELETE",
		},
		"Failed to delete conversation",
	);
}

export async function persistConversationDraft(
	conversationId: string,
	payload: ConversationDraftPayload,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestVoid(
		`/api/conversations/${conversationId}/draft`,
		{
			method: "PUT",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to save conversation draft",
		fetchImpl,
	);
}

export async function persistConversationLinkedSources(
	conversationId: string,
	payload: { linkedSources: LinkedContextSource[]; attachmentIds?: string[] },
	fetchImpl: FetchLike = fetch,
): Promise<LinkedContextSource[]> {
	const result = await requestJson<{ linkedSources?: LinkedContextSource[] }>(
		`/api/conversations/${conversationId}/linked-sources`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				linkedSources: payload.linkedSources,
				attachmentIds: payload.attachmentIds ?? [],
			}),
		},
		"Failed to save linked context sources",
		fetchImpl,
	);
	return Array.isArray(result.linkedSources) ? result.linkedSources : [];
}

export async function startConversationSkillSession(
	conversationId: string,
	pendingSkill: PendingSkillSelection,
	fetchImpl: FetchLike = fetch,
): Promise<SkillSession> {
	const result = await requestJson<{ activeSkillSession?: SkillSession }>(
		`/api/conversations/${conversationId}/skill-sessions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ pendingSkill }),
		},
		"Failed to start skill session",
		fetchImpl,
	);
	if (!result.activeSkillSession) {
		throw new Error("The server returned unexpected skill session data.");
	}
	return result.activeSkillSession;
}

export async function endConversationSkillSession(
	conversationId: string,
	reason: "ended" | "dismissed" = "ended",
	fetchImpl: FetchLike = fetch,
): Promise<SkillSession | null> {
	const result = await requestJson<{ endedSkillSession?: SkillSession | null }>(
		`/api/conversations/${conversationId}/skill-sessions`,
		{
			method: "DELETE",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ reason }),
		},
		"Failed to end skill session",
		fetchImpl,
	);
	return result.endedSkillSession ?? null;
}

export async function deleteConversationDraft(
	conversationId: string,
	fetchImpl: FetchLike = fetch,
): Promise<void> {
	await requestVoid(
		`/api/conversations/${conversationId}/draft`,
		{
			method: "DELETE",
		},
		"Failed to delete conversation draft",
		fetchImpl,
	);
}

export async function deletePreparedConversation(
	conversationId: string,
	options?: { keepalive?: boolean; fetchImpl?: FetchLike },
): Promise<void> {
	await requestVoid(
		`/api/conversations/${conversationId}`,
		{
			method: "DELETE",
			...(options?.keepalive ? { keepalive: true } : {}),
		},
		"Failed to delete conversation",
		options?.fetchImpl,
	);
}

export async function fetchMessageEvidence(
	conversationId: string,
	messageId: string,
	signal?: AbortSignal,
): Promise<MessageEvidenceResult> {
	const response = await fetch(
		`/api/conversations/${conversationId}/messages/${messageId}/evidence`,
		{ signal },
	);

	if (response.status === 202) {
		return { status: "pending" };
	}

	if (response.status === 204) {
		return { status: "none" };
	}

	if (response.status === 404) {
		return { status: "missing" };
	}

	if (!response.ok) {
		throw new Error("Failed to load message evidence");
	}

	const payload = (await response.json()) as {
		evidenceSummary?: MessageEvidenceSummary;
	};

	return {
		status: "ready",
		evidenceSummary: payload.evidenceSummary,
	};
}

export async function generateConversationTitle(
	conversationId: string,
	params: { userMessage: string; assistantResponse: string },
): Promise<string | null> {
	const payload = await requestJson<TitleGenerationResponse>(
		`/api/conversations/${conversationId}/title`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(params),
		},
		"Failed to generate conversation title",
	);

	return typeof payload.title === "string" && payload.title.trim().length > 0
		? payload.title
		: null;
}

export async function deleteConversationMessages(
	conversationId: string,
	messageIds: string[],
	options: {
		confirmForkedSourceHistoryMutation?: boolean;
		fetchImpl?: FetchLike;
	} = {},
): Promise<number> {
	const body: Record<string, unknown> = { messageIds };
	if (options.confirmForkedSourceHistoryMutation) {
		body.confirmForkedSourceHistoryMutation = true;
	}
	const payload = await requestJson<{ deleted?: number }>(
		`/api/conversations/${conversationId}/messages`,
		{
			method: "DELETE",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		},
		"Failed to delete messages",
		options.fetchImpl,
	);

	return typeof payload.deleted === "number" ? payload.deleted : 0;
}

export async function applyTaskSteering(
	conversationId: string,
	payload: TaskSteeringPayload,
): Promise<TaskSteeringResponse> {
	return requestJson<TaskSteeringResponse>(
		`/api/conversations/${conversationId}/task-steering`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to update task steering",
	);
}

export async function runConversationContextCompression(
	conversationId: string,
	payload: { selectedModelId: string; trigger?: "manual" | "automatic" },
	fetchImpl: FetchLike = fetch,
): Promise<ContextCompressionMarker> {
	const result = await requestJson<ContextCompressionResponse>(
		`/api/conversations/${conversationId}/context-compression`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to compact context",
		fetchImpl,
	);
	if (!result.snapshot) {
		throw new Error("The server returned unexpected context compression data.");
	}
	return result.snapshot;
}
