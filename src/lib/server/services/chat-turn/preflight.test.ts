import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import type { ParsedChatTurnRequest, SkillPromptContext } from "./types";

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
	getLastMessage: vi.fn(),
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
	getLastMessage: mocks.getLastMessage,
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
		atlasMode: false,
		atlasProfile: null,
		atlasAction: "create",
		parentAtlasId: null,
		clientAtlasTurnId: null,
		...overrides,
	};
}

function makeHeavyRequest(): ParsedChatTurnRequest {
	return makeRequest({
		attachmentIds: ["attachment-1"],
		linkedSources: [
			{
				displayArtifactId: "display-artifact-1",
				promptArtifactId: "prompt-artifact-1",
				familyArtifactIds: ["family-artifact-1"],
				name: "Architecture notes",
				type: "document",
				mimeType: "text/markdown",
			},
		],
		pendingSkill: {
			id: "skill-1",
			ownership: "user",
			displayName: "Research Skill",
		},
	});
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

function makeSkillPromptContext(): SkillPromptContext {
	return {
		source: "active_session",
		sessionId: "session-1",
		sessionStatus: "active",
		skillId: "skill-1",
		skillOwnership: "user",
		skillKind: "user_skill",
		skillDisplayName: "Research Skill",
		skillDescription: "Helps with focused research.",
		skillInstructions: "Use the selected research process.",
		durationPolicy: "session",
		questionPolicy: "ask_when_needed",
		notesPolicy: "none",
		sourceScope: "current_conversation",
		skillVersion: 1,
		linkedSources: [],
	};
}

function resetPreflightMocks() {
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
	mocks.getLastMessage.mockResolvedValue(null);
}

describe("admitChatTurnStream", () => {
	beforeEach(() => {
		resetPreflightMocks();
	});

	it("admits a stream turn for an owned conversation", async () => {
		const { admitChatTurnStream } = await import("./preflight");
		const request = makeRequest();

		const result = await admitChatTurnStream({
			userId: "user-1",
			request,
		});

		expect(result).toEqual({
			ok: true,
			value: request,
		});
		expect(mocks.getConversation).toHaveBeenCalledWith("user-1", "conv-1");
	});

	it("rejects a stream turn when the conversation is missing or owned by someone else", async () => {
		const { admitChatTurnStream } = await import("./preflight");
		mocks.getConversation.mockResolvedValue(null);

		const result = await admitChatTurnStream({
			userId: "user-1",
			request: makeRequest(),
		});

		expect(result).toEqual({
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		});
	});

	it("does not run heavy turn-preparation dependencies during admission", async () => {
		const { admitChatTurnStream } = await import("./preflight");

		const result = await admitChatTurnStream({
			userId: "user-1",
			request: makeHeavyRequest(),
		});

		expect(result).toMatchObject({ ok: true });
		expect(mocks.assertPromptReadyAttachments).not.toHaveBeenCalled();
		expect(mocks.addConversationLinkedContextSources).not.toHaveBeenCalled();
		expect(mocks.resolveEffectiveSkillDefinition).not.toHaveBeenCalled();
		expect(mocks.resolveSkillPromptContext).not.toHaveBeenCalled();
		expect(mocks.startSkillSession).not.toHaveBeenCalled();
		expect(mocks.resolveReasoningDepthSelection).not.toHaveBeenCalled();
		expect(mocks.getLastMessage).not.toHaveBeenCalled();
	});
});

describe("prepareAdmittedChatTurn", () => {
	beforeEach(() => {
		resetPreflightMocks();
	});

	it("prepares an admitted stream turn into the eager preflight turn shape", async () => {
		const { admitChatTurnStream, prepareAdmittedChatTurn } = await import(
			"./preflight"
		);
		const skillPromptContext = makeSkillPromptContext();
		mocks.resolveSkillPromptContext.mockResolvedValue(skillPromptContext);
		const admitted = await admitChatTurnStream({
			userId: "user-1",
			request: makeRequest(),
		});
		expect(admitted.ok).toBe(true);
		if (!admitted.ok) return;

		const result = await prepareAdmittedChatTurn({
			userId: "user-1",
			admittedTurn: admitted.value,
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				conversationId: "conv-1",
				normalizedMessage: "Compare the migration paths.",
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
				},
				skillPromptContext,
			},
		});
		expect(mocks.getConversation).toHaveBeenCalledTimes(1);
	});
});

describe("preflightChatTurn", () => {
	beforeEach(() => {
		resetPreflightMocks();
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

	it("reads the last message with a bounded lookup instead of loading the full conversation history", async () => {
		const { preflightChatTurn } = await import("./preflight");

		await preflightChatTurn({
			userId: "user-1",
			request: makeRequest(),
		});

		// `getLastMessage` is the single-row bounded read; `listMessages` (the
		// full-history loader) is not part of this module's mocked surface at
		// all, so preflight would throw if it ever fell back to it.
		expect(mocks.getLastMessage).toHaveBeenCalledTimes(1);
		expect(mocks.getLastMessage).toHaveBeenCalledWith("conv-1");
	});

	it("keeps eager turn preparation responsible for skill prompt context", async () => {
		const { preflightChatTurn } = await import("./preflight");
		const skillPromptContext = makeSkillPromptContext();
		mocks.resolveSkillPromptContext.mockResolvedValue(skillPromptContext);

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest(),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				skillPromptContext,
				depthMetadata: {
					requested: "auto",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolveSkillPromptContext).toHaveBeenCalledWith({
			userId: "user-1",
			turn: expect.objectContaining({
				conversationId: "conv-1",
				depthMetadata: expect.objectContaining({
					requested: "auto",
					appliedProfile: "extended",
				}),
			}),
		});
	});

	it("carries forward explicit Max after a Depth Clarification when the composer depth is unchanged", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.getLastMessage.mockResolvedValue(
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
		);

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
		mocks.getLastMessage.mockResolvedValue(
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
		);

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
		mocks.getLastMessage.mockResolvedValue(
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
		);

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
		mocks.getLastMessage.mockResolvedValue(
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
		);

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
		// The conversation's last message (what a bounded `getLastMessage` read
		// returns) is the follow-up answer, not the earlier clarification —
		// carry-forward must not fire once a normal answer has been given.
		mocks.getLastMessage.mockResolvedValue({
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
		});

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
