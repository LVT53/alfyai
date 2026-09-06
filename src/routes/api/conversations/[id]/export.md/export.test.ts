import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/conversation-detail/read-model", () => ({
	getConversationDetail: vi.fn(),
}));

import { getConversationDetail } from "$lib/server/services/conversation-detail/read-model";
import { GET } from "./+server";

const mockGetConversationDetail = vi.mocked(getConversationDetail);

function makeEvent(id = "conv-1") {
	return {
		locals: { user: { id: "user-1", role: "user" } },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/export.md`),
		route: { id: "/api/conversations/[id]/export.md" },
	} as Parameters<typeof GET>[0];
}

describe("GET /api/conversations/[id]/export.md", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders user/assistant turns and tool-call summaries as Markdown", async () => {
		mockGetConversationDetail.mockResolvedValue({
			conversation: {
				id: "conv-1",
				title: "Weekend Trip Planning",
				sidebarPinned: false,
				sidebarSortOrder: null,
				createdAt: 1,
				updatedAt: 2,
			},
			messages: [
				{
					id: "m1",
					role: "user",
					content: "Find flights to Lisbon",
					timestamp: 1700000000000,
				},
				{
					id: "m2",
					role: "assistant",
					content: "Here are three options.",
					timestamp: 1700000005000,
					thoughtSteps: [
						{
							id: "step-1",
							source: "event",
							activityClass: "tool_call:search_web",
							impliesExternalAction: true,
							anchor: null,
							entity: "flight search",
							summary: "Searched the web for flights to Lisbon",
						},
						{
							id: "step-2",
							source: "classified",
							activityClass: "reasoning_active",
							impliesExternalAction: false,
							anchor: null,
						},
					],
				},
			],
		} as Awaited<ReturnType<typeof getConversationDetail>>);

		const response = await GET(makeEvent());
		const body = await response.text();

		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Type")).toContain("text/markdown");
		expect(response.headers.get("Content-Disposition")).toContain(
			'filename="Weekend-Trip-Planning.md"',
		);
		expect(body).toContain("# Weekend Trip Planning");
		expect(body).toContain("## User");
		expect(body).toContain("Find flights to Lisbon");
		expect(body).toContain("## Assistant");
		expect(body).toContain(
			"- Tool call: flight search — Searched the web for flights to Lisbon",
		);
		expect(body).toContain("Here are three options.");
		expect(body).not.toContain("reasoning_active");
	});

	it("returns 404 when the conversation is not found or not owned by the user", async () => {
		mockGetConversationDetail.mockResolvedValue(null);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Conversation not found");
	});
});
