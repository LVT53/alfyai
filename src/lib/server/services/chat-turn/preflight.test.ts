import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedChatTurnRequest } from "./types";

const mocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	assertPromptReadyAttachments: vi.fn(),
	isAttachmentReadinessError: vi.fn(),
	addConversationLinkedContextSources: vi.fn(),
	isLinkedContextSourceError: vi.fn(),
	resolveSkillPromptContext: vi.fn(),
	skillSessionToPromptContext: vi.fn(),
	startSkillSession: vi.fn(),
	resolveEffectiveSkillDefinition: vi.fn(),
	resolveReasoningDepthSelection: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: vi.fn(() => ({
		composerCommandRegistryEnabled: true,
	})),
}));

vi.mock("$lib/server/services/conversations", () => ({
	getConversation: mocks.getConversation,
}));

vi.mock("$lib/server/services/knowledge", () => ({
	assertPromptReadyAttachments: mocks.assertPromptReadyAttachments,
	isAttachmentReadinessError: mocks.isAttachmentReadinessError,
}));

vi.mock("$lib/server/services/linked-context-sources", () => ({
	addConversationLinkedContextSources: mocks.addConversationLinkedContextSources,
	isLinkedContextSourceError: mocks.isLinkedContextSourceError,
}));

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	resolveSkillPromptContext: mocks.resolveSkillPromptContext,
	skillSessionToPromptContext: mocks.skillSessionToPromptContext,
}));

vi.mock("$lib/server/services/skills/sessions", () => ({
	startSkillSession: mocks.startSkillSession,
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	resolveEffectiveSkillDefinition: mocks.resolveEffectiveSkillDefinition,
}));

vi.mock("./depth-selection", () => ({
	resolveReasoningDepthSelection: mocks.resolveReasoningDepthSelection,
}));

function makeRequest(
	overrides: Partial<ParsedChatTurnRequest> = {},
): ParsedChatTurnRequest {
	return {
		conversationId: "conv-1",
		normalizedMessage: "Compare the migration paths.",
		modelId: "model1",
		modelDisplayName: "Model One",
		providerDisplayName: "Provider One",
		attachmentIds: [],
		linkedSources: [],
		pendingSkill: null,
		reasoningDepth: "auto",
		thinkingMode: "auto",
		forceWebSearch: false,
		skipPersistUserMessage: false,
		...overrides,
	};
}

describe("preflightChatTurn", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			title: "Conversation",
		});
		mocks.assertPromptReadyAttachments.mockResolvedValue(undefined);
		mocks.isAttachmentReadinessError.mockReturnValue(false);
		mocks.addConversationLinkedContextSources.mockResolvedValue([]);
		mocks.isLinkedContextSourceError.mockReturnValue(false);
		mocks.resolveSkillPromptContext.mockResolvedValue(null);
		mocks.resolveEffectiveSkillDefinition.mockResolvedValue({
			available: true,
		});
		mocks.resolveReasoningDepthSelection.mockResolvedValue({
			metadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
			},
		});
	});

	it("attaches resolved Reasoning Depth metadata to successful preflight turns", async () => {
		const { preflightChatTurn } = await import("./preflight");
		const request = makeRequest();

		const result = await preflightChatTurn({
			userId: "user-1",
			request,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				conversationId: "conv-1",
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
				},
			},
		});
		expect(mocks.resolveReasoningDepthSelection).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			request: expect.objectContaining({
				normalizedMessage: "Compare the migration paths.",
				reasoningDepth: "auto",
			}),
		});
	});
});
