import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	registerActiveChatStream,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
type StopStreamEvent = Parameters<typeof POST>[0];

function makeEvent(body: unknown, userId = "user-1"): StopStreamEvent {
	return {
		request: new Request("http://localhost/api/chat/stream/stop", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: {
			user: {
				id: userId,
				email: "test@example.com",
			},
		},
		params: {},
		url: new URL("http://localhost/api/chat/stream/stop"),
		route: { id: "/api/chat/stream/stop" },
	} as StopStreamEvent;
}

describe("POST /api/chat/stream/stop", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns 400 when streamId is missing", async () => {
		const response = await POST(makeEvent({}));
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/streamId/i);
	});

	it("aborts an active stream for the current user", async () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-1",
			userId: "user-1",
			controller,
			conversationId: "conv-1",
		});

		const response = await POST(makeEvent({ streamId: "stream-1" }));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload.stopped).toBe(true);
		expect(controller.signal.aborted).toBe(true);

		unregisterActiveChatStream("stream-1", controller);
	});
});
