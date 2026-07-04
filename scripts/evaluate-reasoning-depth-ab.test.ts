import { describe, expect, it } from "vitest";
import type { BenchmarkRunResult } from "./benchmark-live-chat-stream";
import {
	buildReasoningDepthEvaluationPlan,
	classifyPromptForLocalAuto,
	REASONING_DEPTH_AB_PROMPTS,
	REASONING_DEPTH_AB_VARIANTS,
	type ReasoningDepthAbScoreRow,
	scoreReasoningDepthRun,
	summarizeReasoningDepthEvaluation,
} from "./evaluate-reasoning-depth-ab";

/** find() with a clear error instead of a non-null assertion. Test fixtures
 *  are expected to exist; this fails loudly if one is misnamed/missing. */
function findOrFail<T>(
	items: readonly T[],
	predicate: (item: T) => boolean,
	label: string,
): T {
	const found = items.find(predicate);
	if (!found) throw new Error(`Test fixture not found: ${label}`);
	return found;
}

function okRun(
	overrides: Partial<BenchmarkRunResult> = {},
): BenchmarkRunResult {
	return {
		runIndex: 1,
		prompt: "prompt",
		modelId: "provider:local:qwen",
		startedAt: "2026-07-02T10:00:00.000Z",
		endedAt: "2026-07-02T10:00:20.000Z",
		chunkCount: 5,
		textLength: 400,
		answerText:
			"Context\nDecision\nConsequences\nRollout\narchitecture latency quality rollback evidence sources https://example.test/source. The answer compares adoption risks, version compatibility, migration effort, monitoring, testing, and release criteria. It names the evidence trail and explains how the team should validate quality before rollout. It also keeps the recommendation practical and measurable for production review.",
		firstTokenMs: 800,
		endMs: 4_000,
		toolCallCount: 1,
		toolCallNames: ["research_web"],
		depthMetadata: {
			requested: "auto",
			appliedProfile: "maximum",
			fallback: false,
			timing: {
				totalMs: 320,
				classifierAttempts: 1,
				classifierSource: "control_model",
				appliedProfile: "maximum",
				controlModelClassifierMs: 260,
			},
		},
		serverTiming: {},
		serverTimeline: { first_visible_token: 650, end: 3_700 },
		outcome: "ok",
		...overrides,
	};
}

describe("reasoning depth A/B evaluation plan", () => {
	it("covers the required prompt categories and live variants without inventing request depths", () => {
		const plan = buildReasoningDepthEvaluationPlan({
			modelId: "provider:local:qwen",
			runsPerPrompt: 2,
			generatedAt: "2026-07-02T10:00:00.000Z",
		});

		expect(plan.prompts.map((prompt) => prompt.category)).toEqual([
			"simple_direct",
			"complex_architecture_tradeoff",
			"source_grounded_current",
			"project_context_document_style",
			"debugging_refactor",
			"planning_recommendation",
			"hungarian_prompt",
		]);
		expect(plan.variants.map((variant) => variant.id)).toEqual([
			"lean_baseline_off",
			"current_auto",
			"local_heuristic_auto",
			"max",
		]);
		expect(
			plan.variants.map((variant) => ({
				id: variant.id,
				requestReasoningDepth: variant.requestReasoningDepth,
			})),
		).toEqual([
			{ id: "lean_baseline_off", requestReasoningDepth: "off" },
			{ id: "current_auto", requestReasoningDepth: "auto" },
			{ id: "local_heuristic_auto", requestReasoningDepth: "auto" },
			{ id: "max", requestReasoningDepth: "max" },
		]);
		expect(plan.runQueue).toHaveLength(
			REASONING_DEPTH_AB_PROMPTS.length *
				REASONING_DEPTH_AB_VARIANTS.length *
				2,
		);
	});
});

describe("local heuristic Auto classifier", () => {
	it("predicts lean, source-heavy, and code-review prompts with explainable profiles", () => {
		expect(
			classifyPromptForLocalAuto(
				findOrFail(
					REASONING_DEPTH_AB_PROMPTS,
					(p) => p.id === "simple_direct",
					"simple_direct",
				),
			),
		).toMatchObject({
			expectedProfile: "off",
			signals: { groundingNeed: "none", outputRoom: "concise" },
		});

		expect(
			classifyPromptForLocalAuto(
				findOrFail(
					REASONING_DEPTH_AB_PROMPTS,
					(p) => p.id === "source_grounded_current",
					"source_grounded_current",
				),
			),
		).toMatchObject({
			expectedProfile: "maximum",
			signals: { groundingNeed: "required", toolUse: "source_heavy" },
		});

		expect(
			classifyPromptForLocalAuto(
				findOrFail(
					REASONING_DEPTH_AB_PROMPTS,
					(p) => p.id === "debugging_refactor",
					"debugging_refactor",
				),
			),
		).toMatchObject({
			expectedProfile: "extended",
			signals: { contextBreadth: "normal" },
		});
	});
});

describe("reasoning depth deterministic quality scoring", () => {
	it("scores answer text, evidence, format, refusal/error, and depth agreement as data", () => {
		const prompt = findOrFail(
			REASONING_DEPTH_AB_PROMPTS,
			(item) => item.id === "source_grounded_current",
			"source_grounded_current",
		);
		const variant = findOrFail(
			REASONING_DEPTH_AB_VARIANTS,
			(item) => item.id === "current_auto",
			"current_auto",
		);

		const row = scoreReasoningDepthRun({
			run: okRun(),
			prompt,
			variant,
			repetition: 1,
		});

		expect(row).toMatchObject({
			promptId: "source_grounded_current",
			variantId: "current_auto",
			outcome: "ok",
			localExpectedProfile: "maximum",
			actualAppliedProfile: "maximum",
			classifierSource: "control_model",
			classifierAttempts: 1,
			depthSelectionMs: 320,
			controlModelClassifierMs: 260,
			heuristicAgreement: true,
		});
		expect(row.score).toBeGreaterThanOrEqual(80);
		expect(row.passedChecks).toEqual(
			expect.arrayContaining(["answer_length", "evidence_visible"]),
		);
		expect(row.failedChecks).not.toContain("refusal_or_error");
	});

	it("keeps failed live runs in the score table with explicit failed checks", () => {
		const prompt = REASONING_DEPTH_AB_PROMPTS[0];
		const variant = REASONING_DEPTH_AB_VARIANTS[0];

		const row = scoreReasoningDepthRun({
			run: okRun({
				outcome: "error",
				error: "stream HTTP 500",
				answerText: "",
				textLength: 0,
				endMs: 120,
				depthMetadata: undefined,
			}),
			prompt,
			variant,
			repetition: 1,
		});

		expect(row.score).toBe(0);
		expect(row.failedChecks).toEqual(
			expect.arrayContaining(["run_ok", "answer_length", "refusal_or_error"]),
		);
	});
});

describe("reasoning depth aggregate comparison", () => {
	it("summarizes variant latency and score deltas against the lean baseline", () => {
		const rows: ReasoningDepthAbScoreRow[] = [
			scoreReasoningDepthRun({
				run: okRun({
					runIndex: 1,
					firstTokenMs: 1_000,
					endMs: 5_000,
					answerText: "brief deterministic benchmark answer",
					textLength: 36,
					toolCallCount: 0,
					toolCallNames: [],
					depthMetadata: {
						requested: "off",
						appliedProfile: "off",
						timing: {
							totalMs: 25,
							classifierAttempts: 0,
							classifierSource: "deterministic_bypass",
							appliedProfile: "off",
						},
					},
				}),
				prompt: REASONING_DEPTH_AB_PROMPTS[0],
				variant: REASONING_DEPTH_AB_VARIANTS[0],
				repetition: 1,
			}),
			scoreReasoningDepthRun({
				run: okRun({
					runIndex: 2,
					firstTokenMs: 700,
					endMs: 4_000,
					answerText: "brief deterministic benchmark answer",
					textLength: 36,
					toolCallCount: 0,
					toolCallNames: [],
					depthMetadata: {
						requested: "auto",
						appliedProfile: "off",
						timing: {
							totalMs: 45,
							classifierAttempts: 0,
							classifierSource: "deterministic_fast_path",
							appliedProfile: "off",
						},
					},
				}),
				prompt: REASONING_DEPTH_AB_PROMPTS[0],
				variant: REASONING_DEPTH_AB_VARIANTS[1],
				repetition: 1,
			}),
		];

		const summary = summarizeReasoningDepthEvaluation({
			generatedAt: "2026-07-02T10:00:00.000Z",
			baseUrl: "https://ai.example.test",
			modelId: "provider:local:qwen",
			rows,
		});

		expect(summary.variantSummaries.lean_baseline_off).toMatchObject({
			runCount: 1,
			okCount: 1,
			meanScore: expect.any(Number),
			latency: {
				firstTokenMs: { p50: 1_000, p95: 1_000 },
				endMs: { p50: 5_000, p95: 5_000 },
				depthSelectionMs: { p50: 25, p95: 25 },
			},
		});
		expect(summary.comparisonRows).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					variantId: "current_auto",
					deltaVsLeanBaseline: {
						firstTokenP50Ms: -300,
						endP50Ms: -1_000,
					},
				}),
			]),
		);
	});
});
