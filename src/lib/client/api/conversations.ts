import type { AtlasProfile } from "$lib/server/services/atlas/public-types";
import type { ContextCompressionMarker } from "$lib/server/services/context-compression";
import type { ConversationDetail } from "$lib/server/services/conversation-detail/types";
import type { ConversationForkOrigin } from "$lib/server/services/conversation-forks";
import type {
	Conversation,
	ConversationListItem,
} from "$lib/server/services/conversations";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type { ChatMessage } from "$lib/server/services/messages-types";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import { _unwrapList } from "./_utils";
import {
	type FetchLike,
	readErrorPayload,
	requestJson,
	requestResponse,
	requestVoid,
} from "./http";

type ConversationSummary = Pick<
	ConversationListItem,
	"id" | "title" | "updatedAt" | "projectId"
>;
type MessageEvidenceSummary = ChatMessage["evidenceSummary"];
type MessageCitationAudit = NonNullable<ChatMessage["citationAudit"]>;

export interface ConversationForkResponse {
	conversation: Conversation;
	forkOrigin: ConversationForkOrigin;
}

export type MessageEvidenceResult =
	| { status: "pending" }
	| { status: "none" }
	| { status: "missing" }
	| {
			status: "ready";
			evidenceSummary?: MessageEvidenceSummary;
			// Workspaces Slice E — the count the Info popover's "Project files"
			// row prints, written with the evidence summary and delivered with
			// it on the same answer; see `getMessageEvidenceState`.
			projectFilesRead?: number;
			// The citation auto-repair summary the popover's "Citation audit"
			// row prints. Unlike the two fields above it is NOT evidence: it is
			// persisted when the turn's message is created, so it can arrive on
			// an answer that has no summary at all.
			citationAudit?: MessageCitationAudit;
	  };

/**
 * The audit's four counts, or nothing. It is persisted JSON read back by the
 * endpoint (which validates it too — see `readCitationAuditFromMetadata`), but
 * the row prints counts, so a response missing one of them is no response.
 */
function readCitationAuditPayload(
	value: unknown,
): MessageCitationAudit | undefined {
	if (!value || typeof value !== "object") return undefined;
	const audit = value as Record<string, unknown>;
	const counts = ["cited", "verified", "repaired", "stripped"] as const;
	for (const key of counts) {
		if (typeof audit[key] !== "number") return undefined;
	}
	return {
		cited: audit.cited as number,
		verified: audit.verified as number,
		repaired: audit.repaired as number,
		stripped: audit.stripped as number,
	};
}

interface TitleGenerationResponse {
	title: string | null;
}

interface ContextCompressionResponse {
	snapshot: ContextCompressionMarker;
}

interface ConversationDraftPayload {
	draftText: string;
	selectedAttachmentIds: string[];
	selectedLinkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	clientAtlasTurnId?: string | null;
}

interface CreateConversationOptions {
	projectId?: string | null;
	/**
	 * Incognito, one-way: arms the conversation atomically at creation. Only
	 * `true` is meaningful — there is no way to create a conversation
	 * "explicitly not incognito", because that is just the default.
	 */
	memoryIncognito?: boolean;
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
	if (options.memoryIncognito) body.memoryIncognito = true;
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

/**
 * Incognito, one-way: this only ever arms it. There is no client path that
 * turns it back off (the server refuses `memoryIncognito: false` with a 409
 * regardless), so the signature does not pretend otherwise — the fallback
 * this exists for is the one described in
 * docs/plans/incognito-one-way-spec.md §1, for a conversation that already
 * exists (with no messages yet) but was not created with the flag.
 */
export async function setConversationMemoryIncognito(
	id: string,
	fetchImpl: FetchLike = fetch,
): Promise<Conversation> {
	return requestJson<Conversation>(
		`/api/conversations/${id}`,
		{
			method: "PATCH",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ memoryIncognito: true }),
		},
		"Failed to update conversation memory setting",
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
	const response = await requestResponse(
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
		const error = await readErrorPayload(
			response,
			"Failed to load message evidence",
		);
		throw new Error(error.message);
	}

	const payload = (await response.json()) as {
		evidenceSummary?: MessageEvidenceSummary;
		projectFilesRead?: number;
		citationAudit?: unknown;
	};
	const citationAudit = readCitationAuditPayload(payload.citationAudit);

	return {
		status: "ready",
		evidenceSummary: payload.evidenceSummary,
		...(typeof payload.projectFilesRead === "number"
			? { projectFilesRead: payload.projectFilesRead }
			: {}),
		...(citationAudit ? { citationAudit } : {}),
	};
}

/**
 * "Open as document" (Feature 2 · Artifacts, Slice 1): get-or-create the
 * Document a message was kept as. Idempotent server-side — calling this twice
 * for the same message answers with the same `artifactId` both times.
 */
export async function keepMessageAsDocument(
	conversationId: string,
	messageId: string,
	fetchImpl?: FetchLike,
): Promise<{ artifactId: string; title: string; created: boolean }> {
	const payload = await requestJson<{
		ok: true;
		artifactId: string;
		title: string;
		created: boolean;
	}>(
		`/api/conversations/${conversationId}/messages/${messageId}/document`,
		{ method: "POST" },
		"Failed to open this as a document",
		fetchImpl,
	);
	return {
		artifactId: payload.artifactId,
		title: payload.title,
		created: payload.created,
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

export type InstructionSuggestionAnswer = "reviewed" | "dismissed";

interface InstructionSuggestionResponse {
	suggestion: InstructionSuggestion;
}

/**
 * Answers one instruction suggestion the model offered in a conversation.
 *
 * Reviewing is not an accept: the dialog's own Save writes the instruction
 * text, and this only records that the user answered the offer — which is why
 * the page calls it after a save succeeded rather than before.
 */
export async function updateInstructionSuggestionStatus(
	conversationId: string,
	payload: {
		messageId: string;
		suggestionId: string;
		status: InstructionSuggestionAnswer;
	},
	fetchImpl: FetchLike = fetch,
): Promise<InstructionSuggestion> {
	const result = await requestJson<InstructionSuggestionResponse>(
		`/api/conversations/${encodeURIComponent(conversationId)}/instruction-suggestions`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		},
		"Failed to answer the instruction suggestion",
		fetchImpl,
	);
	if (!result.suggestion) {
		throw new Error(
			"The server returned unexpected instruction suggestion data.",
		);
	}
	return result.suggestion;
}

export interface ConversationMarkdownExport {
	markdown: string;
	filename: string;
}

// Prefers the RFC 5987 `filename*=UTF-8''…` parameter — it is the one that
// carries a non-ASCII title (a Hungarian conversation name, say) intact —
// and only falls back to the plain ASCII `filename=` the server sends
// alongside it for older clients.
function conversationExportFilenameFromHeader(
	header: string | null,
	fallback: string,
): string {
	if (!header) return fallback;
	const encoded = /filename\*=UTF-8''([^;\s]+)/i.exec(header);
	if (encoded?.[1]) {
		try {
			const decoded = decodeURIComponent(encoded[1]).trim();
			if (decoded) return decoded;
		} catch {
			// Malformed percent-encoding — fall through to the ASCII form.
		}
	}
	const match = /filename="?([^";]+)"?/i.exec(header);
	return match?.[1]?.trim() || fallback;
}

/** Backs the composer's `/export` command — downloads the conversation as Markdown. */
export async function fetchConversationMarkdownExport(
	conversationId: string,
	fetchImpl: FetchLike = fetch,
): Promise<ConversationMarkdownExport> {
	const response = await requestResponse(
		`/api/conversations/${conversationId}/export.md`,
		undefined,
		fetchImpl,
	);
	if (!response.ok) {
		const error = await readErrorPayload(
			response,
			"Failed to export conversation",
		);
		throw new Error(error.message);
	}
	return {
		markdown: await response.text(),
		filename: conversationExportFilenameFromHeader(
			response.headers.get("Content-Disposition"),
			`${conversationId}.md`,
		),
	};
}
