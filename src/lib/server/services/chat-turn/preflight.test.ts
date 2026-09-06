import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedChatTurnRequest } from "./types";

const mocks = vi.hoisted(() => ({
	getConversation: vi.fn(),
	assertPromptReadyAttachments: vi.fn(),
	isAttachmentReadinessError: vi.fn(),
	addConversationLinkedContextSources: vi.fn(),
	isLinkedContextSourceError: vi.fn(),
	resolvePendingSkillApplication: vi.fn(),
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
	resolvePendingSkillApplication: mocks.resolvePendingSkillApplication,
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
	mocks.resolvePendingSkillApplication.mockResolvedValue({ ok: false });
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
		expect(mocks.resolvePendingSkillApplication).not.toHaveBeenCalled();
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
		mocks.resolvePendingSkillApplication.mockResolvedValue({
			ok: true,
			skillId: "skill-1",
			skillOwnership: "user",
			skillKind: "user_skill",
			displayName: "Research Skill",
			envelope:
				'Skill "Research Skill" instructions — apply these for the rest of this turn:\n\nUse the selected research process.',
		});
		const admitted = await admitChatTurnStream({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
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
				appliedSkill: {
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Research Skill",
					instructionsEnvelope: expect.stringContaining(
						"Use the selected research process.",
					),
				},
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
				appliedSkill: null,
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

	it("forces the resolved skill's instructions into the turn when a pendingSkill is selected", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.resolvePendingSkillApplication.mockResolvedValue({
			ok: true,
			skillId: "skill-1",
			skillOwnership: "user",
			skillKind: "user_skill",
			displayName: "Research Skill",
			envelope:
				'Skill "Research Skill" instructions — apply these for the rest of this turn:\n\nUse the selected research process.',
		});

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
		});

		expect(result).toMatchObject({
			ok: true,
			value: {
				appliedSkill: {
					skillId: "skill-1",
					skillOwnership: "user",
					skillKind: "user_skill",
					skillDisplayName: "Research Skill",
				},
				depthMetadata: {
					requested: "thorough",
					appliedProfile: "extended",
				},
			},
		});
		expect(mocks.resolvePendingSkillApplication).toHaveBeenCalledWith({
			userId: "user-1",
			pendingSkill: {
				id: "skill-1",
				ownership: "user",
				displayName: "Research Skill",
			},
			requestText: "Compare the migration paths.",
		});
		// The catalogue still lists the skill this turn, so the forced envelope
		// has to say it is already loaded or the model calls use_skill again.
		const envelope =
			result.ok && result.value.appliedSkill?.instructionsEnvelope;
		expect(envelope).toContain("already loaded for this turn");
		expect(envelope).toContain("do not call use_skill for it");
		expect(envelope).toContain("Use the selected research process.");
	});

	it("rejects the turn when the pending skill is no longer available", async () => {
		const { preflightChatTurn } = await import("./preflight");
		mocks.resolvePendingSkillApplication.mockResolvedValue({ ok: false });

		const result = await preflightChatTurn({
			userId: "user-1",
			request: makeRequest({
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Research Skill",
				},
			}),
		});

		expect(result).toEqual({
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		});
	});
});
