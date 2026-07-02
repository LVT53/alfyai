import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	sendJsonControlMessage: vi.fn(),
	dbSelectResult: [] as Array<Record<string, unknown>>,
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
		mocks.sendJsonControlMessage.mockReset();
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
			modelId: "model1",
			modelDisplayName: "Model One",
			providerDisplayName: "Provider One",
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
		expect(result.metadata.timing?.recentMessagesMs).toBeUndefined();
		expect(result.metadata.timing?.classificationContextMs).toBeUndefined();
		expect(result.metadata.timing?.classifierModelResolutionMs).toBeUndefined();
		expect(result.metadata.timing?.controlModelClassifierMs).toBeUndefined();
		expect(result.metadata.classifierModelId).toBeUndefined();
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

	it("uses cheap deterministic rules for active-document requests", async () => {
		const listRecentMessages = vi.fn(async () => []);
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
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_rules",
			constraintNote: "cheap_auto_deterministic_rules",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_rules",
				appliedProfile: "standard",
			},
			signals: {
				groundingNeed: "possible",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "normal",
			},
		});
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("keeps source-grounded Auto cheap while preserving grounding signals", async () => {
		const listRecentMessages = vi.fn(async () => []);
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Using current public information, summarize what to verify before adopting Svelte 5. Cite sources if you search.",
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
			classifierSource: "deterministic_rules",
			signals: {
				groundingNeed: "useful",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "source_heavy",
			},
		});
		expect(listRecentMessages).not.toHaveBeenCalled();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("selects extended for clear multi-axis architecture tradeoffs without an AI classifier", async () => {
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare three architectures, include tradeoffs and failure modes, then recommend one.",
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
			fallback: false,
			classifierSource: "deterministic_rules",
			constraintNote: "cheap_auto_deterministic_rules",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_rules",
				appliedProfile: "extended",
			},
			signals: {
				groundingNeed: "none",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("keeps document-style memo prompts at standard depth", async () => {
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Draft a concise engineering decision memo for adding stream observability to Normal Chat. Use the sections Context, Decision, Consequences, and Rollout.",
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
			classifierSource: "deterministic_rules",
			signals: {
				groundingNeed: "none",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("keeps rollout planning prompts at standard depth unless they have stronger complexity signals", async () => {
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Create a 30-day rollout plan for changing an AI model reasoning-depth setting. Include checkpoints, metrics, risks, rollback criteria, and who should review the data.",
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
			classifierSource: "deterministic_rules",
			signals: {
				groundingNeed: "none",
				contextBreadth: "normal",
				outputRoom: "normal",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("reserves maximum for explicit or stacked high-risk terms", async () => {
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
			classifierSource: "deterministic_rules",
			signals: {
				groundingNeed: "none",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "normal",
			},
		});
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("ignores configured classifier model state because Auto no longer calls a classifier model", async () => {
		const { resolveReasoningDepthSelection } = await import(
			"./depth-selection"
		);

		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare rollout options and recommend a migration strategy.",
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

		expect(result.metadata).toMatchObject({
			requested: "auto",
			appliedProfile: "extended",
			fallback: false,
			classifierSource: "deterministic_rules",
			modelId: "model2",
			modelDisplayName: "Answer Model",
			providerDisplayName: "Answer Provider",
		});
		expect(result.metadata.classifierModelSource).toBeUndefined();
		expect(result.metadata.classifierModelId).toBeUndefined();
		expect(result.metadata.configuredClassifierModelId).toBeUndefined();
		expect(mocks.sendJsonControlMessage).not.toHaveBeenCalled();
	});

	it("bypasses rules for explicit Off and Max selections with default signals for Max", async () => {
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

	it("reuses previous turn signals for explicit Max when previous was extended", async () => {
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
});
