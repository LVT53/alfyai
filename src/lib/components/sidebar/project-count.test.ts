import { describe, expect, it } from "vitest";
import type { ConversationListItem } from "$lib/types";
import { countProjectConversations } from "./project-count";

const conv = (
	id: string,
	overrides: Partial<ConversationListItem> = {},
): ConversationListItem => ({
	id,
	title: id,
	updatedAt: 1,
	projectId: null,
	sidebarPinned: false,
	sidebarSortOrder: null,
	...overrides,
});

describe("countProjectConversations", () => {
	it("returns 0 when no conversations match the project id", () => {
		expect(
			countProjectConversations(
				[conv("a", { projectId: "other" })],
				"project-1",
			),
		).toBe(0);
	});

	it("counts conversations whose projectId matches", () => {
		const list = [
			conv("a", { projectId: "project-1" }),
			conv("b", { projectId: "project-1" }),
			conv("c", { projectId: "other" }),
			conv("d", { projectId: null }),
		];
		expect(countProjectConversations(list, "project-1")).toBe(2);
	});

	it("excludes pinned conversations (they are shown globally)", () => {
		const list = [
			conv("a", { projectId: "project-1", sidebarPinned: false }),
			conv("b", { projectId: "project-1", sidebarPinned: true }),
		];
		expect(countProjectConversations(list, "project-1")).toBe(1);
	});

	it("treats a missing projectId as no match", () => {
		const list = [
			conv("a", { projectId: undefined }),
			conv("b", { projectId: null }),
		];
		expect(countProjectConversations(list, "project-1")).toBe(0);
	});

	it("returns 0 for an empty list", () => {
		expect(countProjectConversations([], "project-1")).toBe(0);
	});
});
