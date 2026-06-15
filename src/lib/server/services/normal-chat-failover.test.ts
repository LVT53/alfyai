import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import {
	isModelTimeoutError,
	isRetryableNormalChatFallbackError,
	resolveModelTimeoutFailoverTargetModelId,
	resolveNormalChatFallbackTargetModelId,
} from "./normal-chat-failover";

const mocks = vi.hoisted(() => ({
	getProviderModel: vi.fn(),
	getProviderWithSecrets: vi.fn(),
}));

const compatibleCapabilities = JSON.stringify({
	chat: true,
	streaming: true,
	tools: false,
	structuredOutput: false,
	reasoningControls: false,
	usageReporting: false,
	fileMessageParts: false,
	imageMessageParts: false,
	modelsEndpoint: false,
});

const incompatibleFallbackCapabilities = JSON.stringify({
	chat: true,
	streaming: true,
	tools: false,
	structuredOutput: false,
	reasoningControls: false,
	usageReporting: false,
	fileMessageParts: false,
	imageMessageParts: false,
	modelsEndpoint: false,
});

vi.mock("./provider-models", () => ({
	getProviderModel: mocks.getProviderModel,
}));

vi.mock("./providers", () => ({
	getProviderWithSecrets: mocks.getProviderWithSecrets,
}));

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return {
		modelTimeoutFailoverEnabled: true,
		modelTimeoutFailoverTargetModel: "model2",
		model2Enabled: true,
		...overrides,
	} as RuntimeConfig;
}

function createProviderModelRow(params: {
	id: string;
	providerId: string;
	name: string;
	displayName: string;
	fallbackProviderModelId?: string | null;
	capabilitiesJson?: string;
}) {
	return {
		id: params.id,
		providerId: params.providerId,
		name: params.name,
		displayName: params.displayName,
		iconAssetId: null,
		fallbackProviderModelId: params.fallbackProviderModelId ?? null,
		maxModelContext: null,
		compactionUiThreshold: null,
		targetConstructedContext: null,
		maxMessageLength: null,
		maxTokens: null,
		reasoningEffort: null,
		thinkingType: null,
		capabilitiesJson:
			params.capabilitiesJson ??
			JSON.stringify({
				chat: true,
				streaming: true,
				tools: false,
				structuredOutput: false,
				reasoningControls: false,
				usageReporting: false,
				fileMessageParts: false,
				imageMessageParts: false,
				modelsEndpoint: false,
			}),
		inputUsdMicrosPer1m: 1,
		cachedInputUsdMicrosPer1m: 1,
		cacheHitUsdMicrosPer1m: 1,
		cacheMissUsdMicrosPer1m: 1,
		outputUsdMicrosPer1m: 1,
		enabled: true,
		sortOrder: 0,
		createdAt: new Date("2026-01-01T00:00:00.000Z"),
		updatedAt: new Date("2026-01-01T00:00:00.000Z"),
	};
}

describe("resolveModelTimeoutFailoverTargetModelId", () => {
	it("returns the configured failover target for a different source model", async () => {
		await expect(
			resolveModelTimeoutFailoverTargetModelId(
				"model1",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "model2",
				}),
			),
		).resolves.toBe("model2");
	});

	it("rejects a provider-only failover target", async () => {
		await expect(
			resolveModelTimeoutFailoverTargetModelId(
				"model1",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "provider:provider-1",
				}),
			),
		).resolves.toBeNull();
	});
});

describe("resolveNormalChatFallbackTargetModelId", () => {
	beforeEach(() => {
		mocks.getProviderModel.mockReset();
		mocks.getProviderWithSecrets.mockReset();
		mocks.getProviderWithSecrets.mockResolvedValue({
			id: "provider-1",
			name: "provider-one",
			displayName: "Provider One",
			baseUrl: "https://provider.example/v1",
			apiKeyEncrypted: "encrypted",
			apiKeyIv: "iv",
			enabled: true,
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return createProviderModelRow({
					id: "source-model",
					providerId: "provider-1",
					name: "source-model",
					displayName: "Source Model",
					fallbackProviderModelId: "fallback-model",
					capabilitiesJson: compatibleCapabilities,
				});
			}
			if (id === "fallback-model") {
				return createProviderModelRow({
					id: "fallback-model",
					providerId: "provider-1",
					name: "fallback-model",
					displayName: "Fallback Model",
					capabilitiesJson: compatibleCapabilities,
				});
			}
			return null;
		});
	});

	it("prefers a compatible provider-model-specific fallback over the global target", async () => {
		await expect(
			resolveNormalChatFallbackTargetModelId(
				"provider:provider-1:source-model",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "model2",
				}),
			),
		).resolves.toBe("provider:provider-1:fallback-model");
		expect(mocks.getProviderModel).toHaveBeenCalledWith("source-model");
		expect(mocks.getProviderModel).toHaveBeenCalledWith("fallback-model");
	});

	it("rejects a provider-only global fallback target", async () => {
		await expect(
			resolveNormalChatFallbackTargetModelId(
				"model1",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "provider:provider-1",
				}),
			),
		).resolves.toBeNull();
		expect(mocks.getProviderWithSecrets).not.toHaveBeenCalledWith("provider-1");
	});

	it("treats an incompatible global provider-model fallback as unavailable", async () => {
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return {
					id: "source-model",
					providerId: "provider-1",
					name: "source-model",
					displayName: "Source Model",
					iconAssetId: null,
					fallbackProviderModelId: null,
					maxModelContext: null,
					compactionUiThreshold: null,
					targetConstructedContext: null,
					maxMessageLength: null,
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: true,
						structuredOutput: false,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
					inputUsdMicrosPer1m: 1,
					cachedInputUsdMicrosPer1m: 1,
					cacheHitUsdMicrosPer1m: 1,
					cacheMissUsdMicrosPer1m: 1,
					outputUsdMicrosPer1m: 1,
					enabled: true,
					sortOrder: 0,
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				};
			}
			if (id === "fallback-model") {
				return {
					id: "fallback-model",
					providerId: "provider-1",
					name: "fallback-model",
					displayName: "Fallback Model",
					iconAssetId: null,
					fallbackProviderModelId: null,
					maxModelContext: null,
					compactionUiThreshold: null,
					targetConstructedContext: null,
					maxMessageLength: null,
					maxTokens: null,
					reasoningEffort: null,
					thinkingType: null,
					capabilitiesJson: incompatibleFallbackCapabilities,
					inputUsdMicrosPer1m: 1,
					cachedInputUsdMicrosPer1m: 1,
					cacheHitUsdMicrosPer1m: 1,
					cacheMissUsdMicrosPer1m: 1,
					outputUsdMicrosPer1m: 1,
					enabled: true,
					sortOrder: 0,
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
					updatedAt: new Date("2026-01-01T00:00:00.000Z"),
				};
			}
			return null;
		});

		await expect(
			resolveNormalChatFallbackTargetModelId(
				"provider:provider-1:source-model",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "provider:provider-1:fallback-model",
				}),
			),
		).resolves.toBeNull();
	});

	it("accepts a compatible cross-provider provider-model fallback", async () => {
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId === "provider-1") {
				return {
					id: "provider-1",
					name: "source-provider",
					displayName: "Source Provider",
					baseUrl: "https://source.example/v1",
					apiKeyEncrypted: "encrypted",
					apiKeyIv: "iv",
					enabled: true,
				};
			}
			if (providerId === "provider-2") {
				return {
					id: "provider-2",
					name: "fallback-provider",
					displayName: "Fallback Provider",
					baseUrl: "https://fallback.example/v1",
					apiKeyEncrypted: "encrypted",
					apiKeyIv: "iv",
					enabled: true,
				};
			}
			return null;
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return createProviderModelRow({
					id: "source-model",
					providerId: "provider-1",
					name: "source-model",
					displayName: "Source Model",
					fallbackProviderModelId: "fallback-model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: false,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			if (id === "fallback-model") {
				return createProviderModelRow({
					id: "fallback-model",
					providerId: "provider-2",
					name: "fallback-model",
					displayName: "Fallback Model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: false,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			return null;
		});

		await expect(
			resolveNormalChatFallbackTargetModelId(
				"provider:provider-1:source-model",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "model2",
				}),
			),
		).resolves.toBe("provider:provider-2:fallback-model");
	});

	it("rejects a cross-provider provider-model fallback when capabilities are incompatible", async () => {
		mocks.getProviderWithSecrets.mockImplementation(async (providerId) => {
			if (providerId === "provider-1") {
				return {
					id: "provider-1",
					name: "source-provider",
					displayName: "Source Provider",
					baseUrl: "https://source.example/v1",
					apiKeyEncrypted: "encrypted",
					apiKeyIv: "iv",
					enabled: true,
				};
			}
			if (providerId === "provider-2") {
				return {
					id: "provider-2",
					name: "fallback-provider",
					displayName: "Fallback Provider",
					baseUrl: "https://fallback.example/v1",
					apiKeyEncrypted: "encrypted",
					apiKeyIv: "iv",
					enabled: true,
				};
			}
			return null;
		});
		mocks.getProviderModel.mockImplementation(async (id: string) => {
			if (id === "source-model") {
				return createProviderModelRow({
					id: "source-model",
					providerId: "provider-1",
					name: "source-model",
					displayName: "Source Model",
					fallbackProviderModelId: "fallback-model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: true,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			if (id === "fallback-model") {
				return createProviderModelRow({
					id: "fallback-model",
					providerId: "provider-2",
					name: "fallback-model",
					displayName: "Fallback Model",
					capabilitiesJson: JSON.stringify({
						chat: true,
						streaming: true,
						tools: false,
						structuredOutput: true,
						reasoningControls: false,
						usageReporting: false,
						fileMessageParts: false,
						imageMessageParts: false,
						modelsEndpoint: false,
					}),
				});
			}
			return null;
		});

		await expect(
			resolveNormalChatFallbackTargetModelId(
				"provider:provider-1:source-model",
				runtimeConfig({
					modelTimeoutFailoverTargetModel: "model2",
				}),
			),
		).resolves.toBeNull();
	});
});

describe("isRetryableNormalChatFallbackError", () => {
	it("does not retry permanent unavailable phrasing", () => {
		expect(
			isRetryableNormalChatFallbackError(new Error("model unavailable")),
		).toBe(false);
		expect(
			isRetryableNormalChatFallbackError(new Error("feature unavailable")),
		).toBe(false);
		expect(isRetryableNormalChatFallbackError(new Error("unavailable"))).toBe(
			false,
		);
	});

	it("still retries explicit temporary service availability failures", () => {
		expect(
			isRetryableNormalChatFallbackError(new Error("temporarily unavailable")),
		).toBe(true);
		expect(
			isRetryableNormalChatFallbackError(new Error("service unavailable")),
		).toBe(true);
		expect(isRetryableNormalChatFallbackError(new Error("overloaded"))).toBe(
			true,
		);
	});
});

describe("isModelTimeoutError", () => {
	it("recognizes model-provider timeout errors without classifying a plain abort as timeout", () => {
		const providerHttpxTimeout = new Error(
			"Code: None\n\n**APITimeoutError**\n - **Code: None**\nhttpcore.ReadTimeout\nhttpx.ReadTimeout",
		);
		const aiSdkTimeout = Object.assign(new Error("AI SDK request timeout"), {
			name: "TimeoutError",
		});
		const undiciTimeout = Object.assign(new Error("body timeout"), {
			code: "UND_ERR_BODY_TIMEOUT",
		});
		const userAbort = Object.assign(new Error("The operation was aborted"), {
			name: "AbortError",
		});

		expect(isModelTimeoutError(providerHttpxTimeout)).toBe(true);
		expect(isModelTimeoutError(aiSdkTimeout)).toBe(true);
		expect(isModelTimeoutError(undiciTimeout)).toBe(true);
		expect(isModelTimeoutError(userAbort)).toBe(false);
	});

	it("does not treat retired transport-specific timeout markers as the neutral contract", () => {
		const retiredTransportPrefix = "lang" + "flow";
		const retiredRequestName = Object.assign(
			new Error("remote transport failed"),
			{ name: `${retiredTransportPrefix}RequestTimeoutError` },
		);
		const retiredStreamName = Object.assign(
			new Error("remote transport failed"),
			{ name: `${retiredTransportPrefix}StreamConnectTimeoutError` },
		);
		const retiredRequestCode = Object.assign(
			new Error("remote transport failed"),
			{ code: `${retiredTransportPrefix}_request_timeout` },
		);
		const retiredStreamCode = Object.assign(
			new Error("remote transport failed"),
			{ code: `${retiredTransportPrefix}_stream_connect_timeout` },
		);

		expect(isModelTimeoutError(retiredRequestName)).toBe(false);
		expect(isModelTimeoutError(retiredStreamName)).toBe(false);
		expect(isModelTimeoutError(retiredRequestCode)).toBe(false);
		expect(isModelTimeoutError(retiredStreamCode)).toBe(false);
	});
});
