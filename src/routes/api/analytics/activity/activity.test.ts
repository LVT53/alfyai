import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionUser } from "$lib/server/services/auth-types";

const mocks = vi.hoisted(() => ({
	checkClientActivityRateLimit: vi.fn(() => true),
	recordClientActivityEvent: vi.fn(async () => undefined),
	getConversationUserId: vi.fn(
		async (_conversationId: string) => "user-1" as string | null,
	),
	messageBelongsToConversation: vi.fn(
		async (_messageId: string, _conversationId: string) => true,
	),
}));

vi.mock("$lib/server/services/activity-events", async () => {
	const actual = await vi.importActual<
		typeof import("$lib/server/services/activity-events")
	>("$lib/server/services/activity-events");
	return {
		...actual,
		checkClientActivityRateLimit: mocks.checkClientActivityRateLimit,
		recordClientActivityEvent: mocks.recordClientActivityEvent,
	};
});

vi.mock("$lib/server/services/conversations", () => ({
	getConversationUserId: mocks.getConversationUserId,
	messageBelongsToConversation: mocks.messageBelongsToConversation,
}));

import { POST } from "./+server";

function user(overrides: Partial<SessionUser> = {}): SessionUser {
	return {
		id: "user-1",
		email: "user@example.com",
		displayName: "User",
		role: "user",
		profilePicture: null,
		titleLanguage: "auto",
		uiLanguage: "en",
		...overrides,
	};
}

function event(body: unknown, sessionUser: SessionUser | null = user()) {
	return {
		request: {
			json: async () => body,
		},
		locals: { user: sessionUser },
	} as unknown as Parameters<typeof POST>[0];
}

describe("POST /api/analytics/activity", () => {
	beforeEach(() => {
		mocks.checkClientActivityRateLimit.mockReset();
		mocks.checkClientActivityRateLimit.mockReturnValue(true);
		mocks.recordClientActivityEvent.mockReset();
		mocks.recordClientActivityEvent.mockResolvedValue(undefined);
		mocks.getConversationUserId.mockReset();
		mocks.getConversationUserId.mockResolvedValue("user-1");
		mocks.messageBelongsToConversation.mockReset();
		mocks.messageBelongsToConversation.mockResolvedValue(true);
	});

	it("requires authentication", async () => {
		await expect(
			POST(
				event(
					{ kind: "composer_command", name: "model", conversationId: "conv-1" },
					null,
				),
			),
		).rejects.toMatchObject({ status: 302, location: "/login" });

		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("records a valid composer_command event", async () => {
		const response = await POST(
			event({
				kind: "composer_command",
				name: "model",
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
		expect(mocks.recordClientActivityEvent).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			messageId: null,
			kind: "composer_command",
			name: "model",
		});
	});

	it("accepts an optional messageId", async () => {
		await POST(
			event({
				kind: "follow_up_click",
				name: "Tell me more",
				conversationId: "conv-1",
				messageId: "message-1",
			}),
		);

		expect(mocks.messageBelongsToConversation).toHaveBeenCalledWith(
			"message-1",
			"conv-1",
		);
		expect(mocks.recordClientActivityEvent).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: "message-1" }),
		);
	});

	// messageId is caller-controlled independently of conversationId, and the
	// activity_events FK only proves the message exists somewhere. An id from
	// another conversation is dropped to null rather than trusted (the event
	// itself is still recorded — nothing in the read model depends on the
	// message attribution).
	it("drops a messageId that does not belong to the conversation", async () => {
		mocks.messageBelongsToConversation.mockResolvedValue(false);

		const response = await POST(
			event({
				kind: "follow_up_click",
				name: "Tell me more",
				conversationId: "conv-1",
				messageId: "message-of-another-conversation",
			}),
		);

		expect(response.status).toBe(200);
		expect(mocks.messageBelongsToConversation).toHaveBeenCalledWith(
			"message-of-another-conversation",
			"conv-1",
		);
		expect(mocks.recordClientActivityEvent).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: null }),
		);
	});

	it("does not look up a message when none was supplied", async () => {
		await POST(
			event({
				kind: "answer_now",
				name: "answer_now",
				conversationId: "conv-1",
			}),
		);

		expect(mocks.messageBelongsToConversation).not.toHaveBeenCalled();
		expect(mocks.recordClientActivityEvent).toHaveBeenCalledWith(
			expect.objectContaining({ messageId: null }),
		);
	});

	it("rejects an unknown kind", async () => {
		const response = await POST(
			event({ kind: "tool_call", name: "x", conversationId: "conv-1" }),
		);

		expect(response.status).toBe(400);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("rejects a missing conversationId", async () => {
		const response = await POST(
			event({ kind: "answer_now", name: "answer_now" }),
		);

		expect(response.status).toBe(400);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("rejects a name over 64 characters", async () => {
		const response = await POST(
			event({
				kind: "composer_command",
				name: "x".repeat(65),
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(400);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("rejects an empty name", async () => {
		const response = await POST(
			event({ kind: "composer_command", name: "", conversationId: "conv-1" }),
		);

		expect(response.status).toBe(400);
	});

	it("rejects invalid JSON", async () => {
		const response = await POST({
			request: {
				json: async () => {
					throw new SyntaxError("bad json");
				},
			},
			locals: { user: user() },
		} as unknown as Parameters<typeof POST>[0]);

		expect(response.status).toBe(400);
	});

	// A client may only report activity against its OWN conversation: the
	// caller controls conversationId entirely and activity_events rows are
	// FK-bound to conversations (cascading with them), so an unchecked id
	// lets one user attach rows to another user's conversation.
	it("rejects an event for a conversation owned by another user", async () => {
		mocks.getConversationUserId.mockResolvedValue("user-2");

		const response = await POST(
			event({
				kind: "composer_command",
				name: "model",
				conversationId: "conv-of-user-2",
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("rejects an event for a conversation that does not exist", async () => {
		mocks.getConversationUserId.mockResolvedValue(null);

		const response = await POST(
			event({
				kind: "answer_now",
				name: "answer_now",
				conversationId: "conv-missing",
			}),
		);

		expect(response.status).toBe(403);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});

	it("returns 429 when the per-user rate limit is exceeded", async () => {
		mocks.checkClientActivityRateLimit.mockReturnValue(false);

		const response = await POST(
			event({
				kind: "composer_command",
				name: "model",
				conversationId: "conv-1",
			}),
		);

		expect(response.status).toBe(429);
		expect(mocks.recordClientActivityEvent).not.toHaveBeenCalled();
	});
});
