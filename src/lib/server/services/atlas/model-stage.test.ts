import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/services/analytics", () => ({
	findPriceRule: vi.fn(async () => ({
		id: "price-rule-1",
		providerId: "provider",
		name: "synthesis",
		inputUsdMicrosPer1m: 2_000_000,
		cachedInputUsdMicrosPer1m: 0,
		cacheHitUsdMicrosPer1m: 0,
		cacheMissUsdMicrosPer1m: 0,
		outputUsdMicrosPer1m: 8_000_000,
	})),
	calculateCostUsdMicros: vi.fn((_rule, usage) =>
		Math.round(
			(usage.promptTokens * 2_000_000 + usage.completionTokens * 8_000_000) /
				1_000_000,
		),
	),
	listPriceWindowsForModel: vi.fn(async () => []),
	resolveEffectivePriceRule: vi.fn((rule) => rule),
}));

describe("Atlas model stage", () => {
	it("calls the normal chat model boundary contract and maps usage", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const runModel = vi.fn(async () => ({
			text: "Structured stage output",
			usage: {
				inputTokens: 12,
				outputTokens: 8,
				totalTokens: 20,
			},
			model: {
				modelId: "provider:model:synthesis",
				providerId: "provider",
				providerName: "Provider",
				displayName: "Synthesis",
				requestedModelName: "synthesis",
				responseModelName: "synthesis",
			},
			finishReason: "stop" as const,
		}));

		const result = await runAtlasModelStage({
			stage: "synthesize",
			profile: "exhaustive",
			modelSelection: "provider:provider-id:model-id",
			system: "Atlas system prompt",
			prompt: "Use curated evidence only.",
			maxOutputTokens: 32000,
			runModel,
		});

		expect(runModel).toHaveBeenCalledWith(
			expect.objectContaining({
				modelSelection: "provider:provider-id:model-id",
				messages: [{ role: "user", content: "Use curated evidence only." }],
				system: expect.stringContaining("Atlas system prompt"),
				maxOutputTokens: 32000,
			}),
		);
		expect(result).toEqual({
			text: "Structured stage output",
			finishReason: "stop",
			usage: {
				inputTokens: 12,
				outputTokens: 8,
				totalTokens: 20,
				costUsdMicros: 88,
			},
			model: {
				modelId: "provider:model:synthesis",
				providerId: "provider",
				displayName: "Synthesis",
			},
		});
	});

	it("includes the stage and profile in the system-prompt suffix", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const runModel = vi.fn(async () => ({
			text: "{}",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			model: { modelId: "m", providerId: "p", displayName: "M" },
		}));

		await runAtlasModelStage({
			stage: "ask",
			profile: "overview",
			modelSelection: "model1",
			system: "Base system prompt.",
			prompt: "Use curated evidence only.",
			maxOutputTokens: 4000,
			runModel,
		});

		expect(runModel).toHaveBeenCalledWith(
			expect.objectContaining({
				system: "Base system prompt.\n\nAtlas stage: ask. Profile: overview.",
			}),
		);
	});

	it("prices third-party provider model usage through the app pricing path", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const { calculateCostUsdMicros, findPriceRule } = await import(
			"$lib/server/services/analytics"
		);
		const runModel = vi.fn(async () => ({
			text: "Provider-priced stage output",
			usage: {
				inputTokens: 1_500,
				outputTokens: 600,
				totalTokens: 2_100,
			},
			model: {
				modelId: "provider:provider:synthesis",
				providerId: "provider",
				displayName: "Synthesis",
				requestedModelName: "synthesis",
				responseModelName: "synthesis",
			},
		}));

		const result = await runAtlasModelStage({
			stage: "synthesize",
			profile: "in-depth",
			modelSelection: "provider:provider:synthesis",
			system: "Atlas system prompt",
			prompt: "Use curated evidence only.",
			maxOutputTokens: 24000,
			runModel,
		});

		expect(findPriceRule).toHaveBeenCalledWith({
			modelId: "provider:provider:synthesis",
			providerId: "provider",
			providerModelName: "synthesis",
		});
		expect(calculateCostUsdMicros).toHaveBeenCalledWith(
			expect.any(Object),
			expect.objectContaining({
				promptTokens: 1_500,
				completionTokens: 600,
			}),
		);
		expect(result.usage.costUsdMicros).toBe(7_800);
	});

	it("returns finishReason from the model run result", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const runModel = vi.fn(async () => ({
			text: "Output with length finish",
			finishReason: "length" as const,
			usage: {
				inputTokens: 10,
				outputTokens: 100,
				totalTokens: 110,
			},
			model: {
				modelId: "model1",
				providerId: "provider",
				displayName: "Model 1",
			},
		}));

		const result = await runAtlasModelStage({
			stage: "synthesize",
			profile: "overview",
			modelSelection: "model1",
			system: "Atlas system prompt",
			prompt: "Test prompt",
			maxOutputTokens: 16000,
			runModel,
		});

		expect(result.finishReason).toBe("length");
	});

	it("says nothing about reasoning by default", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		let captured: Record<string, unknown> = {};
		const runModel = vi.fn(async (input: unknown) => {
			captured = input as Record<string, unknown>;
			return {
				text: "{}",
				usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
				model: { modelId: "m", providerId: "p", displayName: "M" },
			};
		});

		await runAtlasModelStage({
			stage: "synthesize",
			profile: "exhaustive",
			modelSelection: "provider:p:m",
			system: "Atlas system prompt",
			prompt: "Use curated evidence only.",
			maxOutputTokens: 32000,
			runModel,
		});

		expect(captured.maxOutputTokens).toBe(32000);
		expect(captured).not.toHaveProperty("thinkingMode");
	});

	it("forwards a per-call output cap and thinking mode to the boundary", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const runModel = vi.fn(async () => ({
			text: "{}",
			usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
			model: { modelId: "m", providerId: "p", displayName: "M" },
		}));

		await runAtlasModelStage({
			stage: "synthesize",
			profile: "exhaustive",
			modelSelection: "provider:p:m",
			system: "Atlas system prompt",
			prompt: "Use curated evidence only.",
			maxOutputTokens: 1_500,
			thinkingMode: "off",
			runModel,
		});

		expect(runModel).toHaveBeenCalledWith(
			expect.objectContaining({ maxOutputTokens: 1_500, thinkingMode: "off" }),
		);
	});
});

describe("Atlas model stage provider reasoning", () => {
	/**
	 * The point of the option: `thinkingMode: "off"` has to reach the REQUEST,
	 * not just the boundary's argument list. It does so through the same helper
	 * the chat path's "quick" depth uses, per attempt so a failover keeps it —
	 * which for a Qwen-shaped provider is `enable_thinking: false`, mirrored
	 * into `chat_template_kwargs` where a self-hosted vLLM reads it.
	 */
	async function runThroughBoundary(
		thinkingMode?: "off" | "on",
	): Promise<Record<string, unknown>> {
		vi.resetModules();
		const streamed: Record<string, unknown>[] = [];
		vi.doMock("$lib/server/config-store", () => ({
			getConfig: () => ({ model1: {}, model2: {} }),
			normalizeModelSelectionWithProviders: async (id: string) => id,
		}));
		vi.doMock("$lib/server/services/normal-chat-model", () => ({
			resolveNormalChatModelRunProvider: async () => ({
				name: "qwen",
				modelId: "qwen3.8-flash-next",
			}),
			buildNormalChatModelRunProviderOptions: (
				provider: { name: string },
				mode: string | undefined,
			) => ({ [provider.name]: { enable_thinking: mode !== "off" } }),
			runStreamingNormalChatModelRun: (params: Record<string, unknown>) => {
				streamed.push(params);
				return (async function* () {
					yield { type: "text_delta", text: "{}" };
				})();
			},
		}));
		const { runAtlasModelStage } = await import("./model-stage");
		await runAtlasModelStage({
			stage: "synthesize",
			profile: "in-depth",
			modelSelection: "provider:p:qwen3.8-flash-next",
			system: "Write the section.",
			prompt: "{}",
			maxOutputTokens: 2_000,
			...(thinkingMode ? { thinkingMode } : {}),
		});
		vi.doUnmock("$lib/server/config-store");
		vi.doUnmock("$lib/server/services/normal-chat-model");
		return streamed[0];
	}

	it("resolves `enable_thinking: false` per attempt when thinking is off", async () => {
		const params = await runThroughBoundary("off");
		const resolve = params.resolveProviderOptions as (provider: {
			name: string;
		}) => unknown;
		expect(typeof resolve).toBe("function");
		expect(resolve({ name: "qwen" })).toEqual({
			qwen: { enable_thinking: false },
		});
	});

	it("sends no reasoning options at all when no mode is asked for", async () => {
		const params = await runThroughBoundary();
		expect(params.resolveProviderOptions).toBeUndefined();
		expect(params.providerOptions).toBeUndefined();
	});
});
