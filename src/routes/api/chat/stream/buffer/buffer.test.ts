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

function makeEvent(search = ""): BufferGetEvent {
	return {
		locals: {
			user: {
				id: "user-1",
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
	});

	it("returns 400 when streamId is missing", async () => {
		const response = await GET(makeEvent());
		const payload = await response.json();

		expect(response.status).toBe(400);
		expect(payload.error).toMatch(/streamId/i);
		expect(mockRequireAuth).toHaveBeenCalledOnce();
	});

	it("reports a missing buffer without exposing counts", async () => {
		const response = await GET(makeEvent("?streamId=stream-buffer-missing"));
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(payload).toEqual({ exists: false });
	});

	it("reports replay counts for an existing stream buffer", async () => {
		getOrCreateStreamBuffer("stream-buffer-existing", "original question");
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
			const response = await GET(makeEvent("?streamId=stream-buffer-existing"));
			const payload = await response.json();

			expect(response.status).toBe(200);
			expect(payload).toEqual({
				exists: true,
				userMessage: "original question",
				tokenCount: 2,
				thinkingCount: 1,
				toolCallCount: 1,
			});
		} finally {
			clearStreamBuffer("stream-buffer-existing");
		}
	});
});
