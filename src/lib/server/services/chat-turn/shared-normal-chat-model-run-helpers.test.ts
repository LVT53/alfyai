import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import type {
	DepthAppliedProfile,
	DepthMetadata,
} from "$lib/server/services/chat-turn/depth-metadata-types";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";

const mocks = vi.hoisted(() => ({
	prepareOutboundChatContext: vi.fn(),
}));

vi.mock("$lib/server/services/normal-chat-context", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("$lib/server/services/normal-chat-context")
		>();
	return {
		...actual,
		prepareOutboundChatContext: mocks.prepareOutboundChatContext,
	};
});

import {
	type ClarificationDecision,
	type DepthEffort,
	evaluateClarification,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolvePromptContextLimits,
	resolveProviderRuntime,
} from "./shared-normal-chat-model-run-helpers";

const runtimeConfig = {
	systemPrompt: "",
	model1: {
		baseUrl: "https://openai-compatible.example/v1",
		apiKey: "model-1-secret",
		modelName: "gpt-4.1",
		displayName: "Model One",
		systemPrompt: "You are a helpful assistant.",
		maxTokens: 2048,
		reasoningEffort: "high",
		thinkingType: null,
	},
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
	webSourceBudget: { maxSources: 12, sourceExpansion: true },
	maxToolSteps: 28,
	grounding: {
		guidance: "strict",
		externalEvidence: "required",
		forceWebSearch: false,
	},
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
		expect(result?.maxToolSteps).toBe(28);
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

// --- Depth profiles must not touch per-model budgets ---
//
// A reasoning-depth profile controls provider reasoning and the tool/source
// budget only. The constructed-context target and the model's max output
// tokens handed to context preparation are fixed per model and must be
// byte-identical across all four profiles (and independent of the breadth /
// output-room signals the classifier attaches).

describe("depth profiles keep per-model context and output budgets fixed", () => {
	const overrideProvider: NormalChatModelRunProvider = {
		id: "provider-1",
		name: "fireworks",
		displayName: "Fireworks",
		baseUrl: "https://api.fireworks.ai/inference/v1",
		modelName: "gpt-4.1",
		apiKey: "provider-secret",
		maxOutputTokens: 4096,
		maxModelContext: 200_000,
		reasoningEffort: "high",
	};
	const profiles: DepthAppliedProfile[] = [
		"off",
		"standard",
		"extended",
		"maximum",
	];

	beforeEach(() => {
		mocks.prepareOutboundChatContext.mockReset();
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "prepared",
			systemPrompt: "system",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
		});
	});

	it("passes identical context limits and max output tokens to context prep for every profile", async () => {
		const seen: Array<{
			profile: DepthAppliedProfile;
			maxTokens: number | null | undefined;
			contextLimits: unknown;
			maxToolSteps: number;
		}> = [];

		for (const profile of profiles) {
			const params = {
				userId: "user-1",
				runtimeConfig,
				message: "Compare every option and write a full report.",
				conversationId: "conv-1",
				modelId: "provider:provider-1:gpt-4.1" as const,
				overrideProvider,
				depthMetadata: {
					requested: profile === "maximum" ? "max" : "auto",
					appliedProfile: profile,
					fallback: false,
					signals: {
						groundingNeed: "required",
						contextBreadth: profile === "off" ? "narrow" : "broad",
						outputRoom: profile === "off" ? "concise" : "expanded",
						toolUse: "source_heavy",
					},
				} satisfies DepthMetadata,
			};
			const runtime = await resolveProviderRuntime(params);
			const activeDepthEffort = resolveActiveDepthEffort(runtime.depthEffort, {
				action: "proceed",
				depthMetadata: params.depthMetadata,
			});
			expect(activeDepthEffort).not.toBeNull();
			if (!activeDepthEffort) throw new Error("expected active depth effort");

			await prepareOutboundContext(
				params,
				runtime,
				activeDepthEffort,
				new Set(),
			);
			const call = mocks.prepareOutboundChatContext.mock.lastCall?.[0];
			seen.push({
				profile,
				maxTokens: call.modelConfig.maxTokens,
				contextLimits: call.contextLimits,
				maxToolSteps: call.reasoningDepthEffort.maxToolSteps,
			});
		}

		const expectedContextLimits = resolvePromptContextLimits({
			modelId: "provider:provider-1:gpt-4.1",
			provider: overrideProvider,
			runtimeConfig,
		});
		for (const entry of seen) {
			expect(entry.maxTokens).toBe(4096);
			expect(entry.contextLimits).toEqual(expectedContextLimits);
		}
		expect(new Set(seen.map((entry) => entry.maxTokens)).size).toBe(1);
		expect(
			new Set(seen.map((entry) => JSON.stringify(entry.contextLimits))).size,
		).toBe(1);
		// Depth still reaches context prep through the tool budget.
		expect(seen.map((entry) => entry.maxToolSteps)).toEqual(
			[...seen.map((entry) => entry.maxToolSteps)].sort((a, b) => a - b),
		);
		expect(seen[0]?.maxToolSteps).toBeLessThan(seen.at(-1)?.maxToolSteps ?? 0);
	});
});
