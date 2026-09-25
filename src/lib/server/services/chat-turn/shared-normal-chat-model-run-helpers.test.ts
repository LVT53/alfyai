import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import type {
	DepthAppliedProfile,
	DepthMetadata,
} from "$lib/server/services/chat-turn/depth-metadata-types";
import { resolvePromptContextLimits } from "$lib/server/services/normal-chat-context";
import type { NormalChatModelRunProvider } from "$lib/server/services/normal-chat-model";

const mocks = vi.hoisted(() => ({
	prepareOutboundChatContext: vi.fn(),
	listSkillCatalogueEntries: vi.fn(),
	seedBuiltInSystemSkillDefinitions: vi.fn(),
	sendJsonControlMessage: vi.fn(),
	resolveTurnInstructions: vi.fn(),
	listRecentUserMessageTexts: vi.fn(async () => [] as string[]),
}));

vi.mock("$lib/server/services/instructions", () => ({
	resolveTurnInstructions: mocks.resolveTurnInstructions,
}));

vi.mock("$lib/server/services/messages", () => ({
	listRecentUserMessageTexts: mocks.listRecentUserMessageTexts,
}));

vi.mock("$lib/server/services/skills/prompt-context", () => ({
	listSkillCatalogueEntries: mocks.listSkillCatalogueEntries,
	// Rendering is covered by skills/prompt-context.test.ts; this stub only
	// has to prove the catalogue reaches context preparation.
	buildSkillCatalogueBlock: (entries: unknown[]) =>
		entries.length > 0 ? `## Skills available\n- ${entries.length}` : null,
}));

vi.mock("$lib/server/services/skills/user-skills", () => ({
	seedBuiltInSystemSkillDefinitions: mocks.seedBuiltInSystemSkillDefinitions,
}));

vi.mock("$lib/server/services/normal-chat-control-model", () => ({
	sendJsonControlMessage: mocks.sendJsonControlMessage,
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
	type DepthEffort,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveProviderRuntime,
	resolveTurnResponseLanguage,
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
// `resolveActiveDepthEffort` is the one helper that can be unit-tested
// without standing up the external services (provider resolution, context
// prep, tool creation) the other shared helpers delegate to. Those heavier
// helpers are covered through the plain/streaming entry-point suites.

const baseDepthMetadata: DepthMetadata = {
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

// A minimal-but-shaped DepthEffort fixture. resolveActiveDepthEffort is a
// typed passthrough, so the rest can be sparse as long as the types line up;
// cast through unknown to satisfy the type.
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
		expect(resolveActiveDepthEffort(null)).toBeNull();
	});

	it("passes the resolved depth effort through unchanged", () => {
		const result = resolveActiveDepthEffort(sampleDepthEffort);
		expect(result).not.toBeNull();
		expect(result?.depthMetadata).toBe(baseDepthMetadata);
		expect(result?.maxToolSteps).toBe(28);
		expect(result?.webSourceBudget).toEqual({
			maxSources: 12,
			sourceExpansion: true,
		});
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
					requested: profile === "off" ? "quick" : "thorough",
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
			const activeDepthEffort = resolveActiveDepthEffort(runtime.depthEffort);
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

	it("seeds the built-in system packs before building the catalogue, once per process", async () => {
		mocks.prepareOutboundChatContext.mockResolvedValue({
			inputValue: "prepared",
			systemPrompt: "system",
			contextStatus: undefined,
			taskState: null,
			contextDebug: null,
			contextTraceSections: [],
		});
		mocks.listSkillCatalogueEntries.mockReset();
		mocks.listSkillCatalogueEntries.mockResolvedValue([{ id: "system:a" }]);
		mocks.seedBuiltInSystemSkillDefinitions.mockReset();
		mocks.seedBuiltInSystemSkillDefinitions.mockResolvedValue(undefined);

		const params = {
			userId: "user-1",
			runtimeConfig,
			message: "Critique this plan.",
			conversationId: "conv-1",
			modelId: "provider:provider-1:gpt-4.1" as const,
			overrideProvider,
		};
		const runtime = await resolveProviderRuntime(params);

		await prepareOutboundContext(params, runtime, null, new Set());
		await prepareOutboundContext(params, runtime, null, new Set());

		// The chat turn is the primary consumer of built-in packs now: it must
		// not depend on someone having opened the composer skill picker or the
		// Skills settings tab to seed (and refresh) them first.
		expect(mocks.seedBuiltInSystemSkillDefinitions).toHaveBeenCalledWith(
			"user-1",
		);
		expect(mocks.seedBuiltInSystemSkillDefinitions).toHaveBeenCalledTimes(1);
		expect(
			mocks.prepareOutboundChatContext.mock.lastCall?.[0].skillCatalogueBlock,
		).toContain("## Skills available");
	});
});

describe("prepareOutboundContext automatic context compression wiring", () => {
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

	// Automatic compression returns `missing_control_message_sender` without
	// ever measuring the prompt when no sender is injected. The chat turn is
	// its only production caller, so the turn must hand context preparation
	// the same JSON control sender the manual compression route uses.
	it("hands context preparation the JSON control sender and the turn's abort signal", async () => {
		const params = {
			userId: "user-1",
			runtimeConfig,
			message: "Continue where we left off.",
			conversationId: "conv-1",
			modelId: "model1" as const,
			user: { id: "user-1" },
			signal: new AbortController().signal,
		};
		const runtime = await resolveProviderRuntime({
			...params,
			overrideProvider: {
				id: "provider-1",
				name: "local",
				displayName: "Local",
				baseUrl: "http://local-model/v1",
				modelName: "local-model",
				apiKey: "local-key",
			} as NormalChatModelRunProvider,
		});
		mocks.sendJsonControlMessage.mockResolvedValue({ text: "{}" });

		await prepareOutboundContext(params, runtime, null, new Set());

		const call = mocks.prepareOutboundChatContext.mock.lastCall?.[0];
		expect(call.signal).toBe(params.signal);
		const options = { systemPrompt: "compress" };
		await expect(
			call.compressionControlMessageSender("payload", "model1", options),
		).resolves.toEqual({ text: "{}" });
		expect(mocks.sendJsonControlMessage).toHaveBeenCalledWith(
			"payload",
			"model1",
			options,
		);
	});
});

describe("prepareOutboundContext standing instructions wiring", () => {
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
		mocks.resolveTurnInstructions.mockReset();
		mocks.resolveTurnInstructions.mockResolvedValue({
			personal: null,
			project: null,
		});
	});

	// Prompt assembly renders instructions and never reads for them, so the one
	// resolution per turn has to happen here and travel as data. If this wiring
	// is dropped the feature goes quiet without a single test failing in the
	// context suite, which only ever passes instructions in by hand.
	it("resolves the turn's standing instructions once and hands them to context preparation", async () => {
		mocks.resolveTurnInstructions.mockResolvedValue({
			personal: "Use metric units.",
			project: null,
		});
		const params = {
			userId: "user-1",
			runtimeConfig,
			message: "Continue where we left off.",
			conversationId: "conv-1",
			modelId: "model1" as const,
			user: { id: "user-1" },
		};
		const runtime = await resolveProviderRuntime({
			...params,
			overrideProvider: {
				id: "provider-1",
				name: "local",
				displayName: "Local",
				baseUrl: "http://local-model/v1",
				modelName: "local-model",
				apiKey: "local-key",
			} as NormalChatModelRunProvider,
		});

		await prepareOutboundContext(params, runtime, null, new Set());

		expect(mocks.resolveTurnInstructions).toHaveBeenCalledTimes(1);
		expect(mocks.resolveTurnInstructions).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(
			mocks.prepareOutboundChatContext.mock.lastCall?.[0].instructions,
		).toEqual({ personal: "Use metric units.", project: null });
	});
});

describe("resolveTurnResponseLanguage", () => {
	beforeEach(() => {
		mocks.listRecentUserMessageTexts.mockReset();
		mocks.listRecentUserMessageTexts.mockResolvedValue([]);
	});

	it("resolves from the latest message when it is clear, without needing history", async () => {
		const result = await resolveTurnResponseLanguage({
			message: "How do I configure the environment variables?",
			conversationId: "conv-1",
			user: { id: "user-1" },
		});

		expect(result).toBe("en");
	});

	it("reads recent prior user messages and falls back to one with a clear language when the latest message is ambiguous", async () => {
		mocks.listRecentUserMessageTexts.mockResolvedValue([
			"Szia, hogy vagy?",
			"Kérlek segíts nekem ezzel",
		]);

		const result = await resolveTurnResponseLanguage({
			message: "ok",
			conversationId: "conv-1",
			user: { id: "user-1" },
		});

		expect(mocks.listRecentUserMessageTexts).toHaveBeenCalledWith("conv-1", 5);
		expect(result).toBe("hu");
	});

	it("falls back to the account's UI language when the latest message and history are both ambiguous", async () => {
		mocks.listRecentUserMessageTexts.mockResolvedValue([]);

		const result = await resolveTurnResponseLanguage({
			message: "ok",
			conversationId: "conv-1",
			user: { id: "user-1", uiLanguage: "hu" },
		});

		expect(result).toBe("hu");
	});

	it("fails open to a message-only resolution when the history lookup throws", async () => {
		mocks.listRecentUserMessageTexts.mockRejectedValue(
			new Error("db unavailable"),
		);

		const result = await resolveTurnResponseLanguage({
			message: "Can you help me with this bug?",
			conversationId: "conv-1",
			user: { id: "user-1", uiLanguage: "hu" },
		});

		expect(result).toBe("en");
	});
});
