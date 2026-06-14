import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	listMessages: vi.fn(),
	deleteMessages: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-forks", () => ({
	listChildForksBySourceMessages: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { deleteMessages, listMessages } from "$lib/server/services/messages";
import { DELETE } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockListMessages = listMessages as ReturnType<typeof vi.fn>;
const mockDeleteMessages = deleteMessages as ReturnType<typeof vi.fn>;
const mockListChildForksBySourceMessages =
	listChildForksBySourceMessages as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, id = "conv-1") {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/messages`, {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", role: "user", uiLanguage: "en" } },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/messages`),
		route: { id: "/api/conversations/[id]/messages" },
	} as Parameters<typeof DELETE>[0];
}

describe("DELETE /api/conversations/[id]/messages", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockListMessages.mockResolvedValue([
			{ id: "user-1", role: "user" },
			{ id: "assistant-1", role: "assistant" },
			{ id: "user-2", role: "user" },
			{ id: "assistant-2", role: "assistant" },
		]);
		mockListChildForksBySourceMessages.mockResolvedValue({});
		mockDeleteMessages.mockResolvedValue(undefined);
	});

	it("requires explicit confirmation before deleting assistant source history with child forks", async () => {
		mockListChildForksBySourceMessages.mockResolvedValue({
			"assistant-1": {
				count: 1,
				forks: [
					{
						conversationId: "fork-1",
						title: "Source (fork 1)",
						forkSequence: 1,
						createdAt: 1,
					},
				],
			},
		});

		const response = await DELETE(
			makeEvent({ messageIds: ["user-1", "assistant-1", "user-2"] }),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data).toEqual({
			error: "Forked source history requires confirmation",
			code: "forked_source_history_confirmation_required",
			errorKey: "fork.editWarning",
		});
		expect(mockDeleteMessages).not.toHaveBeenCalled();
	});

	it("deletes forked source history after explicit confirmation", async () => {
		mockListChildForksBySourceMessages.mockResolvedValue({
			"assistant-1": { count: 1, forks: [] },
		});

		const response = await DELETE(
			makeEvent({
				messageIds: ["user-1", "assistant-1"],
				confirmForkedSourceHistoryMutation: true,
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.deleted).toBe(2);
		expect(mockDeleteMessages).toHaveBeenCalledWith(["user-1", "assistant-1"]);
	});
});
