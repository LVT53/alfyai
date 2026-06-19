import { describe, expect, it, vi } from "vitest";

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
				costUsdMicros: 0,
			},
			model: {
				modelId: "provider:model:synthesis",
				providerId: "provider",
				displayName: "Synthesis",
			},
		});
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
			costUsdMicros: 0,
		});
	});
});
