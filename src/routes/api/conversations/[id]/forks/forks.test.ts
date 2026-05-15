import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-forks", () => ({
	ConversationForkError: class ConversationForkError extends Error {
		constructor(
			public code: string,
			message: string,
			public status = 400,
		) {
			super(message);
			this.name = "ConversationForkError";
		}
	},
	createConversationFork: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	ConversationForkError,
	createConversationFork,
} from "$lib/server/services/conversation-forks";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockCreateConversationFork = createConversationFork as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, id = "source-conv") {
	return {
		request: new Request(`http://localhost/api/conversations/${id}/forks`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1", role: "user", uiLanguage: "en" } },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/forks`),
		route: { id: "/api/conversations/[id]/forks" },
	} as Parameters<typeof POST>[0];
}

describe("POST /api/conversations/[id]/forks", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockCreateConversationFork.mockResolvedValue({
			conversation: {
				id: "fork-conv",
				title: "Source title (fork 1)",
				projectId: "project-1",
				createdAt: 1,
				updatedAt: 1,
			},
			forkOrigin: {
				forkConversationId: "fork-conv",
				sourceConversationId: "source-conv",
				sourceAssistantMessageId: "assistant-1",
				sourceConversationIdAvailable: true,
				sourceAssistantMessageIdAvailable: true,
				copiedForkPointMessageId: "fork-assistant-1",
				sourceTitle: "Source title",
				forkSequence: 1,
				createdAt: 1,
			},
		});
	});

	it("delegates authenticated fork creation to the conversation fork service", async () => {
		const response = await POST(makeEvent({ messageId: "assistant-1" }));
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(mockCreateConversationFork).toHaveBeenCalledWith({
			userId: "user-1",
			sourceConversationId: "source-conv",
			sourceMessageId: "assistant-1",
		});
		expect(data.conversation).toMatchObject({ id: "fork-conv" });
		expect(data.forkOrigin).toMatchObject({
			copiedForkPointMessageId: "fork-assistant-1",
		});
	});

	it("rejects missing or invalid message ids before calling the service", async () => {
		const response = await POST(makeEvent({ messageId: "" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toBe("messageId is required");
		expect(mockCreateConversationFork).not.toHaveBeenCalled();
	});

	it("maps fork service eligibility failures to their status code", async () => {
		mockCreateConversationFork.mockRejectedValue(
			new ConversationForkError(
				"invalid_source_message",
				"Forks can only be created from a persisted assistant response",
				400,
			),
		);

		const response = await POST(makeEvent({ messageId: "user-1" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.code).toBe("invalid_source_message");
		expect(data.error).toBe(
			"Forks can only be created from a persisted assistant response",
		);
	});
});
