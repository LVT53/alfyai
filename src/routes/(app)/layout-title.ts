import type { ConversationListItem } from "$lib/types";

type PageConversationTitleData = {
	conversation?: {
		id?: string;
		title?: string | null;
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
