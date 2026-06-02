import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	registerActiveChatStream,
	unregisterActiveChatStream,
} from "$lib/server/services/chat-turn/active-streams";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
type StatusGetEvent = Parameters<typeof GET>[0];

function makeEvent(search = ""): StatusGetEvent {
	return {
		locals: {
			user: {
				id: "user-1",
				email: "test@example.com",
			},
		},
		params: {},
		request: new Request(`http://localhost/api/chat/stream/status${search}`),
		route: { id: "/api/chat/stream/status" },
		url: new URL(`http://localhost/api/chat/stream/status${search}`),
	} as StatusGetEvent;
}

describe("GET /api/chat/stream/status", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("returns 400 when conversationId is missing", async () => {
		const response = await GET(makeEvent());
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/conversationId/i);
		expect(mockRequireAuth).toHaveBeenCalledOnce();
	});

	it("reports no orphaned stream for an idle conversation", async () => {
		const response = await GET(makeEvent("?conversationId=conv-status-idle"));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ hasOrphanedStream: false });
	});

	it("reports the active stream id for the conversation", async () => {
		const controller = new AbortController();
		registerActiveChatStream({
			streamId: "stream-status-1",
			userId: "user-1",
			controller,
			conversationId: "conv-status-active",
		});

		try {
			const response = await GET(
				makeEvent("?conversationId=conv-status-active"),
			);
			const payload = await response.json();

			expect(response.status).toBe(200);
			expect(payload).toEqual({
				hasOrphanedStream: true,
				streamId: "stream-status-1",
			});
		} finally {
			unregisterActiveChatStream("stream-status-1", controller);
		}
	});
});
