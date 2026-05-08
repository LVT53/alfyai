import { describe, expect, it } from "vitest";

import {
	validateProviderLimitConfiguration,
	validateProviderLimitOrdering,
} from "./inference-providers";

describe("validateProviderLimitOrdering", () => {
	it("allows model-scaled target and compaction percentages", () => {
		expect(
			validateProviderLimitOrdering({
				maxModelContext: 1_000_000,
				targetConstructedContext: 900_000,
				compactionUiThreshold: 800_000,
			}),
		).toBeNull();
	});

	it("rejects max token caps that are not smaller than the model context", () => {
		expect(
			validateProviderLimitOrdering({
				maxModelContext: 146_000,
				compactionUiThreshold: 131_400,
				targetConstructedContext: 102_200,
				maxTokens: 262_000,
			}),
		).toBe("Max tokens must be less than max model context");
	});
});

describe("validateProviderLimitConfiguration", () => {
	it("requires third-party providers to configure max model context", () => {
		expect(
			validateProviderLimitConfiguration({
				maxModelContext: null,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxTokens: null,
			}),
		).toBe("Max model context is required");
	});

	it("allows optional target and compaction settings when max model context is configured", () => {
		expect(
			validateProviderLimitConfiguration({
				maxModelContext: 1_000_000,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxTokens: 8_192,
			}),
		).toBeNull();
	});

	it("allows a disabled legacy provider to keep null max model context", () => {
		expect(
			validateProviderLimitConfiguration({
				enabled: false,
				maxModelContext: null,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxTokens: null,
			}),
		).toBeNull();
	});

	it("blocks enabling a legacy provider while max model context is still null", () => {
		expect(
			validateProviderLimitConfiguration({
				enabled: true,
				maxModelContext: null,
				compactionUiThreshold: null,
				targetConstructedContext: null,
				maxTokens: null,
			}),
		).toBe("Max model context is required");
	});
});
