import { afterEach, describe, expect, it, vi } from "vitest";

import {
	resolveProviderLimitDefaults,
	validateProviderConnection,
	validateProviderLimitConfiguration,
	validateProviderLimitOrdering,
} from "./inference-providers";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.restoreAllMocks();
});

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

describe("resolveProviderLimitDefaults", () => {
	it("fills Fireworks model context and message defaults for researched model IDs", () => {
		expect(
			resolveProviderLimitDefaults({
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				maxModelContext: null,
				maxMessageLength: null,
			}),
		).toEqual({
			maxModelContext: 262_144,
			maxMessageLength: 1_048_576,
		});
		expect(
			resolveProviderLimitDefaults({
				modelName: "accounts/fireworks/models/deepseek-v4-pro",
				maxModelContext: null,
				maxMessageLength: null,
			}),
		).toEqual({
			maxModelContext: 1_048_576,
			maxMessageLength: 4_194_304,
		});
		expect(
			resolveProviderLimitDefaults({
				modelName: "accounts/fireworks/models/minimax-m2p7",
				maxModelContext: null,
				maxMessageLength: null,
			}),
		).toEqual({
			maxModelContext: 196_608,
			maxMessageLength: 786_432,
		});
	});

	it("derives a message default from custom provider context when no preset matches", () => {
		expect(
			resolveProviderLimitDefaults({
				modelName: "custom-model",
				maxModelContext: 100_000,
				maxMessageLength: null,
			}),
		).toEqual({
			maxModelContext: 100_000,
			maxMessageLength: 400_000,
		});
	});
});

describe("validateProviderConnection", () => {
	it("accepts Fire Pass keys for the documented Kimi Turbo router without probing /models", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 403 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{ modelName: "accounts/fireworks/routers/kimi-k2p6-turbo" },
		);

		expect(result).toEqual({ valid: true });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("rejects Fire Pass keys for non-Fire-Pass Fireworks models", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 200 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{ modelName: "accounts/fireworks/models/kimi-k2p6" },
		);

		expect(result).toEqual({
			valid: false,
			error:
				"Fire Pass keys only work with accounts/fireworks/routers/kimi-k2p6-turbo",
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});
