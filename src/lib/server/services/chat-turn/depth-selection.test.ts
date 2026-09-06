import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveReasoningDepthSelection } from "./depth-selection";

describe("resolveReasoningDepthSelection (thinking toggle)", () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("maps the quick toggle to the off applied profile with no signals", async () => {
		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Answer briefly.",
				reasoningDepth: "quick",
				modelId: "model1",
				modelDisplayName: "Model One",
				providerDisplayName: "Provider One",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
		});

		expect(result.metadata).toMatchObject({
			requested: "quick",
			appliedProfile: "off",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_quick",
			modelId: "model1",
			modelDisplayName: "Model One",
			providerDisplayName: "Provider One",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_bypass",
				appliedProfile: "off",
			},
		});
		expect(result.metadata.signals).toBeUndefined();
		expect(result.metadata.timing?.totalMs).toEqual(expect.any(Number));
		expect(result.metadata.timing?.recentMessagesMs).toBeUndefined();
		expect(result.metadata.timing?.classificationContextMs).toBeUndefined();
		expect(result.metadata.timing?.classifierModelResolutionMs).toBeUndefined();
		expect(result.metadata).not.toHaveProperty("controlModelClassifierMs");
		expect(result.metadata).not.toHaveProperty("classifierModelId");
		expect(result.metadata).not.toHaveProperty("classifierModelSource");
		expect(result.metadata).not.toHaveProperty("configuredClassifierModelId");
		expect(result.metadata).not.toHaveProperty("classifierModelFallbackReason");
	});

	it("maps the thorough toggle to the standard applied profile with no signals", async () => {
		const result = await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage:
					"Compare three architectures, include tradeoffs and failure modes, then recommend one.",
				reasoningDepth: "thorough",
				modelId: "model2",
				modelDisplayName: "Answer Model",
				providerDisplayName: "Answer Provider",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
		});

		expect(result.metadata).toMatchObject({
			requested: "thorough",
			appliedProfile: "standard",
			fallback: false,
			classifierSource: "deterministic_bypass",
			constraintNote: "explicit_thorough",
			modelId: "model2",
			modelDisplayName: "Answer Model",
			providerDisplayName: "Answer Provider",
			timing: {
				classifierAttempts: 0,
				classifierSource: "deterministic_bypass",
				appliedProfile: "standard",
			},
		});
		expect(result.metadata.signals).toBeUndefined();
	});

	it("never touches the database — no classifier, no previous-turn signal reuse", async () => {
		const listRecentMessages = vi.fn(async () => []);

		await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Anything at all.",
				reasoningDepth: "thorough",
				modelId: "model1",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
				forceWebSearch: false,
			},
			listRecentMessages,
		});

		expect(listRecentMessages).not.toHaveBeenCalled();
	});

	it("logs a [THINKING] source=toggle line naming the resolved mode", async () => {
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		await resolveReasoningDepthSelection({
			userId: "user-1",
			conversationId: "conv-1",
			request: {
				normalizedMessage: "Hi",
				reasoningDepth: "quick",
				attachmentIds: [],
				linkedSources: [],
				pendingSkill: null,
			},
		});

		expect(logSpy).toHaveBeenCalledWith("[THINKING] source=toggle mode=quick");
	});
});
