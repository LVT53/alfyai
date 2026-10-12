// The title a conversation carries before one is made for it.
//
// It is STORED (the database default, the landing page's prepared draft, the
// title generator's fallback) and COMPARED (is this draft still untouched? did
// a generated title replace the default?), so it stays one English sentence
// everywhere it is stored. What a reader SEES for it is their own language's:
// `isUntitledConversationTitle` says when to show the localized label, and a
// surface prints `chat.untitledConversation` for it instead of this constant.

export const DEFAULT_CONVERSATION_TITLE = "New Conversation";

/** A blank title and the stored default are the same state: nothing has named this conversation yet. */
export function isUntitledConversationTitle(
	title: string | null | undefined,
): boolean {
	const trimmed = title?.trim() ?? "";
	return trimmed === "" || trimmed === DEFAULT_CONVERSATION_TITLE;
}

/** The title as a reader sees it: the title itself, or `untitledLabel` while the conversation has none. */
export function conversationDisplayTitle(
	title: string | null | undefined,
	untitledLabel: string,
): string {
	return isUntitledConversationTitle(title)
		? untitledLabel
		: (title ?? "").trim();
}
