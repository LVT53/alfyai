import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	listEnabledProviderModels: vi.fn(),
	sendJsonControlMessage: vi.fn(),
}));

vi.mock("$lib/server/config-store", () => ({
	getConfig: mocks.getConfig,
}));

vi.mock("$lib/server/services/provider-models", () => ({
	listEnabledProviderModels: mocks.listEnabledProviderModels,
}));

vi.mock("$lib/server/services/providers", () => ({
	getProviderWithSecrets: mocks.getProviderWithSecrets,
}));

vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: mocks.sendJsonControlMessage,
}));

describe("Reasoning Depth Auto selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReturnValue({
			reasoningDepthClassifierModel: null,
		});
		mocks.getProviderWithSecrets.mockResolvedValue(null);
		mocks.listEnabledProviderModels.mockResolvedValue([]);
	});

	it("resolves Auto to the classifier-selected profile with bounded structured output", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for a careful comparison with tradeoffs.",
			}),
			rawResponse: {},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare two rollout strategies and recommend one with risks.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
			classifierModelSource: "selected_chat_model",
			classifierModelId: "model1",
			modelId: "model1",
			modelDisplayName: "Model One",
			providerDisplayName: "Provider One",
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			expect.stringContaining("Compare two rollout strategies"),
			"model1",
			expect.objectContaining({
				maxTokens: expect.any(Number),
				temperature: 0,
				jsonSchema: expect.objectContaining({
					name: "reasoning_depth_selection",
					strict: true,
				}),
			}),
		);
	});

	it("preserves compact classifier signals for downstream effort budgeting", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request needs current external evidence and broader context.",
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "source_heavy",
			}),
			rawResponse: {},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare the current release options with citations and risks.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			signals: {
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "source_heavy",
			},
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			expect.any(String),
			"model1",
			expect.objectContaining({
				jsonSchema: expect.objectContaining({
					schema: expect.objectContaining({
						properties: expect.objectContaining({
							groundingNeed: expect.any(Object),
							contextBreadth: expect.any(Object),
							outputRoom: expect.any(Object),
							toolUse: expect.any(Object),
						}),
					}),
				}),
			}),
		);
	});

	it("uses the admin-configured classifier model without changing final-answer model metadata", async () => {
		mocks.getConfig.mockReturnValue({
			reasoningDepthClassifierModel: "provider:provider-1:classifier-1",
		});
		mocks.getProviderWithSecrets.mockResolvedValueOnce({
			id: "provider-1",
			displayName: "Classifier Provider",
			enabled: true,
		});
		mocks.listEnabledProviderModels.mockResolvedValueOnce([
			{
				id: "classifier-1",
				displayName: "Classifier Mini",
				enabled: true,
			},
		]);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "standard",
				reason: "The request is direct.",
			}),
			rawResponse: {},
			modelId: "provider:provider-1:classifier-1",
			modelDisplayName: "Classifier Mini",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Summarize this in one paragraph.",
				reasoningDepth: "auto",
				modelId: "model2",
				modelDisplayName: "Answer Model",
				providerDisplayName: "Answer Provider",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			expect.any(String),
			"provider:provider-1:classifier-1",
			expect.any(Object),
		);
		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "control_model",
			classifierModelSource: "configured_model",
			classifierModelId: "provider:provider-1:classifier-1",
			modelId: "model2",
			modelDisplayName: "Answer Model",
			providerDisplayName: "Answer Provider",
		});
	});

	it("falls back to the selected chat model when the configured classifier model is unavailable", async () => {
		mocks.getConfig.mockReturnValue({
			reasoningDepthClassifierModel: "provider:provider-1:deleted-model",
		});
		mocks.getProviderWithSecrets.mockResolvedValueOnce({
			id: "provider-1",
			displayName: "Classifier Provider",
			enabled: true,
		});
		mocks.listEnabledProviderModels.mockResolvedValueOnce([]);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request needs careful planning.",
			}),
			rawResponse: {},
			modelId: "model2",
			modelDisplayName: "Answer Model",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Plan a careful rollout.",
				reasoningDepth: "auto",
				modelId: "model2",
				modelDisplayName: "Answer Model",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			expect.any(String),
			"model2",
			expect.any(Object),
		);
		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierModelSource: "selected_chat_model",
			classifierModelId: "model2",
			configuredClassifierModelId: "provider:provider-1:deleted-model",
			classifierModelFallbackReason: "configured_model_unavailable",
		});
	});

	it("falls back to the selected chat model when the configured classifier model has invalid format", async () => {
		mocks.getConfig.mockReturnValue({
			reasoningDepthClassifierModel: "nonexistent-model",
		});
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "standard",
				reason: "The request is direct.",
			}),
			rawResponse: {},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Summarize this.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			expect.any(String),
			"model1",
			expect.any(Object),
		);
		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierModelSource: "selected_chat_model",
			classifierModelId: "model1",
			configuredClassifierModelId: "nonexistent-model",
			classifierModelFallbackReason: "invalid_configured_model",
		});
	});

	it("bypasses the classifier for explicit Off and Max selections", async () => {
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const off = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Answer briefly.",
				reasoningDepth: "off",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
		});
		const max = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Prove the migration is safe.",
				reasoningDepth: "max",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
		});

		expect(off.metadata).toMatchObject({
			requested: "off",
			appliedProfile: "off",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_off",
		});
		expect(max.metadata).toMatchObject({
			requested: "max",
			appliedProfile: "maximum",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_max",
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("bypasses the classifier for Deep Research turns", async () => {
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Research the market.",
				reasoningDepth: "auto",
				deepResearchDepth: "standard",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "deep_research_bypass",
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("falls back to Standard when the classifier returns an invalid profile", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({ appliedProfile: "off", reason: "invalid" }),
			rawResponse: {},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Think hard, but not explicitly max.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: true,
			fallbackReason: "invalid_classifier_response",
			classifierSource: "control_model_fallback",
		});
	});

	it("falls back to Standard when the control model fails", async () => {
		mocks.sendJsonControlMessage.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const { resolveReasoningDepthSelection } = await import("./depth-selection");

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Compare plans.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages: async () => [],
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: true,
			fallbackReason: "control_model_error",
			classifierSource: "control_model_fallback",
		});
	});

	it("builds a small capped classification context from lightweight turn metadata", async () => {
		const {
			buildDepthClassificationContext,
			formatDepthClassificationPrompt,
		} = await import("./depth-selection");
		const longText = "x".repeat(10_000);
		const context = buildDepthClassificationContext({
			request: {
				normalizedMessage: longText,
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: Array.from({ length: 20 }, (_, index) => `att-${index}`),
				linkedSources: Array.from({ length: 20 }, (_, index) => ({
					displayArtifactId: `artifact-${index}`,
					name: `Source ${index} ${longText}`,
					type: "document",
				})),
				pendingSkill: {
					id: "skill-1",
					ownership: "user",
					displayName: "Migration critic",
				},
				activeDocumentArtifactId: "active-doc-1",
				personalityProfileId: "profile-1",
				forceWebSearch: true,
			},
			recentMessages: Array.from({ length: 12 }, (_, index) => ({
				role: index % 2 === 0 ? "user" : "assistant",
				content: `${index}:${longText}`,
			})),
		});
		const prompt = formatDepthClassificationPrompt(context);

		expect(context.userRequest.length).toBeLessThanOrEqual(2_000);
		expect(context.recentMessages).toHaveLength(4);
		expect(
			context.recentMessages.every(
				(message) => message.content.length <= 500,
			),
		).toBe(true);
		expect(context.selectedSources).toHaveLength(8);
		expect(
			context.selectedSources.every((source) => source.name.length <= 120),
		).toBe(true);
		expect(context.attachments).toEqual({
			count: 20,
			sampleIds: [
				"att-0",
				"att-1",
				"att-2",
				"att-3",
				"att-4",
				"att-5",
				"att-6",
				"att-7",
			],
		});
		expect(context.activeDocumentArtifactId).toBe("active-doc-1");
		expect(context.composerState).toMatchObject({
			forceWebSearch: true,
			hasPendingSkill: true,
			pendingSkillName: "Migration critic",
			hasPersonalityProfile: true,
		});
		expect(prompt.length).toBeLessThanOrEqual(6_000);
	});
});
