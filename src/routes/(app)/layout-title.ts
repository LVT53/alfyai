import type { ConversationListItem } from "$lib/server/services/conversations";

type PageConversationTitleData = {
	conversation?: {
		id?: string;
		title?: string | null;
		memoryIncognito?: boolean;
	} | null;
};

function getPageConversationTitle(
	pageData: unknown,
	routeConversationId: string,
): string | null {
	if (!pageData || typeof pageData !== "object") return null;
	const conversation = (pageData as PageConversationTitleData).conversation;
	if (!conversation || conversation.id !== routeConversationId) return null;
	return conversation.title?.trim() || null;
}

export function resolveActiveConversationTitle(params: {
	routeConversationId: string | null;
	conversationStore: ConversationListItem[];
	shellConversations: ConversationListItem[];
	pageData?: unknown;
}): string | null {
	const {
		routeConversationId,
		conversationStore,
		shellConversations,
		pageData,
	} = params;
	if (!routeConversationId) return null;

	return (
		getPageConversationTitle(pageData, routeConversationId) ??
		conversationStore.find(
			(conversation) => conversation.id === routeConversationId,
		)?.title ??
		shellConversations.find(
			(conversation) => conversation.id === routeConversationId,
		)?.title ??
		null
	);
}

/**
 * Incognito, one-way (docs/plans/incognito-one-way-spec.md §2). Same
 * resolution order as the title above — the page's own freshly-loaded data
 * first, then the two client mirrors — so the phone header's mask mark
 * cannot show a stale "not incognito" for a beat after opening a conversation
 * that is.
 */
export function resolveActiveConversationIncognito(params: {
	routeConversationId: string | null;
	conversationStore: ConversationListItem[];
	shellConversations: ConversationListItem[];
	pageData?: unknown;
}): boolean {
	const {
		routeConversationId,
		conversationStore,
		shellConversations,
		pageData,
	} = params;
	if (!routeConversationId) return false;

	const pageConversation =
		pageData && typeof pageData === "object"
			? (pageData as PageConversationTitleData).conversation
			: null;
	if (pageConversation && pageConversation.id === routeConversationId) {
		return pageConversation.memoryIncognito === true;
	}

	return (
		conversationStore.find(
			(conversation) => conversation.id === routeConversationId,
		)?.memoryIncognito ??
		shellConversations.find(
			(conversation) => conversation.id === routeConversationId,
		)?.memoryIncognito ??
		false
	);
}
