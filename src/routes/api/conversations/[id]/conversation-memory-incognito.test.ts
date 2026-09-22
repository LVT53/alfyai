// Incognito, one-way (docs/plans/incognito-one-way-spec.md §1): the PATCH
// route is the enforcement point. `false` is refused unconditionally, and
// `true` is only legal while the conversation has no messages yet — the UI
// never asks for either of these any more (the switch is gone), so this is
// the defence-in-depth boundary for direct API callers.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	conversationHasMessages: vi.fn(),
	getConversation: vi.fn(),
	moveConversationToProject: vi.fn(),
	setConversationMemoryIncognito: vi.fn(),
	setConversationSidebarPinned: vi.fn(),
	updateConversationTitle: vi.fn(),
}));

vi.mock("$lib/server/services/conversation-detail/read-model", () => ({
	getConversationDetail: vi.fn(),
}));

vi.mock("$lib/server/services/cleanup", () => ({
	deleteConversationWithCleanup: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import {
	conversationHasMessages,
	getConversation,
	setConversationMemoryIncognito,
} from "$lib/server/services/conversations";
import { PATCH } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockConversationHasMessages = conversationHasMessages as ReturnType<
	typeof vi.fn
>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockSetConversationMemoryIncognito =
	setConversationMemoryIncognito as ReturnType<typeof vi.fn>;

type PatchEvent = Parameters<typeof PATCH>[0];

function makeEvent(body: unknown, id = "conv-1"): PatchEvent {
	return {
		request: new Request(`http://localhost/api/conversations/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
		locals: { user: { id: "user-1" } },
		params: { id },
		url: new URL(`http://localhost/api/conversations/${id}`),
		route: { id: "/api/conversations/[id]" },
	} as PatchEvent;
}

describe("PATCH /api/conversations/[id] — memoryIncognito is one-way", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
	});

	it("refuses memoryIncognito: false with 409 and changes nothing", async () => {
		const response = await PATCH(makeEvent({ memoryIncognito: false }));
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.error).toBe("incognito_is_one_way");
		expect(mockGetConversation).not.toHaveBeenCalled();
		expect(mockConversationHasMessages).not.toHaveBeenCalled();
		expect(mockSetConversationMemoryIncognito).not.toHaveBeenCalled();
	});

	it("refuses memoryIncognito: false even for a conversation that is not incognito yet", async () => {
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			memoryIncognito: false,
		});
		mockConversationHasMessages.mockResolvedValue(false);

		const response = await PATCH(makeEvent({ memoryIncognito: false }));
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.error).toBe("incognito_is_one_way");
		expect(mockSetConversationMemoryIncognito).not.toHaveBeenCalled();
	});

	it("refuses memoryIncognito: true once the conversation has messages", async () => {
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockConversationHasMessages.mockResolvedValue(true);

		const response = await PATCH(makeEvent({ memoryIncognito: true }));
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.error).toBe("incognito_requires_empty_conversation");
		expect(mockSetConversationMemoryIncognito).not.toHaveBeenCalled();
	});

	it("allows memoryIncognito: true for an empty conversation", async () => {
		mockGetConversation.mockResolvedValue({ id: "conv-1" });
		mockConversationHasMessages.mockResolvedValue(false);
		mockSetConversationMemoryIncognito.mockResolvedValue({
			id: "conv-1",
			memoryIncognito: true,
		});

		const response = await PATCH(makeEvent({ memoryIncognito: true }));
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.memoryIncognito).toBe(true);
		// No third argument: the service can only arm (see its own comment),
		// so there is no value here that could ever be `false`.
		expect(mockSetConversationMemoryIncognito).toHaveBeenCalledWith(
			"user-1",
			"conv-1",
		);
	});

	it("404s memoryIncognito: true for a conversation the user does not own", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await PATCH(makeEvent({ memoryIncognito: true }));
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.error).toMatch(/not found/i);
		expect(mockConversationHasMessages).not.toHaveBeenCalled();
	});

	it("rejects a non-boolean memoryIncognito with 400", async () => {
		const response = await PATCH(makeEvent({ memoryIncognito: "yes" }));
		const data = await response.json();

		expect(response.status).toBe(400);
		expect(data.error).toMatch(/boolean/i);
	});
});
