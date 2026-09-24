import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	InstructionSuggestionTransitionError: class InstructionSuggestionTransitionError extends Error {
		constructor(
			public code: string,
			message: string,
			public status = 409,
		) {
			super(message);
		}
	},
	updateAssistantMessageInstructionSuggestionStatus: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConversation } from "$lib/server/services/conversations";
import {
	InstructionSuggestionTransitionError,
	updateAssistantMessageInstructionSuggestionStatus,
} from "$lib/server/services/messages";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockUpdateStatus =
	updateAssistantMessageInstructionSuggestionStatus as ReturnType<typeof vi.fn>;

function makeEvent(body: unknown, id = "conv-1") {
	return {
		request: new Request(
			`http://localhost/api/conversations/${id}/instruction-suggestions`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			},
		),
		locals: { user: { id: "owner-user", role: "user" } },
		params: { id },
		url: new URL(
			`http://localhost/api/conversations/${id}/instruction-suggestions`,
		),
		route: { id: "/api/conversations/[id]/instruction-suggestions" },
	} as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/conversations/[id]/instruction-suggestions", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			userId: "owner-user",
		});
		mockUpdateStatus.mockResolvedValue({
			id: "suggestion-1",
			status: "reviewed",
			text: "Only suggest trains, no flights.",
			scope: { kind: "personal" },
			createdAt: 1_770_000_000_000,
		});
	});

	it("marks a pending suggestion reviewed through message metadata only", async () => {
		const response = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "reviewed",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.suggestion).toMatchObject({
			id: "suggestion-1",
			status: "reviewed",
		});
		expect(mockGetConversation).toHaveBeenCalledWith("owner-user", "conv-1");
		expect(mockUpdateStatus).toHaveBeenCalledWith({
			userId: "owner-user",
			conversationId: "conv-1",
			messageId: "msg-1",
			suggestionId: "suggestion-1",
			status: "reviewed",
		});
	});

	it("marks a pending suggestion dismissed", async () => {
		mockUpdateStatus.mockResolvedValue({
			id: "suggestion-1",
			status: "dismissed",
		});

		const response = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "dismissed",
			}),
		);

		expect(response.status).toBe(200);
		expect(mockUpdateStatus).toHaveBeenCalledWith(
			expect.objectContaining({ status: "dismissed" }),
		);
	});

	it("is idempotent when the same status is written twice", async () => {
		// The helper returns the existing row unchanged rather than throwing,
		// so a double click on Dismiss is a no-op the user never sees.
		mockUpdateStatus.mockResolvedValue({
			id: "suggestion-1",
			status: "dismissed",
		});

		const first = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "dismissed",
			}),
		);
		const second = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "dismissed",
			}),
		);

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect((await second.json()).suggestion).toMatchObject({
			status: "dismissed",
		});
	});

	it("409s a dismissed suggestion being set back to reviewed", async () => {
		mockUpdateStatus.mockRejectedValue(
			new InstructionSuggestionTransitionError(
				"instruction_suggestion_transition_conflict",
				"Instruction suggestion was dismissed and cannot be reviewed.",
				409,
			),
		);

		const response = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "reviewed",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.errorKey).toBe("instruction_suggestion_transition_conflict");
	});

	it("404s a message in another user's conversation", async () => {
		// The ownership check lives in the transition helper's own SELECT, so
		// a message that is not in this user's conversation resolves to null
		// exactly like a message that does not exist.
		mockUpdateStatus.mockResolvedValue(null);

		const response = await POST(
			makeEvent({
				messageId: "msg-of-someone-else",
				suggestionId: "suggestion-1",
				status: "reviewed",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("instructions.suggestionNotFound");
	});

	it("404s a conversation that is not the user's", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "reviewed",
			}),
		);

		expect(response.status).toBe(404);
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});

	it("400s a status a client may not write", async () => {
		const response = await POST(
			makeEvent({
				messageId: "msg-1",
				suggestionId: "suggestion-1",
				status: "pending",
			}),
		);
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.errorKey).toBe("instructions.suggestionInvalidStatus");
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});

	it("400s a body without a suggestion id", async () => {
		const response = await POST(
			makeEvent({ messageId: "msg-1", status: "reviewed" }),
		);

		expect(response.status).toBe(400);
		expect(mockUpdateStatus).not.toHaveBeenCalled();
	});

	it("requires auth before it reads anything", async () => {
		mockRequireAuth.mockImplementation(() => {
			throw new Error("unauthorized");
		});

		await expect(
			POST(
				makeEvent({
					messageId: "msg-1",
					suggestionId: "suggestion-1",
					status: "reviewed",
				}),
			),
		).rejects.toThrow("unauthorized");
		expect(mockGetConversation).not.toHaveBeenCalled();
	});
});
