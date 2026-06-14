import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	appendToStreamBuffer,
	clearStreamBuffer,
	getOrCreateStreamBuffer,
} from "$lib/server/services/chat-turn/active-streams";
import { GET } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
type BufferGetEvent = Parameters<typeof GET>[0];

function makeEvent(search = "", userId = "user-1"): BufferGetEvent {
	return {
		locals: {
			user: {
				id: userId,
				email: "test@example.com",
			},
		},
		params: {},
		request: new Request(`http://localhost/api/chat/stream/buffer${search}`),
		route: { id: "/api/chat/stream/buffer" },
		url: new URL(`http://localhost/api/chat/stream/buffer${search}`),
	} as BufferGetEvent;
}

describe("GET /api/chat/stream/buffer", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		clearStreamBuffer("stream-buffer-existing");
		clearStreamBuffer("stream-buffer-other-user");
	});

	it("returns 400 when streamId is missing", async () => {
		const response = await GET(makeEvent());
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/streamId/i);
		expect(mockRequireAuth).toHaveBeenCalledOnce();
	});

	it("reports a missing buffer without exposing counts", async () => {
		const response = await GET(
			makeEvent("?streamId=stream-buffer-missing&conversationId=conv-missing"),
		);
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ exists: false });
	});

	it("returns 400 when conversationId is missing", async () => {
		const response = await GET(makeEvent("?streamId=stream-buffer-missing"));
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/conversationId/i);
	});

	it("reports replay counts for an existing stream buffer", async () => {
		getOrCreateStreamBuffer({
			streamId: "stream-buffer-existing",
			userId: "user-1",
			conversationId: "conv-buffer-existing",
			userMessage: "original question",
			reasoningDepth: "max",
		});
		appendToStreamBuffer("stream-buffer-existing", "token", { text: "Hello" });
		appendToStreamBuffer("stream-buffer-existing", "token", { text: " world" });
		appendToStreamBuffer("stream-buffer-existing", "thinking", {
			text: "Need evidence",
		});
		appendToStreamBuffer("stream-buffer-existing", "tool_call", {
			name: "web_search",
			input: { query: "current evidence" },
			status: "running",
		});

		try {
			const response = await GET(
				makeEvent(
					"?streamId=stream-buffer-existing&conversationId=conv-buffer-existing",
				),
			);
			const payload = await response.json();

			expect(response.status).toBe(200);
			expect(payload).toEqual({
				exists: true,
				userMessage: "original question",
				reasoningDepth: "max",
				tokenCount: 2,
				thinkingCount: 1,
				toolCallCount: 1,
				createdAt: expect.any(Number),
			});
		} finally {
			clearStreamBuffer("stream-buffer-existing");
		}
	});

	it("does not report another user's stream buffer by stream id", async () => {
		getOrCreateStreamBuffer({
			streamId: "stream-buffer-other-user",
			userId: "user-2",
			conversationId: "conv-buffer-other-user",
			userMessage: "private question",
		});
		appendToStreamBuffer("stream-buffer-other-user", "token", {
			text: "private answer",
		});

		try {
			const response = await GET(
				makeEvent(
					"?streamId=stream-buffer-other-user&conversationId=conv-buffer-other-user",
				),
			);
			const payload = await response.json();

			expect(response.status).toBe(200);
			expect(payload).toEqual({ exists: false });
		} finally {
			clearStreamBuffer("stream-buffer-other-user");
		}
	});
});
