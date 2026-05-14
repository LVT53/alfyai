import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/auth/hooks", () => ({
	requireAdmin: vi.fn(),
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
	createSystemSkillDefinition: vi.fn(),
	updateSystemSkillDefinition: vi.fn(),
}));

import { requireAdmin } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	getAssistantMessageSkillDraft,
	updateAssistantMessageSkillDraftStatus,
} from "$lib/server/services/messages";
import {
	createSystemSkillDefinition,
	updateSystemSkillDefinition,
} from "$lib/server/services/skills/user-skills";
import { POST } from "./+server";

const mockRequireAdmin = requireAdmin as ReturnType<typeof vi.fn>;
const mockGetConfig = getConfig as ReturnType<typeof vi.fn>;
const mockGetConversation = getConversation as ReturnType<typeof vi.fn>;
const mockGetAssistantMessageSkillDraft =
	getAssistantMessageSkillDraft as ReturnType<typeof vi.fn>;
const mockUpdateAssistantMessageSkillDraftStatus =
	updateAssistantMessageSkillDraftStatus as ReturnType<typeof vi.fn>;
const mockCreateSystemSkillDefinition =
	createSystemSkillDefinition as ReturnType<typeof vi.fn>;
const mockUpdateSystemSkillDefinition =
	updateSystemSkillDefinition as ReturnType<typeof vi.fn>;

function makeEvent(body?: unknown) {
	return {
		request: new Request(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1/publish",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			},
		),
		locals: { user: { id: "admin-user", role: "admin" } },
		params: { id: "conv-1", messageId: "msg-1", draftId: "draft-1" },
		url: new URL(
			"http://localhost/api/conversations/conv-1/messages/msg-1/skill-drafts/draft-1/publish",
		),
		route: {
			id: "/api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]/publish",
		},
	} as Parameters<typeof POST>[0];
}

describe("POST /api/conversations/[id]/messages/[messageId]/skill-drafts/[draftId]/publish", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRequireAdmin.mockReturnValue(undefined);
		mockGetConfig.mockReturnValue({ composerCommandRegistryEnabled: true });
		mockGetConversation.mockResolvedValue({
			id: "conv-1",
			userId: "admin-user",
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
		mockCreateSystemSkillDefinition.mockResolvedValue({
			id: "system-generated-1",
			ownership: "system",
			enabled: false,
			published: false,
		});
		mockUpdateAssistantMessageSkillDraftStatus.mockResolvedValue({
			id: "draft-1",
			status: "published",
			publishedSystemSkillId: "system-generated-1",
		});
	});

	it("blocks chat draft publishing so drafts do not become globally discoverable System Skills", async () => {
		const response = await POST(makeEvent());
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(mockRequireAdmin).toHaveBeenCalled();
		expect(mockGetConversation).toHaveBeenCalledWith("admin-user", "conv-1");
		expect(mockCreateSystemSkillDefinition).not.toHaveBeenCalled();
		expect(mockUpdateSystemSkillDefinition).not.toHaveBeenCalled();
		expect(data.errorKey).toBe("skillDrafts.publishDisabled");
	});

	it("does not update an existing System Skill from a chat draft", async () => {
		mockUpdateSystemSkillDefinition.mockResolvedValue({
			id: "system:meeting-critic",
			ownership: "system",
			published: false,
		});

		const response = await POST(
			makeEvent({ systemSkillId: "system:meeting-critic" }),
		);
		const data = await response.json();

		expect(response.status).toBe(409);
		expect(mockCreateSystemSkillDefinition).not.toHaveBeenCalled();
		expect(mockUpdateSystemSkillDefinition).not.toHaveBeenCalled();
		expect(data.errorKey).toBe("skillDrafts.publishDisabled");
	});

	it("does not read drafts from another user's private conversation even for admins", async () => {
		mockGetConversation.mockResolvedValue(null);

		const response = await POST(makeEvent());

		expect(response.status).toBe(404);
		expect(mockGetAssistantMessageSkillDraft).not.toHaveBeenCalled();
		expect(mockCreateSystemSkillDefinition).not.toHaveBeenCalled();
	});
});
