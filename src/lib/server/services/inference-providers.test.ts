import { afterEach, describe, expect, it, vi } from "vitest";

import {
	applyModelCapabilityOverrides,
	createModelCapabilitySet,
	isModelCapabilitySupported,
	isModelCapabilityUnsupported,
} from "$lib/model-capabilities";

import {
	probeProviderModelCapabilities,
	resolveProviderLimitDefaults,
	validateProviderConnection,
	validateProviderLimitConfiguration,
	validateProviderLimitOrdering,
} from "./inference-providers";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("model capability normalization", () => {
	it("preserves detected probe results while applying admin manual overrides", () => {
		const detected = createModelCapabilitySet({
			tools: { state: "detected", source: "probe" },
			structuredOutput: { state: "unknown", source: "probe" },
		});

		const normalized = applyModelCapabilityOverrides(detected, {
			tools: false,
			structuredOutput: true,
		});

		expect(normalized.tools).toMatchObject({
			state: "manual_override",
			supported: false,
			source: "manual_override",
		});
		expect(normalized.structuredOutput).toMatchObject({
			state: "manual_override",
			supported: true,
			source: "manual_override",
		});
		expect(normalized.chat).toMatchObject({
			state: "unknown",
			supported: null,
		});
	});

	it("treats explicit unsupported capability evidence differently from unknown", () => {
		const capabilities = createModelCapabilitySet({
			tools: {
				state: "not_detected",
				source: "probe",
			},
			streaming: {
				state: "unknown",
				source: "probe",
			},
		});

		expect(isModelCapabilityUnsupported(capabilities, "tools")).toBe(true);
		expect(isModelCapabilitySupported(capabilities, "tools")).toBe(false);
		expect(isModelCapabilityUnsupported(capabilities, "streaming")).toBe(
			false,
		);
		expect(isModelCapabilitySupported(capabilities, "streaming")).toBe(false);
	});
});

describe("probeProviderModelCapabilities", () => {
	it("detects /models validation support without inferring unstated chat behavior", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "provider-chat-model",
								object: "model",
								created: 1_686_935_002,
								owned_by: "provider",
							},
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const result = await probeProviderModelCapabilities(
			"https://provider.example/v1",
			"test-key",
			{ modelName: "provider-chat-model" },
		);

		expect(result.valid).toBe(true);
		expect(result.capabilities.modelsEndpoint).toMatchObject({
			state: "detected",
			supported: true,
		});
		expect(result.capabilities.chat).toMatchObject({
			state: "unknown",
			supported: null,
		});
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://provider.example/v1/models",
			expect.objectContaining({ method: "GET" }),
		);
	});

	it("marks /models validation as not detected when the endpoint is unavailable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);

		const result = await probeProviderModelCapabilities(
			"https://provider.example/v1",
			"test-key",
			{ modelName: "provider-chat-model" },
		);

		expect(result.valid).toBe(false);
		expect(result.capabilities.modelsEndpoint).toMatchObject({
			state: "not_detected",
			supported: false,
			source: "models_endpoint",
		});
	});

	it("keeps provider validation valid when /models omits the configured model while exposing the capability probe mismatch", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "different-provider-model",
								object: "model",
								created: 1_686_935_002,
								owned_by: "provider",
							},
						],
					}),
					{ status: 200 },
				),
		);
		vi.stubGlobal("fetch", fetchSpy);

		const validation = await validateProviderConnection(
			"https://provider.example/v1",
			"test-key",
			{ modelName: "configured-provider-model" },
		);
		const probe = await probeProviderModelCapabilities(
			"https://provider.example/v1",
			"test-key",
			{ modelName: "configured-provider-model" },
		);

		expect(validation).toMatchObject({
			valid: true,
			capabilities: {
				modelsEndpoint: {
					state: "detected",
					supported: true,
					detail: expect.stringContaining("not present"),
				},
			},
		});
		expect(probe).toMatchObject({
			valid: true,
			modelFound: false,
		});
		expect(probe.capabilities.modelsEndpoint).toMatchObject({
			state: "detected",
			supported: true,
			detail: expect.stringContaining("not present"),
		});
	});
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
	it("merges Fireworks OpenAI-compatible capability facts with /models probe evidence", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "accounts/fireworks/models/deepseek-v3p1",
								object: "model",
								created: 1_686_935_002,
								owned_by: "fireworks",
							},
						],
					}),
					{ status: 200 },
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fw_test_key",
			{ modelName: "accounts/fireworks/models/deepseek-v3p1" },
		);

		expect(result).toMatchObject({
			valid: true,
			capabilities: {
				chat: { state: "detected", supported: true },
				streaming: { state: "detected", supported: true },
				tools: { state: "detected", supported: true },
				structuredOutput: { state: "detected", supported: true },
				usageReporting: { state: "detected", supported: true },
				modelsEndpoint: { state: "detected", supported: true },
			},
		});
	});

	it("explains unverified Fireworks reasoning and multimodal input capabilities without faking support", async () => {
		const fetchSpy = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						data: [
							{
								id: "accounts/fireworks/models/deepseek-v3p1",
								object: "model",
								created: 1_686_935_002,
								owned_by: "fireworks",
							},
						],
					}),
					{ status: 200 },
				),
		);
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fw_test_key",
			{ modelName: "accounts/fireworks/models/deepseek-v3p1" },
		);

		expect(result).toMatchObject({
			valid: true,
			capabilities: {
				reasoningControls: {
					state: "unknown",
					supported: null,
					detail: expect.stringContaining("reasoning_effort"),
				},
				fileMessageParts: {
					state: "unknown",
					supported: null,
					detail: expect.stringContaining("message input"),
				},
				imageMessageParts: {
					state: "unknown",
					supported: null,
					detail: expect.stringContaining("message input"),
				},
			},
		});
		expect(result.capabilities?.fileMessageParts.detail).toContain(
			"not generated file production",
		);
		expect(result.capabilities?.imageMessageParts.detail).toContain(
			"not image search",
		);
	});

	it("marks Firepass Kimi reasoning controls as supported when the provider is configured to send reasoning controls", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 403 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{
				modelName: "accounts/fireworks/routers/kimi-k2p6-turbo",
				reasoningEffort: "high",
				thinkingType: "enabled",
			},
		);

		expect(result).toMatchObject({
			valid: true,
			capabilities: {
				reasoningControls: {
					state: "detected",
					supported: true,
					detail: expect.stringContaining("configured"),
				},
				fileMessageParts: {
					state: "unknown",
					supported: null,
					detail: expect.stringContaining("not generated file production"),
				},
				imageMessageParts: {
					state: "unknown",
					supported: null,
					detail: expect.stringContaining("not image search"),
				},
			},
		});
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("accepts Fire Pass keys for the documented Kimi Turbo router without probing /models", async () => {
		const fetchSpy = vi.fn(async () => new Response(null, { status: 403 }));
		globalThis.fetch = fetchSpy as unknown as typeof fetch;

		const result = await validateProviderConnection(
			"https://api.fireworks.ai/inference/v1",
			"fpk_test_key",
			{ modelName: "accounts/fireworks/routers/kimi-k2p6-turbo" },
		);

		expect(result).toMatchObject({
			valid: true,
			capabilities: {
				chat: { state: "detected", supported: true },
				streaming: { state: "detected", supported: true },
				tools: { state: "detected", supported: true },
				structuredOutput: { state: "detected", supported: true },
				usageReporting: { state: "detected", supported: true },
				modelsEndpoint: { state: "not_detected", supported: false },
			},
		});
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
