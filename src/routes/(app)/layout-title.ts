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

	// The conversations store first: it is the one live source, where a
	// generated title and a sidebar rename land, and the chat page writes its
	// freshly-loaded title into it on arrival. The loaded page data never
	// sees a title that changes after load, so it only covers the moment
	// before the store has the row; the shell snapshot is the last resort.
	return (
		conversationStore.find(
			(conversation) => conversation.id === routeConversationId,
		)?.title ??
		getPageConversationTitle(pageData, routeConversationId) ??
		shellConversations.find(
			(conversation) => conversation.id === routeConversationId,
		)?.title ??
		null
	);
}

/**
 * Incognito, one-way (docs/plans/incognito-one-way-spec.md §2). Unlike the
 * title above, the page's own freshly-loaded data comes first, then the two
 * client mirrors — the flag only ever turns on, and the page data has it
 * from the first paint — so the phone header's mask mark
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
