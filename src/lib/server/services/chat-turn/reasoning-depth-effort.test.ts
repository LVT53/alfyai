import { describe, expect, it } from "vitest";
import type { DepthMetadata } from "$lib/types";
import { resolveReasoningDepthEffort } from "./reasoning-depth-effort";

const baseContextLimits = {
	maxModelContext: 100_000,
	targetConstructedContext: 80_000,
	compactionUiThreshold: 70_000,
};

const provider = {
	id: "provider-1",
	name: "fireworks",
	displayName: "Fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	modelName: "gpt-4.1",
	apiKey: "provider-secret",
	reasoningEffort: "high" as const,
};

describe("resolveReasoningDepthEffort", () => {
	it("applies maximum depth to provider reasoning, output/context room, source budgets, and metadata", () => {
		const depthMetadata: DepthMetadata = {
			requested: "auto",
			appliedProfile: "maximum",
			fallback: false,
			signals: {
				groundingNeed: "required",
				contextBreadth: "broad",
				outputRoom: "expanded",
				toolUse: "source_heavy",
			},
		};

		const effort = resolveReasoningDepthEffort({
			depthMetadata,
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});

		expect(effort.providerReasoning).toEqual({
			thinkingMode: "on",
			reasoningEffort: "high",
			constrained: false,
			supported: true,
		});
		expect(effort.modelMaxOutputTokens).toBe(10_000);
		expect(effort.contextLimits).toEqual(baseContextLimits);
		expect(effort.maxToolSteps).toBeGreaterThan(20);
		expect(effort.webSourceBudget).toEqual({
			maxSources: 12,
			sourceExpansion: true,
		});
		expect(effort.depthMetadata.appliedEffort).toMatchObject({
			dimensions: expect.arrayContaining([
				"provider_reasoning",
				"output_room",
				"context_room",
				"grounding_guidance",
				"tool_steps",
				"source_budget",
			]),
			providerReasoning: {
				thinkingMode: "on",
				reasoningEffort: "high",
				supported: true,
				constrained: false,
			},
			outputTokens: {
				configuredMaxTokens: 10_000,
				targetMaxTokens: 10_000,
				clamped: false,
			},
			context: {
				maxModelContext: 100_000,
				configuredTargetConstructedContext: 80_000,
				targetConstructedContext: 80_000,
				clamped: false,
			},
			tools: {
				maxToolSteps: effort.maxToolSteps,
				maxWebSources: 12,
				sourceExpansion: true,
			},
			grounding: {
				guidance: "strict",
				externalEvidence: "required",
				forceWebSearch: false,
			},
		});
	});

	it("scales the profile ladder while keeping source expansion conditional on evidence signals", () => {
		const off = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "off",
				appliedProfile: "off",
				fallback: false,
			},
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});
		const standard = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "auto",
				appliedProfile: "standard",
				fallback: false,
			},
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});
		const extendedWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
			},
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});
		const extendedWithEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
				signals: {
					groundingNeed: "useful",
					toolUse: "source_heavy",
				},
			},
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});
		const maximumWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
			},
			provider,
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});

		expect(off.providerReasoning.thinkingMode).toBe("off");
		expect(standard.providerReasoning).toMatchObject({
			thinkingMode: "auto",
			reasoningEffort: "low",
		});
		expect(extendedWithoutEvidence.providerReasoning).toMatchObject({
			thinkingMode: "on",
			reasoningEffort: "medium",
		});
		expect(maximumWithoutEvidence.providerReasoning).toMatchObject({
			thinkingMode: "on",
			reasoningEffort: "high",
		});
		expect(off.modelMaxOutputTokens).toBeLessThan(
			standard.modelMaxOutputTokens ?? 0,
		);
		expect(standard.modelMaxOutputTokens).toBeLessThan(
			extendedWithoutEvidence.modelMaxOutputTokens ?? 0,
		);
		expect(extendedWithoutEvidence.modelMaxOutputTokens).toBeLessThan(
			maximumWithoutEvidence.modelMaxOutputTokens ?? 0,
		);
		expect(off.contextLimits.targetConstructedContext).toBeLessThan(
			standard.contextLimits.targetConstructedContext,
		);
		expect(standard.contextLimits.targetConstructedContext).toBeLessThan(
			extendedWithoutEvidence.contextLimits.targetConstructedContext,
		);
		expect(
			extendedWithoutEvidence.contextLimits.targetConstructedContext,
		).toBeLessThan(
			maximumWithoutEvidence.contextLimits.targetConstructedContext,
		);
		expect(extendedWithoutEvidence.webSourceBudget).toEqual({
			maxSources: 6,
			sourceExpansion: false,
		});
		expect(extendedWithEvidence.webSourceBudget).toEqual({
			maxSources: 8,
			sourceExpansion: true,
		});
		expect(extendedWithEvidence.maxToolSteps).toBeGreaterThan(
			extendedWithoutEvidence.maxToolSteps,
		);
		expect(maximumWithoutEvidence.webSourceBudget.sourceExpansion).toBe(false);
	});

	it("records provider reasoning constraints when a profile is capped by configured model limits", () => {
		const effort = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
			},
			provider: {
				...provider,
				reasoningEffort: "low",
			},
			baseContextLimits,
			configuredMaxOutputTokens: 10_000,
			forceWebSearch: false,
		});

		expect(effort.providerReasoning).toEqual({
			thinkingMode: "on",
			reasoningEffort: "low",
			supported: true,
			constrained: true,
		});
		expect(effort.constraints).toEqual([
			"provider_reasoning_clamped_to_configured_low",
		]);
		expect(effort.depthMetadata.appliedEffort?.constraints).toEqual([
			"provider_reasoning_clamped_to_configured_low",
		]);
	});
});
