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
	getAssistantMessageSkillDraft: vi.fn(),
	updateAssistantMessageSkillDraftStatus: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	createUserSkillDefinition: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import { createUserSkillDefinition } from "$lib/server/services/skills/user-skills";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetAssistantMessageSkillDraft = getAssistantMessageSkillDraft as ReturnType<
	typeof vi.fn
>;
const mockUpdateAssistantMessageSkillDraftStatus =
	updateAssistantMessageSkillDraftStatus as ReturnType<typeof vi.fn>;
const mockCreateUserSkillDefinition = createUserSkillDefinition as ReturnType<typeof vi.fn>;

function makeEvent() {
	return {
		request: new Request(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1/save",
			{ method: "POST" },
		),
		locals: { user: { id: "owner-user", role: "user" } },
		params: { id: "conv-1", messageId: "msg-1", draftId: "draft-1" },
		url: new URL(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1/save",
		),
		route: {
			id: "/api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]/save",
		},
	} as Parameters<typeof POST>[0];
}

describe("POST /api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]/save", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAuth.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mockGetConversation.mockResolvedValue({ id: "conv-1", userId: "owner-user" });
		mockGetAssistantMessageSkillDraft.mockResolvedValue({
			id: "draft-1",
			status: "proposed",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: ["review notes"],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
		});
		mockCreateUserSkillDefinition.mockResolvedValue({ id: "skill-1" });
		mockUpdateAssistantMessageSkillDraftStatus.mockResolvedValue({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-1",
		});
	});

	it("saves the assistant draft as a disabled private user skill owned by the caller", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(201);
		expect(data.skill).toEqual({ id: "skill-1" });
		expect(mockGetConversation).toHaveBeenCalledWith("owner-user", "conv-1");
		expect(mockCreateUserSkillDefinition).toHaveBeenCalledWith(
			"owner-user",
			expect.objectContaining({
				displayName: "Meeting critic",
				instructions: "Find missing owners.",
				enabled: false,
				creationSource: "ai_draft",
				sourceScope: "selected_sources_only",
			}),
		);
		expect(mockUpdateAssistantMessageSkillDraftStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				conversationId: "conv-1",
				messageId: "msg-1",
				draftId: "draft-1",
				status: "saved",
				savedSkillId: "skill-1",
			}),
		);
	});

	it("blocks saving when Composer Command Registry is disabled", async () => {
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: false });

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(404);
		expect(data.errorKey).toBe("composerCommandRegistry.disabled");
		expect(mockCreateUserSkillDefinition).not.toHaveBeenCalled();
	});

	it("does not read drafts from conversations outside the caller ownership boundary", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await POST(makeEvent());

		expect(response.status).toBe(404);
		expect(mockGetAssistantMessageSkillDraft).not.toHaveBeenCalled();
		expect(mockCreateUserSkillDefinition).not.toHaveBeenCalled();
	});
});
