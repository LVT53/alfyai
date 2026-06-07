import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DepthMetadata } from "$lib/types";
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
	listMessages: vi.fn(),
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
	addConversationLinkedContextSources:
		mocks.addConversationLinkedContextSources,
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

vi.mock("$lib/server/services/messages", () => ({
	listMessages: mocks.listMessages,
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

function makeAssistantClarificationMessage(depthMetadata: DepthMetadata) {
	return {
		id: "assistant-clarification-1",
		role: "assistant",
		content: "Which target should I use?",
		timestamp: Date.now(),
		depthMetadata,
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
		mocks.listMessages.mockResolvedValue([]);
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

	it("carries forward explicit Max after a Depth Clarification when the composer depth is unchanged", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.listMessages.mockResolvedValue([
			makeAssistantClarificationMessage({
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_max",
				modelId: "model1",
				modelDisplayName: "Previous Model",
				providerDisplayName: "Previous Provider",
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "multiple_plausible_targets",
					language: "en",
				},
			}),
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				reasoningDepth: "max",
				modelId: "model2",
				modelDisplayName: "Current Model",
				providerDisplayName: "Current Provider",
			}),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				depthMetadata: {
					requested: "max",
					appliedProfile: "maximum",
					fallback: false,
					classifierSource: "deterministic_bypass",
					constraintNote: "explicit_max",
					modelId: "model2",
					modelDisplayName: "Current Model",
					providerDisplayName: "Current Provider",
				},
			},
		});
		if (result.ok) {
			expect(result.value.depthMetadata).not.toHaveProperty("clarification");
			expect(result.value.depthMetadata).not.toHaveProperty("outcome");
		}
		expect(mocks.resolveReasoningDepthSelection).not.toHaveBeenCalled();
	});

	it("carries forward an Auto-resolved extended profile after a Depth Clarification", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.listMessages.mockResolvedValue([
			makeAssistantClarificationMessage({
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				classifierSource: "control_model",
				classifierModelSource: "selected_chat_model",
				classifierModelId: "model1",
				classifierModelDisplayName: "Classifier Model",
				signals: {
					groundingNeed: "useful",
					contextBreadth: "broad",
					outputRoom: "expanded",
					toolUse: "source_heavy",
				},
				modelId: "model1",
				modelDisplayName: "Previous Model",
				providerDisplayName: "Previous Provider",
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "multiple_plausible_targets",
					language: "en",
				},
			}),
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				reasoningDepth: "auto",
				modelId: "model2",
				modelDisplayName: "Current Model",
				providerDisplayName: "Current Provider",
			}),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
					fallback: false,
					classifierSource: "control_model",
					classifierModelSource: "selected_chat_model",
					classifierModelId: "model1",
					classifierModelDisplayName: "Classifier Model",
					signals: {
						groundingNeed: "useful",
						contextBreadth: "broad",
						outputRoom: "expanded",
						toolUse: "source_heavy",
					},
					modelId: "model2",
					modelDisplayName: "Current Model",
					providerDisplayName: "Current Provider",
				},
			},
		});
		expect(mocks.resolveReasoningDepthSelection).not.toHaveBeenCalled();
	});

	it("carries forward an Auto-resolved maximum profile after a Depth Clarification", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.listMessages.mockResolvedValue([
			makeAssistantClarificationMessage({
				requested: "auto",
				appliedProfile: "maximum",
				fallback: true,
				fallbackReason: "control_model_error",
				classifierSource: "control_model_fallback",
				classifierModelSource: "configured_model",
				classifierModelId: "provider:p1:m1",
				configuredClassifierModelId: "provider:p1:m1",
				modelId: "model1",
				modelDisplayName: "Previous Model",
				providerDisplayName: "Previous Provider",
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "classifier",
					language: "en",
				},
			}),
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				reasoningDepth: "auto",
				modelId: "model2",
				modelDisplayName: "Current Model",
				providerDisplayName: "Current Provider",
			}),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				depthMetadata: {
					requested: "auto",
					appliedProfile: "maximum",
					fallback: true,
					fallbackReason: "control_model_error",
					classifierSource: "control_model_fallback",
					classifierModelSource: "configured_model",
					classifierModelId: "provider:p1:m1",
					configuredClassifierModelId: "provider:p1:m1",
					modelId: "model2",
					modelDisplayName: "Current Model",
					providerDisplayName: "Current Provider",
				},
			},
		});
		expect(mocks.resolveReasoningDepthSelection).not.toHaveBeenCalled();
	});

	it("does not carry forward when the visible composer depth changed", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.listMessages.mockResolvedValue([
			makeAssistantClarificationMessage({
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
				classifierSource: "deterministic_bypass",
				constraintNote: "explicit_max",
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "multiple_plausible_targets",
					language: "en",
				},
			}),
		]);

		const request = makeRequest({ reasoningDepth: "auto" });
		const result = await preflightChatTurn({
			userId: "user-1",
			request,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolveReasoningDepthSelection).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
			request: expect.objectContaining({
				reasoningDepth: "auto",
			}),
		});
	});

	it("consumes carry-forward after one follow-up turn", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.listMessages.mockResolvedValue([
			makeAssistantClarificationMessage({
				requested: "auto",
				appliedProfile: "maximum",
				fallback: false,
				classifierSource: "control_model",
				outcome: "clarification_requested",
				clarification: {
					outcome: "ask",
					reason: "multiple_plausible_targets",
					language: "en",
				},
			}),
			{
				id: "user-follow-up-1",
				role: "user",
				content: "Use Acme as the target.",
				timestamp: Date.now() + 1,
			},
			{
				id: "assistant-answer-1",
				role: "assistant",
				content: "Here is the comparison.",
				timestamp: Date.now() + 2,
				depthMetadata: {
					requested: "auto",
					appliedProfile: "maximum",
					fallback: false,
					classifierSource: "control_model",
				},
			},
		]);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({ reasoningDepth: "auto" }),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolveReasoningDepthSelection).toHaveBeenCalled();
	});
});
