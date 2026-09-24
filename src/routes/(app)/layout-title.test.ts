import { describe, expect, it } from "vitest";
import type { ConversationListItem } from "$lib/server/services/conversations";
import {
	resolveActiveConversationIncognito,
	resolveActiveConversationTitle,
} from "./layout-title";

function sidebarConversation(
	id: string,
	title: string,
	memoryIncognito?: boolean,
): ConversationListItem {
	return {
		id,
		title,
		updatedAt: 1,
		projectId: null,
		sidebarPinned: false,
		sidebarSortOrder: null,
		...(memoryIncognito !== undefined ? { memoryIncognito } : {}),
	};
}

describe("resolveActiveConversationTitle", () => {
	// A stale store row on arrival is no longer the resolver's problem: the
	// chat page writes its freshly-loaded title into the store when it lands
	// on a conversation (page-runtime.test.ts pins that).
	it("shows a title that landed in the conversations store after the page loaded", () => {
		// A generated title (or a sidebar rename) updates the shared
		// conversations store, never the already-loaded page data, which
		// still holds the title the conversation was opened with.
		const title = resolveActiveConversationTitle({
			routeConversationId: "conv-2",
			conversationStore: [sidebarConversation("conv-2", "Tidal Energy Basics")],
			shellConversations: [sidebarConversation("conv-2", "New Conversation")],
			pageData: {
				conversation: { id: "conv-2", title: "New Conversation" },
			},
		});

		expect(title).toBe("Tidal Energy Basics");
	});

	it("uses the page detail title while the store has no row for it yet", () => {
		const title = resolveActiveConversationTitle({
			routeConversationId: "conv-2",
			conversationStore: [sidebarConversation("conv-1", "First chat")],
			shellConversations: [sidebarConversation("conv-2", "Old shell title")],
			pageData: {
				conversation: { id: "conv-2", title: "Fresh page detail title" },
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

describe("resolveActiveConversationIncognito", () => {
	it("uses the active page conversation's own flag before stale sidebar snapshots", () => {
		const isIncognito = resolveActiveConversationIncognito({
			routeConversationId: "conv-2",
			conversationStore: [sidebarConversation("conv-2", "Old", false)],
			shellConversations: [sidebarConversation("conv-2", "Old", false)],
			pageData: {
				conversation: { id: "conv-2", title: "Fresh", memoryIncognito: true },
			},
		});

		expect(isIncognito).toBe(true);
	});

	it("falls back to sidebar flags outside a loaded chat detail payload", () => {
		const isIncognito = resolveActiveConversationIncognito({
			routeConversationId: "conv-1",
			conversationStore: [sidebarConversation("conv-1", "Title", true)],
			shellConversations: [],
			pageData: null,
		});

		expect(isIncognito).toBe(true);
	});

	it("defaults to false with no route conversation or no match", () => {
		expect(
			resolveActiveConversationIncognito({
				routeConversationId: null,
				conversationStore: [],
				shellConversations: [],
			}),
		).toBe(false);
		expect(
			resolveActiveConversationIncognito({
				routeConversationId: "conv-missing",
				conversationStore: [sidebarConversation("conv-1", "Title", true)],
				shellConversations: [],
			}),
		).toBe(false);
	});
});
