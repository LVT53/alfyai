import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getConfig: vi.fn(),
	getProviderWithSecrets: vi.fn(),
	listEnabledProviderModels: vi.fn(),
	sendJsonControlMessage: vi.fn(),
	dbSelectResult: [] as Array<Record<string, unknown>>,
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

vi.mock("$lib/server/db", () => ({
	db: {
		select: vi.fn().mockReturnValue({
			from: vi.fn().mockReturnValue({
				where: vi.fn().mockReturnValue({
					orderBy: vi.fn().mockReturnValue({
						limit: vi.fn().mockImplementation(() => mocks.dbSelectResult),
					}),
				}),
			}),
		}),
	},
}));

describe("Reasoning Depth Auto selection", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getConfig.mockReset();
		mocks.getProviderWithSecrets.mockReset();
		mocks.listEnabledProviderModels.mockReset();
		mocks.sendJsonControlMessage.mockReset();
		mocks.getConfig.mockReturnValue({
			reasoningDepthClassifierModel: null,
		});
		mocks.getProviderWithSecrets.mockResolvedValue(null);
		mocks.listEnabledProviderModels.mockResolvedValue([]);
		mocks.dbSelectResult = [];
	});

	it("resolves simple Auto turns through the proactive standard fast path", async () => {
		const listRecentMessages = vi.fn(async () => []);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "What is 2 + 2?",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_fast_path",
			constraintNote: "simple_auto_standard_fast_path",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_fast_path",
				appliedProfile: "standard",
			},
			signals: {
				groundingNeed: "none",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "normal",
			},
		});
		expect(result.metadata.timing?.totalMs).toEqual(expect.any(Number));
		expect(result.metadata.timing?.totalMs).toBeGreaterThanOrEqual(0);
		expect(result.metadata.timing?.recentMessagesMs).toBeUndefined();
		expect(result.metadata.timing?.classificationContextMs).toBeUndefined();
		expect(result.metadata.timing?.classifierModelResolutionMs).toBeUndefined();
		expect(result.metadata.timing?.controlModelClassifierMs).toBeUndefined();
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("fast-paths benchmark prompts that explicitly forbid external resources", async () => {
		const listRecentMessages = vi.fn(async () => []);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Reply in one short sentence that this live stream benchmark is harmless. Do not use external tools, web search, or files.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_fast_path",
			constraintNote: "simple_auto_standard_fast_path",
		});
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("fast-paths direct production-check benchmark prompts", async () => {
		const listRecentMessages = vi.fn(async () => []);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Reply in one short sentence about keeping production checks repeatable. Do not use external tools, web search, or files.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_fast_path",
			constraintNote: "simple_auto_standard_fast_path",
		});
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("fast-paths simple direct turns with passive document carryover", async () => {
		const listRecentMessages = vi.fn(async () => []);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Ping!",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				activeDocumentArtifactId: "active-doc-1",
				personalityProfileId: "profile-1",
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_fast_path",
			constraintNote: "simple_auto_standard_fast_path",
		});
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("keeps the control classifier for explicit active-document requests", async () => {
		const listRecentMessages = vi.fn(async () => []);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for work over the active document.",
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "normal",
				toolUse: "normal",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Summarize this document.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				activeDocumentArtifactId: "active-doc-1",
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
			timing: {
				classifierAttempts: 1,
				classifierSource: "control_model",
				appliedProfile: "extended",
			},
		});
		expect(result.metadata.timing?.totalMs).toEqual(expect.any(Number));
		expect(result.metadata.timing?.recentMessagesMs).toEqual(
			expect.any(Number),
		);
		expect(result.metadata.timing?.classificationContextMs).toEqual(
			expect.any(Number),
		);
		expect(result.metadata.timing?.classifierModelResolutionMs).toEqual(
			expect.any(Number),
		);
		expect(result.metadata.timing?.controlModelClassifierMs).toEqual(
			expect.any(Number),
		);
		expect(JSON.stringify(result.metadata.timing)).not.toContain(
			"The request asks for work over the active document.",
		);
		expect(listRecentMessages).toHaveBeenCalledTimes(1);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps the control classifier for positive web and source requests", async () => {
		const listRecentMessages = vi.fn(async () => []);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for web-grounded source use.",
				groundingNeed: "useful",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "source_heavy",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Use web search and cite sources in one sentence.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
		});
		expect(listRecentMessages).toHaveBeenCalledTimes(1);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps the control classifier for short online lookup requests", async () => {
		const listRecentMessages = vi.fn(async () => []);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for online information.",
				groundingNeed: "useful",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "normal",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Find online information about Acme CRM.",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
		});
		expect(listRecentMessages).toHaveBeenCalledTimes(1);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps the control classifier for short ambiguous follow-ups", async () => {
		const listRecentMessages = vi.fn(async () => [
			{
				role: "assistant" as const,
				content: "The rollout has two high-risk migration options.",
			},
		]);
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request depends on previous context.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Why?",
				reasoningDepth: "auto",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "control_model",
		});
		expect(listRecentMessages).toHaveBeenCalledTimes(1);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("keeps the control classifier for complex Auto turns", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for comparison and planning.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare the rollout options and recommend a migration plan.",
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
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(1);
	});

	it("resolves Auto to the classifier-selected profile with schema-in-prompt and skipStructuredOutputs", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "extended",
				reason: "The request asks for a careful comparison with tradeoffs.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
				maxTokens: 256,
				temperature: 0,
				skipStructuredOutputs: true,
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
				reason:
					"The request needs current external evidence and broader context.",
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "source_heavy",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "provider:provider-1:classifier-1",
			modelDisplayName: "Classifier Mini",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model2",
			modelDisplayName: "Answer Model",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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

	it("bypasses the classifier for explicit Off and Max selections with default signals for Max", async () => {
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_bypass",
				appliedProfile: "off",
			},
		});
		expect(max.metadata).toMatchObject({
			requested: "max",
			appliedProfile: "maximum",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_max",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_bypass",
				appliedProfile: "maximum",
			},
			signals: {
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("reuses previous turn signals for Max when previous was extended", async () => {
		const previousSignals = {
			groundingNeed: "required",
			contextBreadth: "narrow",
			outputRoom: "concise",
			toolUse: "source_heavy",
		};
		mocks.dbSelectResult = [
			{
				metadataJson: JSON.stringify({
					depthMetadata: {
						appliedProfile: "extended",
						signals: previousSignals,
					},
				}),
			},
		];
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
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

		expect(result.metadata).toMatchObject({
			requested: "max",
			appliedProfile: "maximum",
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_max",
			signals: previousSignals,
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("uses default signals for Max when previous turn was standard", async () => {
		mocks.dbSelectResult = [
			{
				metadataJson: JSON.stringify({
					depthMetadata: {
						appliedProfile: "standard",
						signals: {
							groundingNeed: "none",
							contextBreadth: "normal",
							outputRoom: "normal",
							toolUse: "normal",
						},
					},
				}),
			},
		];
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
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

		expect(result.metadata).toMatchObject({
			requested: "max",
			appliedProfile: "maximum",
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_max",
			signals: {
				groundingNeed: "useful",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("falls back to deterministic keyword classifier when the classifier returns an invalid profile", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({ appliedProfile: "off", reason: "invalid" }),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			classifierSource: "deterministic_fallback",
		});
	});

	it("falls back to deterministic keyword classifier when the control model fails", async () => {
		mocks.sendJsonControlMessage.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

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
			classifierSource: "deterministic_fallback",
			timing: {
				classifierAttempts: 1,
				classifierSource: "deterministic_fallback",
				appliedProfile: "standard",
				fallbackReason: "control_model_error",
			},
		});
		expect(result.metadata.timing?.controlModelClassifierMs).toEqual(
			expect.any(Number),
		);
	});

	it("uses specific compact fallback metadata for classifier no-object failures", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		mocks.sendJsonControlMessage.mockRejectedValueOnce({
			name: "AI_NoObjectGeneratedError",
			message: "No object generated",
			text: "raw model output should not be exposed",
			response: {
				body: {
					choices: [
						{
							message: {
								content: "raw response body should not be exposed",
							},
						},
					],
				},
			},
			usage: {
				completion_tokens_details: {
					reasoning_tokens: 0,
				},
			},
			finishReason: "stop",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		try {
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
				fallbackReason: "control_model_no_object_generated",
				classifierSource: "deterministic_fallback",
			});
			expect(JSON.stringify(result.metadata)).not.toContain("raw model output");
			expect(JSON.stringify(result.metadata)).not.toContain(
				"raw response body",
			);
			expect(logSpy).toHaveBeenCalledWith(
				expect.stringContaining(
					"fallback_reason=control_model_no_object_generated",
				),
			);
		} finally {
			logSpy.mockRestore();
		}
	});

	it("retries with larger token budget on finish_reason length", async () => {
		mocks.sendJsonControlMessage
			.mockResolvedValueOnce({
				text: "",
				rawResponse: {
					choices: [{ finish_reason: "length" }],
				},
				modelId: "model1",
				modelDisplayName: "Model One",
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					appliedProfile: "extended",
					reason: "Multi-step analysis needed.",
				}),
				rawResponse: {
					choices: [{ finish_reason: "stop" }],
				},
				modelId: "model1",
				modelDisplayName: "Model One",
			});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Compare and analyze the tradeoffs.",
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
			appliedProfile: "extended",
			classifierSource: "control_model",
			timing: {
				classifierAttempts: 2,
				classifierSource: "control_model",
				appliedProfile: "extended",
			},
		});
		expect(result.metadata.timing?.controlModelClassifierMs).toEqual(
			expect.any(Number),
		);
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(2);
		expect(mocks.sendJsonControlMessage).toHaveBeenNthCalledWith(
			1,
			expect.any(String),
			"model1",
			expect.objectContaining({
				allowEmptyTextOnLengthFinish: true,
				maxTokens: 256,
			}),
		);
		expect(mocks.sendJsonControlMessage).toHaveBeenNthCalledWith(
			2,
			expect.any(String),
			"model1",
			expect.objectContaining({ maxTokens: 640 }),
		);
	});

	it("retries with larger token budget on truncated JSON", async () => {
		mocks.sendJsonControlMessage
			.mockResolvedValueOnce({
				text: '{"appliedProfile": "extended", "reason": "incomplete',
				rawResponse: {
					choices: [{ finish_reason: "stop" }],
				},
				modelId: "model1",
				modelDisplayName: "Model One",
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					appliedProfile: "extended",
					reason: "Multi-step analysis needed.",
				}),
				rawResponse: {
					choices: [{ finish_reason: "stop" }],
				},
				modelId: "model1",
				modelDisplayName: "Model One",
			});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Compare and analyze the tradeoffs.",
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
			appliedProfile: "extended",
			classifierSource: "control_model",
		});
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledTimes(2);
	});

	it("accepts field aliases in classifier response", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				reasoning_depth: "extended",
				reason: "Multi-step analysis needed.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Compare and analyze the tradeoffs.",
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
			appliedProfile: "extended",
			classifierSource: "control_model",
		});
	});

	it("maps non-standard profile values to valid enum values", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "deep",
				reason: "Deep analysis needed.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Deep analysis needed.",
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
			appliedProfile: "extended",
			classifierSource: "control_model",
		});
	});

	it("maps 'max' value to 'maximum' profile", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "max",
				reason: "Maximum effort needed.",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Maximum effort needed.",
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
			appliedProfile: "maximum",
			classifierSource: "control_model",
		});
	});

	it("normalizes common non-enum classifier values from reasoning models", async () => {
		mocks.sendJsonControlMessage.mockResolvedValueOnce({
			text: JSON.stringify({
				appliedProfile: "expert",
				reason: "high",
				groundingNeed: "low",
				contextBreadth: "high",
				outputRoom: "high",
				toolUse: "low",
			}),
			rawResponse: {
				choices: [{ finish_reason: "stop" }],
			},
			modelId: "model1",
			modelDisplayName: "Model One",
		});
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Compare and analyze failure modes.",
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
			appliedProfile: "maximum",
			classifierSource: "control_model",
			signals: {
				groundingNeed: "possible",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "none",
			},
		});
	});

	it("deterministic keyword classifier detects extended from keywords", async () => {
		mocks.sendJsonControlMessage.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Please compare and analyze the tradeoffs between these two architectures and evaluate which one is better.",
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
			appliedProfile: "extended",
			classifierSource: "deterministic_fallback",
			fallback: true,
		});
	});

	it("deterministic keyword classifier detects maximum from keywords", async () => {
		mocks.sendJsonControlMessage.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Provide a comprehensive security audit covering all edge cases and failure modes for this production system.",
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
			appliedProfile: "maximum",
			classifierSource: "deterministic_fallback",
			fallback: true,
		});
	});

	it("deterministic keyword classifier defaults to standard for simple messages", async () => {
		mocks.sendJsonControlMessage.mockRejectedValueOnce(
			new Error("provider unavailable"),
		);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Can you explain that again?",
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
			appliedProfile: "standard",
			classifierSource: "deterministic_fallback",
			fallback: true,
		});
	});

	it("builds a small capped classification context from lightweight turn metadata", async () => {
		const { buildDepthClassificationContext, formatDepthClassificationPrompt } =
			await import("./depth-selection");
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
					promptArtifactId: `artifact-${index}`,
					familyArtifactIds: [`artifact-${index}`],
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
			context.recentMessages.every((message) => message.content.length <= 500),
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
