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
					requested: profile === "maximum" ? "max" : "auto",
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

	it("scales the profile ladder while keeping source expansion conditional on evidence signals", () => {
		const off = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "off",
				appliedProfile: "off",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});
		const standard = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "auto",
				appliedProfile: "standard",
				fallback: false,
			},
			provider,
			forceWebSearch: false,
		});
		const extendedWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "auto",
				appliedProfile: "extended",
				fallback: false,
			},
			provider,
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
			forceWebSearch: false,
		});
		const maximumWithoutEvidence = resolveReasoningDepthEffort({
			depthMetadata: {
				requested: "max",
				appliedProfile: "maximum",
				fallback: false,
			},
			provider,
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
		expect(off.maxToolSteps).toBeLessThan(standard.maxToolSteps);
		expect(standard.maxToolSteps).toBeLessThan(
			extendedWithoutEvidence.maxToolSteps,
		);
		expect(extendedWithoutEvidence.maxToolSteps).toBeLessThan(
			maximumWithoutEvidence.maxToolSteps,
		);
		expect(off.grounding.guidance).toBe("minimal");
		expect(standard.grounding.guidance).toBe("standard");
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
				requested: "max",
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
