import { describe, expect, it } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { DepthMetadata } from "$lib/types";
import {
	type ClarificationDecision,
	type DepthEffort,
	evaluateClarification,
	resolveActiveDepthEffort,
	resolvePromptContextLimits,
} from "./shared-normal-chat-model-run-helpers";

const runtimeConfig = {
	model1MaxModelContext: 1_000_000,
	model1CompactionUiThreshold: 800_000,
	model1TargetConstructedContext: 900_000,
	model2MaxModelContext: 250_000,
	model2CompactionUiThreshold: 200_000,
	model2TargetConstructedContext: 225_000,
} as RuntimeConfig;

describe("resolvePromptContextLimits", () => {
	it("derives provider-specific limits from a provider max context", () => {
		expect(
			resolvePromptContextLimits({
				modelId: "provider:provider-1:model-1",
				provider: { maxModelContext: 200_000 },
				runtimeConfig,
			}),
		).toEqual({
			maxModelContext: 200_000,
			compactionUiThreshold: 160_000,
			targetConstructedContext: 180_000,
		});
	});

	it("keeps built-in runtime config limits for built-in models", () => {
		expect(
			resolvePromptContextLimits({
				modelId: "model2",
				provider: {},
				runtimeConfig,
			}),
		).toEqual({
			maxModelContext: 250_000,
			compactionUiThreshold: 200_000,
			targetConstructedContext: 225_000,
		});
	});
});

// --- Shared helper characterization tests ---
//
// `resolveActiveDepthEffort` and `evaluateClarification` are the two helpers
// that can be unit-tested without standing up the external services
// (provider resolution, context prep, tool creation, deliberation) the other
// shared helpers delegate to. Those heavier helpers are covered through the
// plain/streaming entry-point suites.

const baseDepthMetadata: DepthMetadata = {
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

// A minimal-but-shaped DepthEffort fixture. resolveActiveDepthEffort only
// spreads the value and overrides depthMetadata, so the rest can be sparse
// as long as the types line up; cast through unknown to satisfy the type.
const sampleDepthEffort = {
	depthMetadata: baseDepthMetadata,
	contextLimits: {
		maxModelContext: 100_000,
		compactionUiThreshold: 80_000,
		targetConstructedContext: 90_000,
	},
	modelMaxOutputTokens: 4096,
	webSourceBudget: { maxSources: 12, sourceExpansion: true },
	maxToolSteps: 28,
	depthProfile: { outputTokens: {}, grounding: {}, tools: {} },
} as unknown as NonNullable<DepthEffort>;

describe("resolveActiveDepthEffort", () => {
	it("returns null when there is no depth effort to resolve", () => {
		expect(
			resolveActiveDepthEffort(null, {
				action: "proceed",
				depthMetadata: baseDepthMetadata,
			}),
		).toBeNull();
	});

	it("preserves the resolved depth effort and inherits the clarification's depth metadata", () => {
		const clarification: ClarificationDecision = {
			action: "proceed",
			depthMetadata: { ...baseDepthMetadata, appliedProfile: "extended" },
		};
		const result = resolveActiveDepthEffort(sampleDepthEffort, clarification);
		expect(result).not.toBeNull();
		expect(result?.depthMetadata.appliedProfile).toBe("extended");
		expect(result?.modelMaxOutputTokens).toBe(4096);
		expect(result?.webSourceBudget).toEqual({
			maxSources: 12,
			sourceExpansion: true,
		});
	});

	it("keeps the depth effort's own metadata when the clarification carries none (bypass)", () => {
		const clarification: ClarificationDecision = {
			action: "bypass",
		};
		const result = resolveActiveDepthEffort(sampleDepthEffort, clarification);
		expect(result?.depthMetadata).toBe(baseDepthMetadata);
	});
});

describe("evaluateClarification", () => {
	const baseParams = {
		message: "Explain how PDF generation works",
		userId: "user-1",
		runtimeConfig,
		conversationId: "conv-1",
		modelId: "model1" as const,
	};

	it("bypasses when there is no depth effort to clarify (no high-cost profile)", async () => {
		const decision = await evaluateClarification({ ...baseParams }, null);
		expect(decision.action).toBe("bypass");
	});

	it("forwards the depth effort's resolved metadata into the gate when depth is active", async () => {
		// The helper's contract is delegation: it must pass depthEffort's
		// resolved metadata (not the caller's raw params.depthMetadata) to the
		// gate. We verify by asserting the returned decision carries the
		// effort's metadata — the gate echoes the metadata it was given.
		const decision = await evaluateClarification(
			{ ...baseParams },
			sampleDepthEffort,
		);
		expect(decision.depthMetadata?.appliedProfile).toBe("maximum");
	});

	it("honours an injected classifier by surfacing its question when it decides to ask", async () => {
		const askQuestion = "Which options should I compare?";
		const decision = await evaluateClarification(
			{
				...baseParams,
				message: "research all viable options",
				depthClarificationClassifier: async () => ({
					outcome: "ask" as const,
					question: askQuestion,
				}),
			},
			sampleDepthEffort,
		);
		// The high-cost profile engages the gate; a broad-target research
		// request is either deterministically or classifier-drivenly turned
		// into an ask. Either way the decision must be "ask" (not silently
		// proceed/bypass) — that is the shared contract this helper locks.
		expect(decision.action).toBe("ask");
		if (decision.action === "ask") {
			expect(decision.text).toContain(askQuestion);
		}
	});
});
