import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));
vi.mock("$lib/server/services/messages", () => ({
	listMessages: vi.fn(),
}));

import { getConversation } from "$lib/server/services/conversations";
import type { ChatMessage } from "$lib/server/services/messages-types";
import { listMessages } from "$lib/server/services/messages";
import { GET } from "./+server";

const mockGetConversation = vi.mocked(getConversation);
const mockListMessages = vi.mocked(listMessages);

function makeEvent(id = "conv-1") {
	return {
		locals: { user: { id: "user-1", role: "user" } },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}/export.md`),
		route: { id: "/api/conversations/[id]/export.md" },
	} as Parameters<typeof GET>[0];
}

function mockConversation(title: string) {
	mockGetConversation.mockResolvedValue({
		id: "conv-1",
		title,
		sidebarPinned: false,
		sidebarSortOrder: null,
		createdAt: 1,
		updatedAt: 2,
	} as Awaited<ReturnType<typeof getConversation>>);
}

describe("GET /api/conversations/[id]/export.md", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders user/assistant turns and tool-call summaries as Markdown", async () => {
		mockConversation("Weekend Trip Planning");
		mockListMessages.mockResolvedValue([
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
		] as ChatMessage[]);

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

	it("exports the whole history, not just the read model's bounded window", async () => {
		mockConversation("Long thread");
		const history: ChatMessage[] = Array.from({ length: 250 }, (_, index) => ({
			id: `m${index}`,
			role: index % 2 === 0 ? "user" : "assistant",
			content: `turn-${index}`,
			timestamp: 1700000000000 + index,
		}));
		mockListMessages.mockResolvedValue(history);

		const response = await GET(makeEvent());
		const body = await response.text();

		expect(mockListMessages).toHaveBeenCalledWith("conv-1");
		expect(body).toContain("turn-0");
		expect(body).toContain("turn-149");
		expect(body).toContain("turn-249");
	});

	it("returns 404 when the conversation is not found or not owned by the user", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await GET(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toBe("Conversation not found");
		expect(mockListMessages).not.toHaveBeenCalled();
	});

	it("scopes the ownership lookup to the authenticated user", async () => {
		mockConversation("Scoped");
		mockListMessages.mockResolvedValue([]);

		await GET(makeEvent("conv-42"));

		expect(mockGetConversation).toHaveBeenCalledWith("user-1", "conv-42");
	});
});
