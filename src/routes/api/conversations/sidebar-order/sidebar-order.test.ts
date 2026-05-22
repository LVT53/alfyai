import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	listConversations: vi.fn(),
	savePinnedConversationSidebarOrder: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	listConversations,
	savePinnedConversationSidebarOrder,
} from "$lib/server/services/conversations";
import { PATCH } from "./+server";
import type { RequestEvent } from "./$types";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockListConversations = listConversations as ReturnType<typeof vi.fn>;
const mockSavePinnedConversationSidebarOrder =
	savePinnedConversationSidebarOrder as ReturnType<typeof vi.fn>;

function makePatchEvent(body: unknown): RequestEvent {
	return {
		request: new Request("http://localhost/api/conversations/sidebar-order", {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
		params: {},
		url: new URL("http://localhost/api/conversations/sidebar-order"),
		route: { id: "/api/conversations/sidebar-order" },
	} as unknown as RequestEvent;
}

describe("PATCH /api/conversations/sidebar-order", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockListConversations.mockResolvedValue([
			{
				id: "conv-2",
				title: "Pinned 2",
				projectId: null,
				sidebarPinned: true,
				sidebarSortOrder: 0,
				createdAt: 1,
				updatedAt: 1,
			},
		]);
	});

	it("persists pinned conversation order for the authenticated user", async () => {
		const response = await PATCH(
			makePatchEvent({ orderedIds: ["conv-2", "conv-1"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(mockSavePinnedConversationSidebarOrder).toHaveBeenCalledWith(
			"user-1",
			["conv-2", "conv-1"],
		);
		expect(data.conversations).toEqual([
			expect.objectContaining({
				id: "conv-2",
				sidebarPinned: true,
				sidebarSortOrder: 0,
			}),
		]);
	});

	it("rejects invalid ordered id payloads before service calls", async () => {
		const response = await PATCH(
			makePatchEvent({ orderedIds: ["conv-1", 12] }),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("orderedIds must be an array of conversation ids");
		expect(mockSavePinnedConversationSidebarOrder).not.toHaveBeenCalled();
	});
});
