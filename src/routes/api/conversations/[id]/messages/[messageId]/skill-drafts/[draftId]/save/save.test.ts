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
	getAssistantMessageSkillDraft: vi.fn(),
	updateAssistantMessageSkillDraftStatus: vi.fn(),
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	createUserSkillDefinition: vi.fn(),
	deleteUserSkillDefinition: vi.fn(),
	getUserSkillDefinition: vi.fn(),
}));

import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import {
	createUserSkillDefinition,
	deleteUserSkillDefinition,
	getUserSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { POST } from "./+server";

const mockRequireAuth = requireAuth as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetAssistantMessageSkillDraft =
	getAssistantMessageSkillDraft as ReturnType<typeof vi.fn>;
const mockUpdateAssistantMessageSkillDraftStatus =
	updateAssistantMessageSkillDraftStatus as ReturnType<typeof vi.fn>;
const mockCreateUserSkillDefinition = createUserSkillDefinition as ReturnType<
	typeof vi.fn
>;
const mockDeleteUserSkillDefinition = deleteUserSkillDefinition as ReturnType<
	typeof vi.fn
>;
const mockGetUserSkillDefinition = getUserSkillDefinition as ReturnType<
	typeof vi.fn
>;

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
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			userId: "owner-user",
		});
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
		mockDeleteUserSkillDefinition.mockResolvedValue(true);
		mockGetUserSkillDefinition.mockResolvedValue(null);
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

	it("treats repeated saves with an existing saved skill id as idempotent", async () => {
		mockGetAssistantMessageSkillDraft.mockResolvedValue({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-existing",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: ["review notes"],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
		});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.skill).toEqual({ id: "skill-existing" });
		expect(data.draft).toMatchObject({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-existing",
		});
		expect(mockCreateUserSkillDefinition).not.toHaveBeenCalled();
		expect(mockUpdateAssistantMessageSkillDraftStatus).not.toHaveBeenCalled();
	});

	it("returns a conflict instead of saving a final-state draft", async () => {
		mockGetAssistantMessageSkillDraft.mockResolvedValue({
			id: "draft-1",
			status: "dismissed",
			displayName: "Meeting critic",
			description: "Review meeting notes.",
			instructions: "Find missing owners.",
			activationExamples: ["review notes"],
			durationPolicy: "next_message",
			questionPolicy: "none",
			notesPolicy: "none",
			sourceScope: "selected_sources_only",
		});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(data.errorKey).toBe("skill_draft_transition_conflict");
		expect(mockCreateUserSkillDefinition).not.toHaveBeenCalled();
		expect(mockUpdateAssistantMessageSkillDraftStatus).not.toHaveBeenCalled();
	});

	it("cleans up a duplicate created skill when another save already claimed the draft", async () => {
		mockCreateUserSkillDefinition.mockResolvedValue({ id: "skill-racing" });
		mockUpdateAssistantMessageSkillDraftStatus.mockResolvedValue({
			id: "draft-1",
			status: "saved",
			savedSkillId: "skill-existing",
		});
		mockGetUserSkillDefinition.mockResolvedValue({
			id: "skill-existing",
			displayName: "Meeting critic",
		});

		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(200);
		expect(data.skill).toMatchObject({ id: "skill-existing" });
		expect(mockDeleteUserSkillDefinition).toHaveBeenCalledWith(
			"owner-user",
			"skill-racing",
		);
		expect(mockGetUserSkillDefinition).toHaveBeenCalledWith(
			"owner-user",
			"skill-existing",
		);
	});
});
