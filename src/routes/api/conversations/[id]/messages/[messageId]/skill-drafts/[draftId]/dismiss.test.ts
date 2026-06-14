import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAuth: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: vi.fn(),
}));

vi.mock("$lib/server/services/messages", () => ({
	SkillDraftTransitionError: class SkillDraftTransitionError extends Error {
		constructor(
			public code: string,
			message: string,
			public status = 409,
		) {
			super(message);
		}
	},
	isAssistantMessageForkCopy: vi.fn(),
	updateAssistantMessageSkillDraftStatus: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	isAssistantMessageForkCopy,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import { DELETE } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockIsAssistantMessageForkCopy = isAssistantMessageForkCopy as ReturnType<
	typeof vi.fn
>;
const mockUpdateAssistantMessageSkillDraftStatus =
	updateAssistantMessageSkillDraftStatus as ReturnType<typeof vi.fn>;

function makeEvent() {
	return {
		request: new Request(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1",
			{ method: "DELETE" },
		),
		locals: { user: { id: "owner-user", role: "user" } },
		params: { id: "conv-1", messageId: "msg-1", draftId: "draft-1" },
		url: new URL(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1",
		),
		route: {
			id: "/api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]",
		},
	} as Parameters<typeof DELETE>[0];
}

describe("DELETE /api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			userId: "owner-user",
		});
		mockIsAssistantMessageForkCopy.mockResolvedValue(false);
		mockUpdateAssistantMessageSkillDraftStatus.mockResolvedValue({
			id: "draft-1",
			status: "dismissed",
		});
	});

	it("dismisses an assistant Skill Draft through message metadata only", async () => {
		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.draft).toEqual({ id: "draft-1", status: "dismissed" });
		expect(mockGetConversation).toHaveBeenCalledWith("owner-user", "conv-1");
		expect(mockUpdateAssistantMessageSkillDraftStatus).toHaveBeenCalledWith({
			conversationId: "conv-1",
			messageId: "msg-1",
			draftId: "draft-1",
			status: "dismissed",
		});
	});

	it("returns a conflict for final-state draft transitions", async () => {
		mockUpdateAssistantMessageSkillDraftStatus.mockRejectedValue(
			new (
				await import("$lib/server/services/messages")
			).SkillDraftTransitionError(
				"skill_draft_transition_conflict",
				"Skill draft is already in a final state.",
				409,
			),
		);

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.errorKey).toBe("skill_draft_transition_conflict");
	});

	it("rejects dismissing inherited Skill Drafts on copied fork messages", async () => {
		mockIsAssistantMessageForkCopy.mockResolvedValue(true);

		const response = await DELETE(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.errorKey).toBe("skillDrafts.inheritedCopyBlocked");
		expect(mockIsAssistantMessageForkCopy).toHaveBeenCalledWith({
			conversationId: "conv-1",
			messageId: "msg-1",
		});
		expect(mockUpdateAssistantMessageSkillDraftStatus).not.toHaveBeenCalled();
	});
});
