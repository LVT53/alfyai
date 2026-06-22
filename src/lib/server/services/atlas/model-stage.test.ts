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
			runModel,
		});

		expect(runModel).toHaveBeenCalledWith(
			expect.objectContaining({
				modelSelection: "provider:provider-id:model-id",
				messages: [{ role: "user", content: "Use curated evidence only." }],
				system: expect.stringContaining("Atlas system prompt"),
				maxOutputTokens: expect.any(Number),
			}),
		);
		expect(result).toEqual({
			text: "Structured stage output",
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

	it("uses distinct max output token budgets for each Atlas profile", async () => {
		const { runAtlasModelStage } = await import("./model-stage");
		const calls: Array<{ profile: string; maxOutputTokens: number }> = [];

		for (const profile of ["overview", "in-depth", "exhaustive"] as const) {
			await runAtlasModelStage({
				stage: "synthesize",
				profile,
				modelSelection: "model1",
				system: "Atlas system prompt",
				prompt: "Use curated evidence only.",
				runModel: vi.fn(async (input) => {
					calls.push({ profile, maxOutputTokens: input.maxOutputTokens });
					return {
						text: "Profile output",
						usage: {
							inputTokens: 1,
							outputTokens: 1,
							totalTokens: 2,
						},
						model: {
							modelId: "model1",
							providerId: "provider",
							displayName: "Model 1",
						},
					};
				}),
			});
		}

		expect(calls).toEqual([
			{ profile: "overview", maxOutputTokens: 8000 },
			{ profile: "in-depth", maxOutputTokens: 12000 },
			{ profile: "exhaustive", maxOutputTokens: 16000 },
		]);
	});

	it("calls the normal chat model boundary for audit with strict JSON instructions", async () => {
		const { runAtlasAuditStage } = await import("./model-stage");
		const runModel = vi.fn(async () => ({
			text: '{"markers":[],"retryRequested":false}',
			usage: {
				inputTokens: 6,
				outputTokens: 4,
				totalTokens: 10,
			},
			model: {
				modelId: "provider:model:audit",
				providerId: "provider",
				displayName: "Audit",
			},
		}));

		const result = await runAtlasAuditStage({
			profile: "overview",
			modelSelection: "model2",
			prompt: '{"report":"Atlas"}',
			runModel,
		});

		expect(runModel).toHaveBeenCalledWith(
			expect.objectContaining({
				modelSelection: "model2",
				messages: [{ role: "user", content: '{"report":"Atlas"}' }],
				system: expect.stringContaining("Return strict JSON only"),
				maxOutputTokens: 1600,
			}),
		);
		expect(result.usage).toEqual({
			inputTokens: 6,
			outputTokens: 4,
			totalTokens: 10,
			costUsdMicros: 44,
		});
	});
});
