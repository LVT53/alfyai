import { describe, expect, it } from "vitest";
import type { ConversationListItem } from "$lib/types";
import { resolveActiveConversationTitle } from "./layout-title";

function sidebarConversation(id: string, title: string): ConversationListItem {
	return {
		id,
		title,
		updatedAt: 1,
		projectId: null,
		sidebarPinned: false,
		sidebarSortOrder: null,
	};
}

describe("resolveActiveConversationTitle", () => {
	it("uses the active page conversation title before stale sidebar snapshots", () => {
		const title = resolveActiveConversationTitle({
			routeConversationId: "conv-2",
			conversationStore: [
				sidebarConversation("conv-1", "First chat"),
				sidebarConversation("conv-2", "Old sidebar title"),
			],
			shellConversations: [sidebarConversation("conv-2", "Old shell title")],
			pageData: {
				conversation: {
					id: "conv-2",
					title: "Fresh page detail title",
				},
			},
		});

		expect(title).toBe("Fresh page detail title");
	});

	it("falls back to sidebar titles outside a loaded chat detail payload", () => {
		const title = resolveActiveConversationTitle({
			routeConversationId: "conv-1",
			conversationStore: [sidebarConversation("conv-1", "Sidebar title")],
			shellConversations: [],
			pageData: null,
		});

		expect(title).toBe("Sidebar title");
	});
});
