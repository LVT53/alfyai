import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	moveConversationToProject: vi.fn(),
	setConversationSidebarPinned: vi.fn(),
	updateConversationTitle: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-detail/read-model", () => ({
	getConversationDetail: vi.fn(),
}));

vi.mock("$lib/server/services/cleanup", () => ({
	deleteConversationWithCleanup: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { deleteConversationWithCleanup } from "$lib/server/services/cleanup";
import { DELETE } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockDeleteConversationWithCleanup =
	deleteConversationWithCleanup as ReturnType<typeof vi.fn>;
type DeleteConversationEvent = Parameters<typeof DELETE>[0];

function makeEvent(
	user = { id: "user-1" },
	id = "conv-1",
): DeleteConversationEvent {
	return {
		request: new Request(`http://localhost/api/conversations/${id}`, {
			method: "DELETE",
		}),
		locals: { user },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}`),
		route: { id: "/api/conversations/[id]" },
	} as DeleteConversationEvent;
}

describe("DELETE /api/conversations/[id]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns cleanup metadata on success", async () => {
		mockDeleteConversationWithCleanup.mockResolvedValue({
			deletedArtifactIds: ["artifact-1"],
			preservedArtifactIds: ["artifact-2"],
		});

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.success).toBe(true);
		expect(data.deletedArtifactIds).toEqual(["artifact-1"]);
		expect(data.preservedArtifactIds).toEqual(["artifact-2"]);
		expect(mockDeleteConversationWithCleanup).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
		);
	});

	it("returns 404 when the conversation does not exist", async () => {
		mockDeleteConversationWithCleanup.mockResolvedValue(null);

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found/i);
	});

	it("returns 500 when cleanup throws", async () => {
		mockDeleteConversationWithCleanup.mockRejectedValue(
			new Error("cleanup failed"),
		);

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(500);
		expect(data.error).toMatch(/failed to fully delete conversation/i);
	});
});
