import { describe, expect, it } from "vitest";
import {
	resolveProviderModelPersistenceContextDefaults,
	resolveProviderModelPersistenceDefaults,
	resolveProviderModelRuntimeDefaults,
} from "./provider-model-runtime-defaults";

describe("Provider Model Runtime Defaults", () => {
	it("projects runtime context, output, reasoning, and thinking defaults", () => {
		expect(
			resolveProviderModelRuntimeDefaults({
				maxModelContext: 200_000,
				maxTokens: 4096,
				reasoningEffort: "high",
				thinkingType: "enabled",
			}),
		).toEqual({
			maxOutputTokens: 4096,
			maxModelContext: 200_000,
			compactionUiThreshold: 160_000,
			targetConstructedContext: 180_000,
			reasoningEffort: "high",
			thinkingType: "enabled",
		});
	});

	it("keeps explicit context overrides authoritative", () => {
		expect(
			resolveProviderModelRuntimeDefaults({
				maxModelContext: 200_000,
				compactionUiThreshold: 120_000,
				targetConstructedContext: 150_000,
			}),
		).toMatchObject({
			maxModelContext: 200_000,
			compactionUiThreshold: 120_000,
			targetConstructedContext: 150_000,
		});
	});

	it("derives persistence context defaults only when context is configured", () => {
		expect(
			resolveProviderModelPersistenceContextDefaults({
				maxModelContext: 128_000,
			}),
		).toEqual({
			maxModelContext: 128_000,
			compactionUiThreshold: 102_400,
			targetConstructedContext: 115_200,
		});

		expect(resolveProviderModelPersistenceContextDefaults({})).toEqual({
			maxModelContext: null,
			compactionUiThreshold: null,
			targetConstructedContext: null,
		});
	});

	it("projects persistence defaults for context, output, reasoning, and thinking", () => {
		expect(
			resolveProviderModelPersistenceDefaults({
				maxModelContext: 64_000,
				maxTokens: 2048,
				reasoningEffort: "medium",
				thinkingType: "disabled",
			}),
		).toEqual({
			maxModelContext: 64_000,
			compactionUiThreshold: 51_200,
			targetConstructedContext: 57_600,
			maxTokens: 2048,
			reasoningEffort: "medium",
			thinkingType: "disabled",
		});
	});
});
