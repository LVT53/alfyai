import type { ConversationListItem } from "$lib/types";

/**
 * Count the conversations that belong to a project folder in the sidebar.
 *
 * Pinned conversations are excluded because the sidebar shows them in the
 * global Pinned section regardless of their `projectId` — counting them here
 * would inflate the project badge with chats that do not appear inside the
 * folder. This mirrors the bucketing that
 * `ConversationList.svelte` applies when it builds
 * `conversationsByProject`.
 *
 * Pure and side-effect free so it stays trivially unit-testable.
 */
export function countProjectConversations(
	conversations: ConversationListItem[],
	projectId: string,
): number {
	let count = 0;
	for (const conversation of conversations) {
		if (conversation.sidebarPinned) continue;
		if (conversation.projectId === projectId) count += 1;
	}
	return count;
}
