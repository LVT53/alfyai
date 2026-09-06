import { beforeEach, describe, expect, it, vi } from "vitest";
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
		reasoningDepth: "thorough",
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
			requested: "thorough",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
			modelId: "model1",
			modelDisplayName: "Model One",
			providerDisplayName: "Provider One",
		},
	});
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
					requested: "thorough",
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
					requested: "thorough",
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
				reasoningDepth: "thorough",
			}),
		});
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
					requested: "thorough",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolveSkillPromptContext).toHaveBeenCalledWith({
			userId: "user-1",
			turn: expect.objectContaining({
				conversationId: "conv-1",
				depthMetadata: expect.objectContaining({
					requested: "thorough",
					appliedProfile: "extended",
				}),
			}),
		});
	});

});
