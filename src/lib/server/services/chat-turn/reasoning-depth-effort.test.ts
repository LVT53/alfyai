import { describe, expect, it } from "vitest";
import type {
	DepthAppliedProfile,
	DepthMetadata,
} from "$lib/server/services/chat-turn/depth-metadata-types";
import { resolveReasoningDepthEffort } from "./reasoning-depth-effort";

const provider = {
	id: "provider-1",
	name: "fireworks",
	displayName: "Fireworks",
	baseUrl: "https://api.fireworks.ai/inference/v1",
	modelName: "gpt-4.1",
	apiKey: "provider-secret",
	reasoningEffort: "high" as const,
};

const PROFILES: DepthAppliedProfile[] = [
	"off",
	"standard",
	"extended",
	"maximum",
];

describe("resolveReasoningDepthEffort", () => {
	it("applies maximum depth to provider reasoning, source budgets, grounding, and metadata", () => {
		const depthMetadata: DepthMetadata = {
			requested: "thorough",
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
			forceWebSearch: false,
		});

		expect(effort.providerReasoning).toEqual({
			thinkingMode: "on",
			reasoningEffort: "high",
			constrained: false,
			supported: true,
		});
		expect(effort.maxToolSteps).toBeGreaterThan(20);
		expect(effort.webSourceBudget).toEqual({
			maxSources: 12,
			sourceExpansion: true,
		});
		expect(effort.depthMetadata.appliedEffort).toEqual({
			dimensions: [
				"provider_reasoning",
				"grounding_guidance",
				"tool_steps",
				"source_budget",
			],
			providerReasoning: {
				thinkingMode: "on",
				reasoningEffort: "high",
				supported: true,
				constrained: false,
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

	it("does not carry output-token or context-room dimensions in any profile", () => {
		for (const profile of PROFILES) {
			const effort = resolveReasoningDepthEffort({
				depthMetadata: {
					requested: profile === "off" ? "quick" : "thorough",
					appliedProfile: profile,
					fallback: false,
					signals: {
						contextBreadth: "narrow",
						outputRoom: "concise",
					},
				},
				provider,
				forceWebSearch: false,
			});
			const appliedEffort = effort.depthMetadata.appliedEffort;
			expect(appliedEffort?.dimensions).not.toContain("output_room");
			expect(appliedEffort?.dimensions).not.toContain("context_room");
			expect(appliedEffort).not.toHaveProperty("outputTokens");
			expect(appliedEffort).not.toHaveProperty("context");
			expect(effort).not.toHaveProperty("contextLimits");
			expect(effort).not.toHaveProperty("modelMaxOutputTokens");
		}
	});

	it("keeps quick's tool/web budgets equal to thorough's while only turning reasoning off", () => {
		const quick = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "quick",
				appliedProfile: "off",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});
		const thorough = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "standard",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});

		expect(quick.providerReasoning.thinkingMode).toBe("off");
		expect(thorough.providerReasoning).toMatchObject({
			thinkingMode: "auto",
			reasoningEffort: "low",
		});
		// The only difference the toggle makes is provider reasoning — tool
		// steps and the web-source budget stay identical.
		expect(quick.maxToolSteps).toBe(14);
		expect(thorough.maxToolSteps).toBe(14);
		expect(quick.maxToolSteps).toBe(thorough.maxToolSteps);
		expect(quick.webSourceBudget).toEqual({
			maxSources: 6,
			sourceExpansion: false,
		});
		expect(thorough.webSourceBudget).toEqual(quick.webSourceBudget);
		expect(quick.grounding.guidance).toBe("minimal");
		expect(thorough.grounding.guidance).toBe("standard");
	});

	it("scales the unreachable-but-still-defined extended/maximum profiles", () => {
		const standard = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "standard",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});
		const extendedWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "extended",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});
		const extendedWithEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "extended",
				fallback: false,
				signals: {
					groundingNeed: "useful",
					toolUse: "source_heavy",
				},
			},
			provider,
			forceWebSearch: false,
		});
		const maximumWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "thorough",
				appliedProfile: "maximum",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});

		expect(extendedWithoutEvidence.providerReasoning).toMatchObject({
			thinkingMode: "on",
			reasoningEffort: "medium",
		});
		expect(maximumWithoutEvidence.providerReasoning).toMatchObject({
			thinkingMode: "on",
			reasoningEffort: "high",
		});
		expect(standard.maxToolSteps).toBeLessThan(
			extendedWithoutEvidence.maxToolSteps,
		);
		expect(extendedWithoutEvidence.maxToolSteps).toBeLessThan(
			maximumWithoutEvidence.maxToolSteps,
		);
		expect(maximumWithoutEvidence.grounding.guidance).toBe("careful");
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
				requested: "thorough",
				appliedProfile: "maximum",
				fallback: false,
			},
			provider: {
				...provider,
				reasoningEffort: "low",
			},
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
