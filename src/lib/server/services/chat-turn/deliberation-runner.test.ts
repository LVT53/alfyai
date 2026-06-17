import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ReasoningDepthEffort } from "./reasoning-depth-effort";

const mocks = vi.hoisted(() => ({
	runPlainNormalChatModelRun: vi.fn(),
	createNormalChatTools: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-model", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-model")
		>();
	return {
		...actual,
		runPlainNormalChatModelRun: mocks.runPlainNormalChatModelRun,
	};
});

vi.mock("$lib/server/services/normal-chat-tools", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-tools")
		>();
	return {
		...actual,
		createNormalChatTools: mocks.createNormalChatTools,
	};
});

import {
	appendDeliberationBriefsToInput,
	planDeliberationPasses,
	runNormalChatDeliberationPasses,
	sumUsage,
} from "./deliberation-runner";

const provider = {
	id: "provider-1",
	name: "fireworks",
	displayName: "Kimi",
	baseUrl: "https://api.example/v1",
	modelName: "kimi",
	apiKey: "secret",
};

const runtimeConfig = {
	requestTimeoutMs: 1_500,
	model1: {
		baseUrl: "https://api.example/v1",
		apiKey: "secret",
		modelName: "kimi",
		displayName: "Kimi",
		systemPrompt: "",
		maxTokens: 4096,
		reasoningEffort: null,
		thinkingType: null,
	},
	model2: {
		baseUrl: "https://unused.example/v1",
		apiKey: "",
		modelName: "unused",
		displayName: "Unused",
		systemPrompt: "",
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
	},
} as RuntimeConfig;

function effort(
	profile: "off" | "standard" | "extended" | "maximum",
): ReasoningDepthEffort {
	return {
		depthMetadata: {
			requested: profile === "maximum" ? "max" : "auto",
			appliedProfile: profile,
			fallback: false,
			appliedEffort: {
				dimensions: [
					"provider_reasoning",
					"output_room",
					"context_room",
					"grounding_guidance",
					"tool_steps",
					"source_budget",
				],
			},
		},
		contextLimits: {
			maxModelContext: 10_000,
			targetConstructedContext: 8_000,
			compactionUiThreshold: 7_000,
		},
		modelMaxOutputTokens: 4096,
		providerReasoning: {
			thinkingMode: "on",
			supported: true,
			constrained: false,
		},
		maxToolSteps: 24,
		webSourceBudget: {
			maxSources: 6,
			sourceExpansion: false,
		},
		grounding: {
			guidance: "careful",
			externalEvidence: "none",
			forceWebSearch: false,
		},
		constraints: [],
		clamps: [],
	};
}

function recorder() {
	const entries: unknown[] = [];
	return {
		record(entry: never) {
			entries.push(entry);
			return entry;
		},
		getEntries() {
			return [];
		},
	};
}

function runParams(depthEffort: ReasoningDepthEffort) {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		modelId: "provider:provider-1:model-1" as const,
		runtimeConfig,
		provider,
		depthEffort,
		preparedInputValue: "## Current User Message\nReview this implementation.",
		preparedSystemPrompt: "Base system prompt",
		language: "en" as const,
		turnId: "turn-1",
		recorder: recorder(),
	};
}

describe("runNormalChatDeliberationPasses", () => {
	beforeEach(() => {
		mocks.runPlainNormalChatModelRun.mockReset();
		mocks.createNormalChatTools.mockReset();
	});

	it("derives a focused workspace brief for extended depth", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});

		const onStatus = vi.fn();
		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("extended")),
			preparedInputValue:
				"## Current User Message\nReview this implementation. Retries may duplicate work. Recommend lifecycle risks.",
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).not.toHaveBeenCalled();
		expect(result.briefs).toHaveLength(1);
		expect(result.briefs[0]).toMatchObject({
			pass: 1,
			kind: "context_source_gap_review",
			brief: {
				userIntent: expect.stringContaining("Review this implementation."),
				edgeCases: expect.arrayContaining([
					expect.stringContaining("Retries may duplicate work."),
				]),
				finalAnswerGuidance: expect.arrayContaining([
					"Make one clear recommendation.",
				]),
			},
		});
		expect(result.usage).toEqual({
			inputTokens: undefined,
			outputTokens: undefined,
			totalTokens: undefined,
		});
		expect(result.depthMetadata?.appliedEffort?.dimensions).toContain(
			"deliberation_passes",
		);
		// RD-15: Extended's single pass is local-only → aggregate "Preparing workspace" status.
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-preparing",
				kind: "deliberation",
				status: "running",
				label: "Preparing workspace",
				passIndex: 0,
				passTotal: 1,
				passKind: "context_source_gap_review",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-preparing",
				kind: "deliberation",
				status: "done",
				label: "Prepared workspace",
				passIndex: 0,
				passTotal: 1,
				passKind: "context_source_gap_review",
			}),
		);
	});

	it("runs maximum depth with a model-calling first pass, parallel micro-checks, and a final viable alternatives preservation pass", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});
		// RD-13: Maximum's first pass is now a model call.
		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				assumptions: ["A clear recommendation is expected."],
				userIntent:
					"Compare options with evidence about budget data. Cost may dominate.",
				missingContextQuestions: [],
				evidenceNeeds: [
					{
						need: "Source-backed support for citation-sensitive claims",
						status: "still_needed",
					},
				],
				relevantFindings: ["Cost may dominate the comparison."],
				edgeCases: ["Preserve alternatives and switching criteria."],
				finalAnswerGuidance: [
					"Compare options and preserve switching criteria.",
				],
			}),
			finishReason: "stop",
			usage: { inputTokens: 120, outputTokens: 60, totalTokens: 180 },
			model: {},
		});

		const onStatus = vi.fn();
		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("maximum")),
			preparedInputValue:
				"## Current User Message\nCompare options with evidence about budget data. Cost may dominate. Preserve alternatives and switching criteria.",
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(result.briefs.map(({ pass, kind }) => ({ pass, kind }))).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "missed_user_need_check" },
			{ pass: 3, kind: "contradiction_risk_check" },
			{ pass: 4, kind: "final_format_style_check" },
			{ pass: 5, kind: "hungarian_parity_check" },
			{ pass: 6, kind: "viable_alternatives_preservation" },
		]);
		// Pass 1 brief comes from the model response.
		expect(result.briefs[0]).toMatchObject({
			pass: 1,
			kind: "context_source_gap_review",
			brief: {
				userIntent: expect.stringContaining("Compare options"),
				evidenceNeeds: expect.arrayContaining([
					expect.objectContaining({ status: "still_needed" }),
				]),
			},
		});
		expect(result.briefs[5]).toEqual(
			expect.objectContaining({
				brief: expect.objectContaining({
					viableAlternatives: expect.arrayContaining([
						expect.stringContaining("Preserve alternatives"),
					]),
					exitCriteria: expect.arrayContaining([
						expect.stringContaining("Source-backed"),
					]),
					finalAnswerGuidance: expect.arrayContaining([
						expect.stringContaining("Compare options"),
					]),
				}),
			}),
		);
		expect(result.usage).toEqual({
			inputTokens: 120,
			outputTokens: 60,
			totalTokens: 180,
		});
		// Issue 2: Only model-calling passes emit per-pass status.
		// Pass 1 is a model call (sequential). Passes 2-5 are local micro-checks
		// (silent). Pass 6 is local (silent).
		expect(onStatus).toHaveBeenCalledTimes(2);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-1",
				status: "running",
				passKind: "context_source_gap_review",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-1",
				status: "done",
				passKind: "context_source_gap_review",
			}),
		);
	});

	it("runs a dynamic read-only source pass with a compact generic brief", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});
		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				focusAreas: ["Conflicting source claims"],
				findings: ["Prefer primary sources when claims diverge."],
				risks: ["Do not merge stale and current figures."],
				openQuestions: ["Which source is authoritative?"],
				finalAnswerGuidance: ["Separate confirmed facts from caveats."],
			}),
			finishReason: "stop",
			usage: { inputTokens: 70, outputTokens: 25, totalTokens: 95 },
			model: {},
		});

		const sourceHeavy = effort("extended");
		sourceHeavy.depthMetadata.signals = {
			groundingNeed: "required",
			toolUse: "source_heavy",
		};
		const onStatus = vi.fn();

		const result = await runNormalChatDeliberationPasses({
			...runParams(sourceHeavy),
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(result.briefs).toHaveLength(2);
		expect(result.briefs[1]).toMatchObject({
			pass: 2,
			kind: "source_reconciliation",
			brief: {
				findings: ["Prefer primary sources when claims diverge."],
				risks: ["Do not merge stale and current figures."],
				finalAnswerGuidance: ["Separate confirmed facts from caveats."],
			},
		});
		expect(result.usage).toEqual({
			inputTokens: 70,
			outputTokens: 25,
			totalTokens: 95,
		});
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "running",
				label: expect.any(String),
				passIndex: 2,
				passTotal: 2,
				passKind: "source_reconciliation",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "done",
				label: "Reconciled sources",
				passIndex: 2,
				passTotal: 2,
				passKind: "source_reconciliation",
			}),
		);
	});

	it("derives the viable alternatives preservation pass from model-called first pass and focused workspace micro-checks", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
			},
			getToolCalls: () => [],
		});
		// RD-13: Maximum's first pass is a model call.
		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				assumptions: ["A clear recommendation is expected."],
				userIntent: "Compare options. Managed API remains fastest.",
				missingContextQuestions: [],
				evidenceNeeds: [
					{ need: "Evidence about procurement risk", status: "still_needed" },
				],
				relevantFindings: ["Managed API remains fastest."],
				edgeCases: ["Evidence about procurement risk may be needed."],
				finalAnswerGuidance: ["Make one clear recommendation."],
			}),
			finishReason: "stop",
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			model: {},
		});

		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("maximum")),
			preparedInputValue:
				"## Current User Message\nCompare options. Managed API remains fastest. Evidence about procurement risk may be needed.",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(result.briefs[5]).toMatchObject({
			kind: "viable_alternatives_preservation",
			brief: {
				viableAlternatives: expect.arrayContaining([
					expect.stringContaining("Evidence about procurement risk"),
				]),
				exitCriteria: expect.arrayContaining([
					expect.stringContaining("procurement risk"),
				]),
			},
		});
	});

	it("marks unrepaired dynamic pass output as constrained without crashing", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});
		mocks.runPlainNormalChatModelRun
			.mockResolvedValueOnce({
				text: "not json",
				finishReason: "stop",
				usage: { inputTokens: 70, outputTokens: 25, totalTokens: 95 },
				model: {},
			})
			.mockResolvedValueOnce({
				text: "still not json",
				finishReason: "stop",
				usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
				model: {},
			});

		const sourceHeavy = effort("extended");
		sourceHeavy.depthMetadata.signals = {
			groundingNeed: "required",
			toolUse: "source_heavy",
		};
		const onStatus = vi.fn();

		const result = await runNormalChatDeliberationPasses({
			...runParams(sourceHeavy),
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(2);
		expect(result.briefs).toHaveLength(1);
		expect(result.depthMetadata).toMatchObject({
			fallback: true,
			fallbackReason: "deliberation_constrained",
			appliedEffort: {
				constraints: ["deliberation_pass_2_constrained"],
			},
		});
		expect(result.usage).toEqual({
			inputTokens: 90,
			outputTokens: 35,
			totalTokens: 125,
		});
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "error",
				label: "Reconciled sources",
			}),
		);
	});

	it("falls back to local brief when Maximum first pass model call fails", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});
		mocks.runPlainNormalChatModelRun.mockRejectedValueOnce(
			new Error("Model unavailable"),
		);

		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("maximum")),
			preparedInputValue:
				"## Current User Message\nReview this implementation. Retries may duplicate work.",
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(result.briefs).toHaveLength(6);
		expect(result.briefs[0]).toMatchObject({
			pass: 1,
			kind: "context_source_gap_review",
			brief: {
				userIntent: expect.stringContaining("Review this implementation."),
			},
		});
		expect(result.depthMetadata?.appliedEffort?.constraints).toContain(
			"deliberation_pass_1_degraded",
		);
	});

	it("runs parallel mid-pipeline passes and survives one failure", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});

		const broadMaximum = effort("maximum");
		broadMaximum.depthMetadata.signals = {
			groundingNeed: "required",
			contextBreadth: "broad",
			outputRoom: "expanded",
			toolUse: "source_heavy",
		};

		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				assumptions: ["A clear recommendation is expected."],
				userIntent: "Compare options with evidence.",
				missingContextQuestions: [],
				evidenceNeeds: [],
				relevantFindings: ["Some finding"],
				edgeCases: [],
				finalAnswerGuidance: ["Make one clear recommendation."],
			}),
			finishReason: "stop",
			usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
			model: {},
		});
		mocks.runPlainNormalChatModelRun.mockRejectedValueOnce(
			new Error("Source reconciliation failed"),
		);
		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				focusAreas: ["Workspace context"],
				findings: ["Cross-document tension found."],
				risks: ["Stale context may mislead."],
				openQuestions: [],
				finalAnswerGuidance: ["Resolve workspace-level conflicts."],
			}),
			finishReason: "stop",
			usage: { inputTokens: 80, outputTokens: 40, totalTokens: 120 },
			model: {},
		});
		mocks.runPlainNormalChatModelRun.mockResolvedValueOnce({
			text: JSON.stringify({
				focusAreas: ["Edge cases"],
				findings: ["Counterexample found."],
				risks: ["Overclaiming risk."],
				openQuestions: [],
				finalAnswerGuidance: ["Qualify uncertain claims."],
			}),
			finishReason: "stop",
			usage: { inputTokens: 60, outputTokens: 30, totalTokens: 90 },
			model: {},
		});

		const onStatus = vi.fn();
		const result = await runNormalChatDeliberationPasses({
			...runParams(broadMaximum),
			preparedInputValue:
				"## Current User Message\nCompare options with evidence about budget data.",
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(4);
		expect(result.briefs).toHaveLength(8);
		expect(result.depthMetadata?.appliedEffort?.constraints).toContain(
			"deliberation_pass_2_constrained",
		);
		expect(result.briefs.some((b) => b.pass === 3)).toBe(true);
		expect(result.usage).toEqual({
			inputTokens: 240,
			outputTokens: 120,
			totalTokens: 360,
		});
		// Issue 2: Only model-calling parallel passes emit status.
		// Passes 2-4 are model calls, passes 5-8 are local micro-checks (silent).
		for (const pass of [2, 3, 4]) {
			expect(onStatus).toHaveBeenCalledWith(
				expect.objectContaining({
					id: `deliberation-pass-${pass}`,
					status: "running",
				}),
			);
		}
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "error",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-3",
				status: "done",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-4",
				status: "done",
			}),
		);
	});

	it("emits aggregate Preparing workspace status when all passes are local-only", async () => {
		mocks.createNormalChatTools.mockReturnValue({
			tools: {
				research_web: { __tool: "research_web" },
				memory_context: { __tool: "memory_context" },
				produce_file: { __tool: "produce_file" },
			},
			getToolCalls: () => [],
		});

		const onStatus = vi.fn();
		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("extended")),
			preparedInputValue: "## Current User Message\nSimple question.",
			onStatus,
		});

		expect(result.briefs).toHaveLength(1);
		expect(onStatus).toHaveBeenCalledTimes(2);
		expect(onStatus).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				id: "deliberation-pass-preparing",
				status: "running",
				label: "Preparing workspace",
			}),
		);
		expect(onStatus).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				id: "deliberation-pass-preparing",
				status: "done",
				label: "Prepared workspace",
			}),
		);
	});
});

describe("planDeliberationPasses", () => {
	it("maps depth profiles to the current deliberation pass sequence", () => {
		expect(planDeliberationPasses(effort("off"))).toEqual([]);
		expect(planDeliberationPasses(effort("standard"))).toEqual([]);
		expect(
			planDeliberationPasses(effort("extended")).map(({ pass, kind }) => ({
				pass,
				kind,
			})),
		).toEqual([{ pass: 1, kind: "context_source_gap_review" }]);
		expect(
			planDeliberationPasses(effort("maximum")).map(({ pass, kind }) => ({
				pass,
				kind,
			})),
		).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "missed_user_need_check" },
			{ pass: 3, kind: "contradiction_risk_check" },
			{ pass: 4, kind: "final_format_style_check" },
			{ pass: 5, kind: "hungarian_parity_check" },
			{ pass: 6, kind: "viable_alternatives_preservation" },
		]);
	});

	it("expands high-cost deliberation only when depth signals warrant extra read-only passes", () => {
		const ordinaryMaximum = planDeliberationPasses(effort("maximum")).map(
			({ pass, kind }) => ({ pass, kind }),
		);
		expect(ordinaryMaximum).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "missed_user_need_check" },
			{ pass: 3, kind: "contradiction_risk_check" },
			{ pass: 4, kind: "final_format_style_check" },
			{ pass: 5, kind: "hungarian_parity_check" },
			{ pass: 6, kind: "viable_alternatives_preservation" },
		]);

		const sourceHeavy = effort("extended");
		sourceHeavy.depthMetadata.signals = {
			groundingNeed: "required",
			toolUse: "source_heavy",
		};
		expect(
			planDeliberationPasses(sourceHeavy).map(({ pass, kind }) => ({
				pass,
				kind,
			})),
		).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "source_reconciliation" },
		]);

		const evidenceUseful = effort("extended");
		evidenceUseful.depthMetadata.signals = {
			groundingNeed: "useful",
		};
		expect(
			planDeliberationPasses(evidenceUseful).map(({ pass, kind }) => ({
				pass,
				kind,
			})),
		).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "evidence_gap_review" },
		]);

		const broadMaximum = effort("maximum");
		broadMaximum.depthMetadata.signals = {
			groundingNeed: "required",
			contextBreadth: "broad",
			outputRoom: "expanded",
			toolUse: "source_heavy",
		};
		expect(
			planDeliberationPasses(broadMaximum).map(({ pass, kind }) => ({
				pass,
				kind,
			})),
		).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "source_reconciliation" },
			{ pass: 3, kind: "workspace_synthesis" },
			{ pass: 4, kind: "adversarial_edge_case_check" },
			{ pass: 5, kind: "missed_user_need_check" },
			{ pass: 6, kind: "contradiction_risk_check" },
			{ pass: 7, kind: "final_format_style_check" },
			{ pass: 8, kind: "hungarian_parity_check" },
			{ pass: 9, kind: "viable_alternatives_preservation" },
		]);
	});
});

describe("deliberation prompt helpers", () => {
	it("appends transient deliberation guidance to final answer input", () => {
		const input = appendDeliberationBriefsToInput("Prepared prompt", [
			{
				pass: 1,
				kind: "context_source_gap_review",
				brief: {
					assumptions: [],
					userIntent: "Review implementation quality.",
					missingContextQuestions: [],
					evidenceNeeds: [],
					relevantFindings: [],
					edgeCases: ["Retries may duplicate work."],
					finalAnswerGuidance: ["Mention lifecycle risks."],
				},
			},
		]);

		expect(input).toContain("## Normal Chat Deliberation Guidance");
		expect(input).toContain(
			"Use the following transient review notes silently",
		);
		expect(input).toContain("preserving conditional alternatives");
		expect(input).toContain("Retries may duplicate work.");
		expect(input).toContain("intent: Review implementation quality.");
	});

	it("sums model usage across deliberation and final answer calls", () => {
		expect(
			sumUsage(
				{ inputTokens: 100, outputTokens: 40, totalTokens: 140 },
				{ inputTokens: 300, outputTokens: 90, totalTokens: 390 },
			),
		).toEqual({
			inputTokens: 400,
			outputTokens: 130,
			totalTokens: 530,
		});
	});
});
