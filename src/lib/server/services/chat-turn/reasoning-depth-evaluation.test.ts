import { describe, expect, it } from "vitest";
import type { DepthMetadata } from "$lib/types";
import {
	evaluateReasoningDepthFixtures,
	type ReasoningDepthEvaluationFixture,
} from "./reasoning-depth-evaluation";

const highCostDepthMetadata: DepthMetadata = {
	requested: "auto",
	appliedProfile: "maximum",
	fallback: false,
	signals: {
		contextBreadth: "broad",
		outputRoom: "expanded",
		toolUse: "source_heavy",
	},
};

describe("Reasoning Depth evaluation harness", () => {
	it("accepts ask, proceed, proceed-with-assumption, Hungarian, carry-forward, and metadata fixtures", async () => {
		const fixtures: ReasoningDepthEvaluationFixture[] = [
			{
				id: "ambiguous-high-cost",
				title: "Ambiguous high-cost comparison asks before spending Max",
				kind: "depth_clarification",
				message:
					"Research all viable platforms and compare every option for the migration plan.",
				language: "en",
				depthMetadata: highCostDepthMetadata,
				expectedAction: "ask",
			},
			{
				id: "clear-high-cost",
				title: "Clear high-cost request proceeds",
				kind: "depth_clarification",
				message:
					"Evaluate Stripe Billing versus Chargebee for our B2B SaaS migration plan.",
				language: "en",
				depthMetadata: highCostDepthMetadata,
				expectedAction: "proceed",
			},
			{
				id: "dominant-assumption",
				title: "Dominant assumption proceeds with assumption metadata",
				kind: "depth_clarification",
				message:
					"Compare the options for the migration plan; use your best judgment and proceed.",
				language: "en",
				depthMetadata: highCostDepthMetadata,
				expectedAction: "proceed_with_assumption",
			},
			{
				id: "hungarian-parity",
				title: "Hungarian ambiguity asks in Hungarian",
				kind: "depth_clarification",
				message:
					"Kutasd fel az összes életképes platformot, és hasonlíts össze minden opciót a migrációs tervhez.",
				language: "hu",
				depthMetadata: highCostDepthMetadata,
				expectedAction: "ask",
			},
			{
				id: "carry-forward",
				title: "Clarified follow-up carries forward high-cost metadata",
				kind: "carry_forward",
				requestedDepth: "auto",
				previousDepthMetadata: {
					...highCostDepthMetadata,
					clarification: {
						outcome: "ask",
						reason: "multiple_plausible_targets",
						language: "en",
					},
				},
				expectedAppliedProfile: "maximum",
			},
			{
				id: "metadata-classification",
				title: "Clarification metadata is not completed high-cost deliberation",
				kind: "metadata_classification",
				depthMetadata: {
					...highCostDepthMetadata,
					outcome: "clarification_requested",
					clarification: {
						outcome: "ask",
						reason: "multiple_plausible_targets",
						language: "en",
					},
				},
				expectedOutcome: "clarification_requested",
			},
		];

		const report = await evaluateReasoningDepthFixtures({ fixtures });

		expect(report.accepted).toBe(true);
		expect(report.summary.unnecessaryQuestionRate).toBe(0);
		expect(report.summary.wrongTargetAvoidanceRate).toBe(1);
		expect(report.fixtureResults).toHaveLength(fixtures.length);
		expect(report.fixtureResults.every((result) => result.accepted)).toBe(true);
		expect(
			report.fixtureResults.find(
				(result) => result.fixtureId === "hungarian-parity",
			)?.dimensions.localizedWording,
		).toMatchObject({
			passed: true,
		});
		expect(
			report.fixtureResults.find(
				(result) => result.fixtureId === "metadata-classification",
			)?.dimensions.metadataClassification,
		).toMatchObject({
			passed: true,
		});
	});

	it("scores dynamic deliberation quality against cost and reports KIMI live evaluation availability", async () => {
		const fixtures: ReasoningDepthEvaluationFixture[] = [
			{
				id: "dynamic-source-heavy-broad-earns-cost",
				title: "Dynamic broad source-heavy maximum plan earns its cost",
				kind: "dynamic_deliberation",
				standardPlan: {
					label: "standard",
					quality: {
						grounding: 0.45,
						contextAwareness: 0.45,
						contradictionHandling: 0.35,
						formatDiscipline: 0.7,
						hungarianParity: 0.65,
					},
					cost: {
						latencyClass: "low",
						passCount: 0,
						toolCallBudget: 14,
					},
				},
				currentBaselinePlan: {
					label: "current maximum",
					quality: {
						grounding: 0.62,
						contextAwareness: 0.58,
						contradictionHandling: 0.48,
						formatDiscipline: 0.75,
						hungarianParity: 0.7,
					},
					cost: {
						latencyClass: "medium",
						passCount: 3,
						toolCallBudget: 24,
					},
				},
				dynamicPlan: {
					label: "dynamic maximum",
					quality: {
						grounding: 0.82,
						contextAwareness: 0.82,
						contradictionHandling: 0.76,
						formatDiscipline: 0.82,
						hungarianParity: 0.78,
					},
					cost: {
						latencyClass: "high",
						passCount: 5,
						toolCallBudget: 32,
					},
					addedUsefulDimensions: [
						"source_reconciliation",
						"workspace_synthesis",
						"adversarial_edge_case_check",
						"viable_alternatives_preservation",
					],
				},
				minimumQualityGain: 0.14,
				maximumCostMultiplier: 1.8,
			},
			{
				id: "dynamic-broad-fails-cost",
				title: "Dynamic plan fails when quality barely improves for high cost",
				kind: "dynamic_deliberation",
				standardPlan: {
					label: "standard",
					quality: {
						grounding: 0.58,
						contextAwareness: 0.6,
						contradictionHandling: 0.55,
						formatDiscipline: 0.72,
						hungarianParity: 0.7,
					},
					cost: {
						latencyClass: "low",
						passCount: 0,
						toolCallBudget: 14,
					},
				},
				currentBaselinePlan: {
					label: "current maximum",
					quality: {
						grounding: 0.72,
						contextAwareness: 0.72,
						contradictionHandling: 0.68,
						formatDiscipline: 0.78,
						hungarianParity: 0.74,
					},
					cost: {
						latencyClass: "medium",
						passCount: 3,
						toolCallBudget: 24,
					},
				},
				dynamicPlan: {
					label: "dynamic maximum",
					quality: {
						grounding: 0.73,
						contextAwareness: 0.73,
						contradictionHandling: 0.69,
						formatDiscipline: 0.78,
						hungarianParity: 0.74,
					},
					cost: {
						latencyClass: "very_high",
						passCount: 5,
						toolCallBudget: 40,
					},
					addedUsefulDimensions: [],
				},
				minimumQualityGain: 0.08,
				maximumCostMultiplier: 1.4,
			},
		];

		const report = await evaluateReasoningDepthFixtures({
			fixtures,
			liveEvaluation: {
				apiAvailable: true,
				uiAvailable: false,
				attemptedModelIds: ["provider:moonshot:kimi-k2-local"],
				configuredModels: [
					{
						id: "provider:moonshot:kimi-k2-local",
						name: "kimi-k2",
						displayName: "KIMI K2 Local",
					},
				],
			},
		});

		expect(report.accepted).toBe(false);
		expect(report.summary.localLiveEvaluationAvailable).toBe(true);
		expect(report.summary.localLiveEvaluationAttempted).toBe(true);
		expect(report.summary.kimiEvaluationAvailable).toBe(true);
		expect(report.summary.kimiEvaluationAttempted).toBe(true);
		expect(
			report.fixtureResults.find(
				(result) =>
					result.fixtureId === "dynamic-source-heavy-broad-earns-cost",
			)?.accepted,
		).toBe(true);
		expect(
			report.fixtureResults.find(
				(result) => result.fixtureId === "dynamic-broad-fails-cost",
			)?.dimensions.qualityVsCost,
		).toMatchObject({
			passed: false,
		});
		expect(
			report.fixtureResults.find(
				(result) =>
					result.fixtureId === "dynamic-source-heavy-broad-earns-cost",
			)?.dimensions.kimiLocalLiveAvailability,
		).toMatchObject({
			passed: true,
		});
	});
});
