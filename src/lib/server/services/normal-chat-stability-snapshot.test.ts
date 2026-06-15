import { describe, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { StreamStats } from "$lib/server/services/chat-turn/active-streams";
import type { MaintenanceMetrics } from "$lib/server/services/maintenance-metrics";
import type { ProviderModel } from "$lib/server/services/provider-models";
import type { Provider } from "$lib/server/services/providers";
import { getNormalChatStabilitySnapshot } from "./normal-chat-stability-snapshot";

function config(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return {
		model1: {
			baseUrl: "https://model-one.example/v1",
			apiKey: "not-returned",
			modelName: "model-one",
			displayName: "Model One",
			systemPrompt: "",
			maxTokens: 4096,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2: {
			baseUrl: "https://model-two.example/v1",
			apiKey: "not-returned",
			modelName: "model-two",
			displayName: "Model Two",
			systemPrompt: "",
			maxTokens: 4096,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2Enabled: true,
		requestTimeoutMs: 300_000,
		modelTimeoutFailoverEnabled: true,
		modelTimeoutFailoverTargetModel: "model2",
		modelTimeoutFailoverTimeoutMs: 60_000,
		maxMessageLength: 1_048_576,
		maxModelContext: 262_144,
		compactionUiThreshold: 209_715,
		targetConstructedContext: 235_929,
		model1MaxModelContext: 262_144,
		model1CompactionUiThreshold: 209_715,
		model1TargetConstructedContext: 235_929,
		model1MaxMessageLength: 1_048_576,
		model2MaxModelContext: 262_144,
		model2CompactionUiThreshold: 209_715,
		model2TargetConstructedContext: 235_929,
		model2MaxMessageLength: 1_048_576,
		searxngBaseUrl: "http://searxng.local",
		webResearchMaxSources: 8,
		webResearchContentChars: 12_000,
		webResearchHighlightChars: 4_000,
		webResearchFreshnessHours: 24,
		webResearchSearxngLanguage: "en",
		webResearchSearxngSafesearch: 1,
		webResearchSearxngCategories: "general",
		braveSearchApiKey: "brave-key",
		fileProductionMaxOutputs: 4,
		fileProductionSandboxTimeoutMs: 120_000,
		fileProductionRendererTimeoutMs: 60_000,
		fileProductionMaxOutputFileBytes: 20_000_000,
		...overrides,
	} as RuntimeConfig;
}

function streamStats(overrides: Partial<StreamStats> = {}): StreamStats {
	return {
		globalActiveCount: 1,
		perUserCounts: new Map([["user-1", 1]]),
		maxGlobal: 10,
		maxPerUser: 3,
		...overrides,
	};
}

function provider(overrides: Partial<Provider> = {}): Provider {
	return {
		id: "provider-1",
		name: "provider-one",
		displayName: "Provider One",
		baseUrl: "https://provider.example/v1",
		iconAssetId: null,
		rateLimitFallbackEnabled: true,
		rateLimitFallbackBaseUrl: null,
		rateLimitFallbackModelName: null,
		rateLimitFallbackTimeoutMs: 10_000,
		processingRegionCode: null,
		privacyPolicyUrl: null,
		sortOrder: 0,
		enabled: true,
		createdAt: new Date("2026-06-01T00:00:00.000Z"),
		updatedAt: new Date("2026-06-01T00:00:00.000Z"),
		...overrides,
	};
}

describe("getNormalChatStabilitySnapshot", () => {
	it("returns a compact ok snapshot without user ids or secrets", async () => {
		const snapshot = await getNormalChatStabilitySnapshot({
			now: () => new Date("2026-06-04T10:00:00.000Z"),
			getConfig: () => config(),
			getStreamStats: () => streamStats(),
			listProviders: async () => [provider()],
			listEnabledProviderModels: async () => [
				{ id: "model-1", providerId: "provider-1" } as ProviderModel,
			],
			getAllMetrics: () => [],
		});

		expect(snapshot.status).toBe("ok");
		expect(snapshot.generatedAt).toBe("2026-06-04T10:00:00.000Z");
		expect(snapshot.streams).toMatchObject({
			status: "ok",
			activeCount: 1,
			activeUserCount: 1,
			largestUserActiveCount: 1,
		});
		expect(snapshot.providers).toMatchObject({
			status: "ok",
			builtinConfiguredCount: 2,
			enabledCustomProviderCount: 1,
			enabledCustomProviderModelCount: 1,
			rateLimitFallbackEnabledCount: 1,
		});
		expect(snapshot.webGrounding).toMatchObject({
			status: "ok",
			searxngConfigured: true,
			maxSources: 8,
		});
		expect(JSON.stringify(snapshot)).not.toContain("user-1");
		expect(JSON.stringify(snapshot)).not.toContain("not-returned");
		expect(JSON.stringify(snapshot)).not.toContain("brave-key");
	});

	it("marks saturated streams, missing search, invalid context, and failed maintenance as degraded", async () => {
		const metrics: MaintenanceMetrics[] = [
			{
				userId: "user-1",
				steps: {
					prune: {
						stepName: "prune",
						lastRunAt: Date.parse("2026-06-04T09:00:00.000Z"),
						lastDurationMs: 15,
						totalRuns: 1,
						totalSuccesses: 0,
						totalFailures: 1,
						lastError: "not returned",
						totalRowsAffected: 0,
					},
				},
			},
		];

		const snapshot = await getNormalChatStabilitySnapshot({
			getConfig: () =>
				config({
					searxngBaseUrl: "",
					model1TargetConstructedContext: 262_144,
				}),
			getStreamStats: () =>
				streamStats({
					globalActiveCount: 10,
					perUserCounts: new Map([["user-1", 3]]),
					maxGlobal: 10,
					maxPerUser: 3,
				}),
			listProviders: async () => [provider()],
			listEnabledProviderModels: async () => [],
			getAllMetrics: () => metrics,
		});

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.streams).toMatchObject({
			status: "degraded",
			globalSaturated: true,
			perUserSaturated: true,
		});
		expect(snapshot.webGrounding).toMatchObject({
			status: "degraded",
			degradedReason: "searxng_not_configured",
		});
		expect(snapshot.context.status).toBe("degraded");
		expect(snapshot.maintenance).toMatchObject({
			status: "degraded",
			trackedUserCount: 1,
			failedStepCount: 1,
			lastFailureAt: "2026-06-04T09:00:00.000Z",
		});
		expect(JSON.stringify(snapshot)).not.toContain("not returned");
	});

	it("degrades provider status when provider reads fail without throwing", async () => {
		const snapshot = await getNormalChatStabilitySnapshot({
			getConfig: () =>
				config({
					model1: {
						...config().model1,
						baseUrl: "",
						modelName: "",
					},
					model2Enabled: false,
				}),
			getStreamStats: () => streamStats({ globalActiveCount: 0 }),
			listProviders: vi.fn().mockRejectedValue(new Error("database down")),
			listEnabledProviderModels: async () => [],
			getAllMetrics: () => [],
		});

		expect(snapshot.status).toBe("degraded");
		expect(snapshot.providers).toMatchObject({
			status: "degraded",
			readable: false,
			errorCode: "provider_read_failed",
			builtinConfiguredCount: 0,
			enabledCustomProviderModelCount: 0,
		});
		expect(JSON.stringify(snapshot)).not.toContain("database down");
	});
});
