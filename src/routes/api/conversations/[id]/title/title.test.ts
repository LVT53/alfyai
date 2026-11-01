import type { RequestEvent } from "@sveltejs/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureConversationTitleMock } = vi.hoisted(() => ({
	ensureConversationTitleMock: vi.fn(),
}));

vi.mock("$lib/server/services/chat-turn/conversation-title", () => ({
	ensureConversationTitle: ensureConversationTitleMock,
}));

import { POST } from "./+server";

function makeEvent(user: Record<string, unknown> | null) {
	return {
		request: new Request("http://localhost/api/conversations/conv-1/title", {
			method: "POST",
			body: JSON.stringify({
				userMessage: "Write an email to my colleague in Hungarian",
				assistantResponse: "Here is a draft: Kedves Márk!",
			}),
		}),
		params: { id: "conv-1" },
		locals: { user },
	} as unknown as RequestEvent;
}

describe("POST /api/conversations/[id]/title", () => {
	beforeEach(() => {
		ensureConversationTitleMock.mockReset();
		ensureConversationTitleMock.mockResolvedValue("Email to a colleague");
	});

	it("hands back the conversation's title under the caller's own id", async () => {
		const response = await POST(makeEvent({ id: "user-1" }));

		expect(await response.json()).toEqual({ title: "Email to a colleague" });
		expect(ensureConversationTitleMock).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
	});

	it("answers with no title when naming the conversation failed", async () => {
		ensureConversationTitleMock.mockRejectedValue(new Error("model down"));

		const response = await POST(makeEvent({ id: "user-1" }));

		expect(await response.json()).toEqual({ title: null });
	});

	it("refuses a request with no signed-in user and names nothing", async () => {
		const response = await POST(makeEvent(null));

		expect(response.status).toBe(401);
		expect(ensureConversationTitleMock).not.toHaveBeenCalled();
	});
});
