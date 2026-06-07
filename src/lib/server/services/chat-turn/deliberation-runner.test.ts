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

	it("runs one structured deliberation pass for extended depth", async () => {
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
				assumptions: ["The code should stay small."],
				userIntent: "Review implementation quality.",
				missingContextQuestions: [],
				evidenceNeeds: [],
				relevantFindings: ["The request is self-contained."],
				edgeCases: ["Retries may duplicate work."],
				finalAnswerGuidance: ["Mention lifecycle risks."],
			}),
			finishReason: "stop",
			usage: {
				inputTokens: 100,
				outputTokens: 40,
				totalTokens: 140,
			},
			model: {},
		});

		const onStatus = vi.fn();
		const result = await runNormalChatDeliberationPasses({
			...runParams(effort("extended")),
			onStatus,
		});

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(1);
		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledWith(
			expect.objectContaining({
				tools: {
					research_web: { __tool: "research_web" },
					memory_context: { __tool: "memory_context" },
				},
				maxToolSteps: 8,
			}),
		);
		expect(result.briefs).toHaveLength(1);
		expect(result.briefs[0]).toMatchObject({
			pass: 1,
			kind: "context_source_gap_review",
			brief: {
				userIntent: "Review implementation quality.",
				edgeCases: ["Retries may duplicate work."],
			},
		});
		expect(result.usage).toEqual({
			inputTokens: 100,
			outputTokens: 40,
			totalTokens: 140,
		});
		expect(result.depthMetadata?.appliedEffort?.dimensions).toContain(
			"deliberation_passes",
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-1",
				kind: "deliberation",
				status: "running",
				label: "Reviewing context and sources",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-1",
				kind: "deliberation",
				status: "done",
				label: "Reviewed context and sources",
			}),
		);
	});

	it("runs two structured deliberation passes for maximum depth", async () => {
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
				text: JSON.stringify({
					assumptions: [],
					userIntent: "Compare options.",
					missingContextQuestions: [],
					evidenceNeeds: [],
					relevantFindings: ["There are tradeoffs."],
					edgeCases: ["Cost may dominate."],
					finalAnswerGuidance: ["Compare constraints."],
				}),
				finishReason: "stop",
				usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
				model: {},
			})
			.mockResolvedValueOnce({
				text: JSON.stringify({
					answerRisks: ["Overstating certainty."],
					contradictionsOrTensions: [],
					missedUserNeeds: ["Budget sensitivity."],
					formatRequirements: ["Keep it concise."],
					mustInclude: ["Tradeoff summary."],
					shouldAvoid: ["Process narration."],
					finalAnswerGuidance: ["State uncertainty."],
				}),
				finishReason: "stop",
				usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
				model: {},
			});

		const result = await runNormalChatDeliberationPasses(
			runParams(effort("maximum")),
		);

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(2);
		expect(result.briefs.map((brief) => brief.pass)).toEqual([1, 2]);
		expect(result.usage).toEqual({
			inputTokens: 180,
			outputTokens: 80,
			totalTokens: 260,
		});
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
		mocks.runPlainNormalChatModelRun
			.mockResolvedValueOnce({
				text: JSON.stringify({
					assumptions: [],
					userIntent: "Reconcile source-heavy evidence.",
					missingContextQuestions: [],
					evidenceNeeds: [],
					relevantFindings: ["The answer depends on current sources."],
					edgeCases: [],
					finalAnswerGuidance: ["Keep source caveats visible."],
				}),
				finishReason: "stop",
				usage: { inputTokens: 90, outputTokens: 40, totalTokens: 130 },
				model: {},
			})
			.mockResolvedValueOnce({
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

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(2);
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
			inputTokens: 160,
			outputTokens: 65,
			totalTokens: 225,
		});
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "running",
				label: "Reconciling sources",
			}),
		);
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "done",
				label: "Reconciled sources",
			}),
		);
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
				text: JSON.stringify({
					assumptions: [],
					userIntent: "Review evidence.",
					missingContextQuestions: [],
					evidenceNeeds: [],
					relevantFindings: ["A source pass is needed."],
					edgeCases: [],
					finalAnswerGuidance: ["Do not overstate certainty."],
				}),
				finishReason: "stop",
				usage: { inputTokens: 90, outputTokens: 40, totalTokens: 130 },
				model: {},
			})
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

		expect(mocks.runPlainNormalChatModelRun).toHaveBeenCalledTimes(3);
		expect(result.briefs).toHaveLength(1);
		expect(result.depthMetadata).toMatchObject({
			fallback: true,
			fallbackReason: "deliberation_constrained",
			appliedEffort: {
				constraints: ["deliberation_pass_2_constrained"],
			},
		});
		expect(result.usage).toEqual({
			inputTokens: 180,
			outputTokens: 75,
			totalTokens: 255,
		});
		expect(onStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "deliberation-pass-2",
				status: "error",
				label: "Reconciled sources",
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
			{ pass: 2, kind: "answer_plan_critique" },
		]);
	});

	it("expands high-cost deliberation only when depth signals warrant extra read-only passes", () => {
		const ordinaryMaximum = planDeliberationPasses(effort("maximum")).map(
			({ pass, kind }) => ({ pass, kind }),
		);
		expect(ordinaryMaximum).toEqual([
			{ pass: 1, kind: "context_source_gap_review" },
			{ pass: 2, kind: "answer_plan_critique" },
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
		expect(input).toContain("Retries may duplicate work.");
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
