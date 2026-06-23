import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let adminConfigRows: Array<{ key: string; value: string }> = [];
let providerRows: Array<{
	enabled: boolean | null;
	maxModelContext: number | null;
	maxMessageLength: number | null;
}> = [];
let enabledProviderRows: Array<{
	id: string;
	name: string;
	displayName: string;
	iconAssetId: string | null;
	enabled: boolean;
}> = [];
let enabledProviderModelRowsByProvider = new Map<
	string,
	Array<{
		id: string;
		displayName: string;
		iconAssetId: string | null;
		enabled: boolean;
	}>
>();

// Mock must be defined before imports
vi.mock("../db", () => ({
	db: {
		select: vi.fn((fields?: unknown) => ({
			from: vi.fn(() =>
				Promise.resolve(fields ? providerRows : adminConfigRows),
			),
		})),
	},
}));

vi.mock("../env", () => ({
	config: {
		workingSetDocumentTokenBudget: 4000,
		workingSetPromptTokenBudget: 20000,
		smallFileThresholdChars: 5000,
		maxMessageLength: 1_048_576,
		maxModelContext: 262_144,
		model1MaxModelContext: 262_144,
		model1CompactionUiThreshold: 209_715,
		model1TargetConstructedContext: 235_929,
		model1MaxMessageLength: 1_048_576,
		model2MaxModelContext: 262_144,
		model2CompactionUiThreshold: 209_715,
		model2TargetConstructedContext: 235_929,
		model2MaxMessageLength: 1_048_576,
		model2Enabled: true,
		model1: {
			baseUrl: "http://localhost:30001/v1",
			apiKey: "",
			modelName: "model-1",
			displayName: "Model 1",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2: {
			baseUrl: "",
			apiKey: "",
			modelName: "",
			displayName: "Model 2",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTimeoutMs: 60000,
		modelTimeoutFailoverTargetModel: "model2",
		defaultNewUserModel: "model1",
		memoryLegacyCurationModel: "model1",
		reasoningDepthClassifierModel: null,
		atlasOverviewMaxOutputTokens: 8000,
		atlasInDepthMaxOutputTokens: 12000,
		atlasExhaustiveMaxOutputTokens: 16000,
		atlasMaxWriterPromptChars: 80000,
		composerCommandRegistryEnabled: true,
		searxngBaseUrl: "",
		webResearchSearxngNumResults: 12,
		webResearchSearxngLanguage: "en",
		webResearchSearxngSafesearch: 1,
		webResearchSearxngCategories: "general",
		webResearchMaxSources: 8,
		webResearchHighlightChars: 4000,
		webResearchContentChars: 12000,
		webResearchFreshnessHours: 24,
		webResearchExtractorMode: "readability",
		webResearchExtractTimeoutMs: 6000,
		webResearchExtractCacheTtlHours: 24,
		webResearchLlmExtractionReviewEnabled: false,
	},
	envConfig: {
		workingSetDocumentTokenBudget: 4000,
		workingSetPromptTokenBudget: 20000,
		smallFileThresholdChars: 5000,
		maxMessageLength: 1_048_576,
		maxModelContext: 262_144,
		model1MaxModelContext: 262_144,
		model1CompactionUiThreshold: 209_715,
		model1TargetConstructedContext: 235_929,
		model1MaxMessageLength: 1_048_576,
		model2MaxModelContext: 262_144,
		model2CompactionUiThreshold: 209_715,
		model2TargetConstructedContext: 235_929,
		model2MaxMessageLength: 1_048_576,
		model2Enabled: true,
		model1: {
			baseUrl: "http://localhost:30001/v1",
			apiKey: "",
			modelName: "model-1",
			displayName: "Model 1",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		model2: {
			baseUrl: "",
			apiKey: "",
			modelName: "",
			displayName: "Model 2",
			systemPrompt: "",
			maxTokens: null,
			reasoningEffort: null,
			thinkingType: null,
		},
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTimeoutMs: 60000,
		modelTimeoutFailoverTargetModel: "model2",
		defaultNewUserModel: "model1",
		memoryLegacyCurationModel: "model1",
		reasoningDepthClassifierModel: null,
		atlasOverviewMaxOutputTokens: 8000,
		atlasInDepthMaxOutputTokens: 12000,
		atlasExhaustiveMaxOutputTokens: 16000,
		atlasMaxWriterPromptChars: 80000,
		composerCommandRegistryEnabled: true,
		searxngBaseUrl: "",
		webResearchSearxngNumResults: 12,
		webResearchSearxngLanguage: "en",
		webResearchSearxngSafesearch: 1,
		webResearchSearxngCategories: "general",
		webResearchMaxSources: 8,
		webResearchHighlightChars: 4000,
		webResearchContentChars: 12000,
		webResearchFreshnessHours: 24,
		webResearchExtractorMode: "readability",
		webResearchExtractTimeoutMs: 6000,
		webResearchExtractCacheTtlHours: 24,
		webResearchLlmExtractionReviewEnabled: false,
	},
}));

vi.mock("./providers", () => ({
	listEnabledProviders: vi.fn(async () => enabledProviderRows),
}));

vi.mock("./provider-models", () => ({
	listEnabledProviderModels: vi.fn(async (providerId?: string) =>
		(providerId
			? (enabledProviderModelRowsByProvider.get(providerId) ?? [])
			: Array.from(enabledProviderModelRowsByProvider.values()).flat()
		).filter((model) => model.enabled !== false),
	),
}));

// Import after mocks are defined
const {
	getDocumentTokenBudget,
	getWorkingSetPromptTokenBudget,
	getSmallFileThreshold,
	refreshConfig,
	getConfig,
	getResolvedAdminConfigValues,
	getAvailableModels,
	getAvailableModelsWithProviders,
	modelIconUrl,
} = await import("../config-store");

describe("Knowledge Store Config", () => {
	beforeEach(async () => {
		adminConfigRows = [];
		providerRows = [];
		enabledProviderRows = [];
		enabledProviderModelRowsByProvider = new Map();
		await refreshConfig();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("Default Values", () => {
		it("getDocumentTokenBudget() should return 4000 by default", () => {
			const budget = getDocumentTokenBudget();
			expect(budget).toBe(4000);
		});

		it("getWorkingSetPromptTokenBudget() should return 20000 by default", () => {
			const budget = getWorkingSetPromptTokenBudget();
			expect(budget).toBe(20000);
		});

		it("getSmallFileThreshold() should return 5000 by default", () => {
			const threshold = getSmallFileThreshold();
			expect(threshold).toBe(5000);
		});
	});

	describe("Available model projection", () => {
		it("projects built-ins and enabled provider models for settings/default options", async () => {
			adminConfigRows = [
				{ key: "MODEL_1_ICON_ASSET_ID", value: "model-1-icon" },
				{ key: "MODEL_2_BASEURL", value: "http://localhost:30002/v1" },
				{ key: "MODEL_2_NAME", value: "model-2" },
				{ key: "MODEL_2_DISPLAY_NAME", value: "Model 2 Custom" },
			];
			enabledProviderRows = [
				{
					id: "provider-1",
					name: "openrouter",
					displayName: "OpenRouter",
					iconAssetId: "provider-icon",
					enabled: true,
				},
			];
			enabledProviderModelRowsByProvider = new Map([
				[
					"provider-1",
					[
						{
							id: "model-a",
							displayName: "Model A",
							iconAssetId: "model-a-icon",
							enabled: true,
						},
						{
							id: "model-b",
							displayName: "Model B",
							iconAssetId: null,
							enabled: false,
						},
					],
				],
			]);

			await refreshConfig();

			expect(modelIconUrl("asset with spaces")).toBe(
				"/api/campaign-assets/asset%20with%20spaces/content",
			);
			expect(getAvailableModels()).toEqual([
				{
					id: "model1",
					displayName: "Model 1",
					iconAssetId: "model-1-icon",
					iconUrl: "/api/campaign-assets/model-1-icon/content",
				},
				{
					id: "model2",
					displayName: "Model 2 Custom",
					iconAssetId: null,
					iconUrl: null,
				},
			]);
			await expect(getAvailableModelsWithProviders()).resolves.toEqual([
				{
					id: "model1",
					displayName: "Model 1",
					isThirdParty: false,
					iconAssetId: "model-1-icon",
					iconUrl: "/api/campaign-assets/model-1-icon/content",
				},
				{
					id: "model2",
					displayName: "Model 2 Custom",
					isThirdParty: false,
					iconAssetId: null,
					iconUrl: null,
				},
				{
					id: "provider:provider-1:model-a",
					displayName: "OpenRouter - Model A",
					isThirdParty: true,
					iconAssetId: "model-a-icon",
					iconUrl: "/api/campaign-assets/model-a-icon/content",
				},
			]);
		});
	});

	describe("Config Object Access", () => {
		it("getConfig() should include workingSetDocumentTokenBudget", () => {
			const config = getConfig();
			expect(config.workingSetDocumentTokenBudget).toBe(4000);
		});

		it("getConfig() should include workingSetPromptTokenBudget", () => {
			const config = getConfig();
			expect(config.workingSetPromptTokenBudget).toBe(20000);
		});

		it("getConfig() should include smallFileThresholdChars", () => {
			const config = getConfig();
			expect(config.smallFileThresholdChars).toBe(5000);
		});

		it("getConfig() should keep Composer Command Registry enabled by default", () => {
			const config = getConfig();
			expect(config.composerCommandRegistryEnabled).toBe(true);
		});

		it("getConfig() should expose model timeout failover defaults", () => {
			const config = getConfig();

			expect(config.modelTimeoutFailoverEnabled).toBe(false);
			expect(config.modelTimeoutFailoverTimeoutMs).toBe(60000);
			expect(config.modelTimeoutFailoverTargetModel).toBe("model2");
		});

		it("getConfig() should expose and override web research extraction settings", async () => {
			expect(getConfig()).toMatchObject({
				webResearchExtractorMode: "readability",
				webResearchExtractTimeoutMs: 6000,
				webResearchExtractCacheTtlHours: 24,
			});

			adminConfigRows = [
				{ key: "WEB_RESEARCH_EXTRACTOR_MODE", value: "auto" },
				{ key: "WEB_RESEARCH_EXTRACT_TIMEOUT_MS", value: "500" },
				{ key: "WEB_RESEARCH_EXTRACT_CACHE_TTL_HOURS", value: "-1" },
			];

			await refreshConfig();

			expect(getConfig()).toMatchObject({
				webResearchExtractorMode: "auto",
				webResearchExtractTimeoutMs: 1000,
				webResearchExtractCacheTtlHours: 0,
			});
			expect(getResolvedAdminConfigValues()).toMatchObject({
				WEB_RESEARCH_EXTRACTOR_MODE: "auto",
				WEB_RESEARCH_EXTRACT_TIMEOUT_MS: "1000",
				WEB_RESEARCH_EXTRACT_CACHE_TTL_HOURS: "0",
			});
		});

		it("getConfig() should default max message length to the lowest enabled model cap", async () => {
			await refreshConfig();

			expect(getConfig().maxMessageLength).toBe(1_048_576);
		});

		it("getConfig() should allow an explicit global max message length override", async () => {
			adminConfigRows = [{ key: "MAX_MESSAGE_LENGTH", value: "50000" }];
			providerRows = [
				{ enabled: true, maxModelContext: 196_608, maxMessageLength: 786_432 },
			];

			await refreshConfig();

			expect(getConfig().maxMessageLength).toBe(50_000);
		});

		it("getConfig() should derive global context budgets from a global max context override when target and threshold are unset", async () => {
			adminConfigRows = [{ key: "MAX_MODEL_CONTEXT", value: "1000000" }];

			await refreshConfig();

			const config = getConfig();
			expect(config.maxModelContext).toBe(1_000_000);
			expect(config.compactionUiThreshold).toBe(800_000);
			expect(config.targetConstructedContext).toBe(900_000);
		});

		it("getConfig() should keep explicit global context budget overrides", async () => {
			adminConfigRows = [
				{ key: "MAX_MODEL_CONTEXT", value: "1000000" },
				{ key: "COMPACTION_UI_THRESHOLD", value: "700000" },
				{ key: "TARGET_CONSTRUCTED_CONTEXT", value: "750000" },
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.maxModelContext).toBe(1_000_000);
			expect(config.compactionUiThreshold).toBe(700_000);
			expect(config.targetConstructedContext).toBe(750_000);
		});

		it("getConfig() should derive model-specific budgets from a model max context override when target and threshold are unset", async () => {
			adminConfigRows = [{ key: "MODEL_1_MAX_MODEL_CONTEXT", value: "132000" }];

			await refreshConfig();

			const config = getConfig();
			expect(config.model1MaxModelContext).toBe(132_000);
			expect(config.model1CompactionUiThreshold).toBe(105_600);
			expect(config.model1TargetConstructedContext).toBe(118_800);
			expect(config.model1MaxMessageLength).toBe(528_000);
			expect(config.maxMessageLength).toBe(528_000);
		});

		it("getConfig() should keep explicit model-specific context budget overrides", async () => {
			adminConfigRows = [
				{ key: "MODEL_1_MAX_MODEL_CONTEXT", value: "132000" },
				{ key: "MODEL_1_COMPACTION_UI_THRESHOLD", value: "90000" },
				{ key: "MODEL_1_TARGET_CONSTRUCTED_CONTEXT", value: "100000" },
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.model1MaxModelContext).toBe(132_000);
			expect(config.model1CompactionUiThreshold).toBe(90_000);
			expect(config.model1TargetConstructedContext).toBe(100_000);
			expect(config.model1MaxMessageLength).toBe(528_000);
			expect(config.maxMessageLength).toBe(528_000);
		});

		it("getConfig() should apply and clamp model timeout failover admin overrides", async () => {
			adminConfigRows = [
				{ key: "MODEL_TIMEOUT_FAILOVER_ENABLED", value: "true" },
				{ key: "MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS", value: "250" },
				{
					key: "MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
					value: "provider:backup:model-a",
				},
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.modelTimeoutFailoverEnabled).toBe(true);
			expect(config.modelTimeoutFailoverTimeoutMs).toBe(1000);
			expect(config.modelTimeoutFailoverTargetModel).toBe(
				"provider:backup:model-a",
			);
		});

		it("getConfig() should allow a provider as the default model for new users", async () => {
			adminConfigRows = [
				{ key: "DEFAULT_NEW_USER_MODEL", value: "provider:firepass" },
			];

			await refreshConfig();

			expect(getConfig().defaultNewUserModel).toBe("provider:firepass");
		});

		it("getConfig() should persist the memory legacy curation model", async () => {
			expect(getConfig().memoryLegacyCurationModel).toBe("model1");
			expect(getResolvedAdminConfigValues().MEMORY_LEGACY_CURATION_MODEL).toBe(
				"model1",
			);

			adminConfigRows = [
				{
					key: "MEMORY_LEGACY_CURATION_MODEL",
					value: "provider:memory-curator:model-a",
				},
			];

			await refreshConfig();

			expect(getConfig().memoryLegacyCurationModel).toBe(
				"provider:memory-curator:model-a",
			);
			expect(getResolvedAdminConfigValues().MEMORY_LEGACY_CURATION_MODEL).toBe(
				"provider:memory-curator:model-a",
			);
		});

		it("getConfig() should fall back when memory legacy curation model is invalid or disabled", async () => {
			adminConfigRows = [
				{
					key: "MEMORY_LEGACY_CURATION_MODEL",
					value: "invalid-model",
				},
			];

			await refreshConfig();

			expect(getConfig().memoryLegacyCurationModel).toBe("model1");

			adminConfigRows = [
				{ key: "MODEL_2_ENABLED", value: "false" },
				{
					key: "MEMORY_LEGACY_CURATION_MODEL",
					value: "model2",
				},
			];

			await refreshConfig();

			expect(getConfig().model2Enabled).toBe(false);
			expect(getConfig().memoryLegacyCurationModel).toBe("model1");
		});

		it("getConfig() should persist the optional Reasoning Depth classifier model", async () => {
			expect(getConfig().reasoningDepthClassifierModel).toBeNull();
			expect(
				getResolvedAdminConfigValues().REASONING_DEPTH_CLASSIFIER_MODEL,
			).toBe("");

			adminConfigRows = [
				{
					key: "REASONING_DEPTH_CLASSIFIER_MODEL",
					value: "provider:classifier:model-a",
				},
			];

			await refreshConfig();

			expect(getConfig().reasoningDepthClassifierModel).toBe(
				"provider:classifier:model-a",
			);
			expect(
				getResolvedAdminConfigValues().REASONING_DEPTH_CLASSIFIER_MODEL,
			).toBe("provider:classifier:model-a");
		});

		it("getConfig() should clear invalid reasoning depth classifier model admin overrides", async () => {
			adminConfigRows = [
				{
					key: "REASONING_DEPTH_CLASSIFIER_MODEL",
					value: "nonexistent-model",
				},
			];

			await refreshConfig();

			expect(getConfig().reasoningDepthClassifierModel).toBeNull();
			expect(
				getResolvedAdminConfigValues().REASONING_DEPTH_CLASSIFIER_MODEL,
			).toBe("");
		});

		it("getConfig() should clear reasoning depth classifier model when model2 is disabled", async () => {
			adminConfigRows = [
				{ key: "MODEL_2_ENABLED", value: "false" },
				{
					key: "REASONING_DEPTH_CLASSIFIER_MODEL",
					value: "model2",
				},
			];

			await refreshConfig();

			expect(getConfig().model2Enabled).toBe(false);
			expect(getConfig().reasoningDepthClassifierModel).toBeNull();
		});

		it("getConfig() should keep model1 as reasoning depth classifier when model1 is enabled", async () => {
			adminConfigRows = [
				{
					key: "REASONING_DEPTH_CLASSIFIER_MODEL",
					value: "model1",
				},
			];

			await refreshConfig();

			expect(getConfig().reasoningDepthClassifierModel).toBe("model1");
		});

		it("getConfig() should apply and expose the silent app version override", async () => {
			adminConfigRows = [
				{ key: "APP_VERSION_OVERRIDE", value: "2026.05-admin" },
			];

			await refreshConfig();

			expect(getConfig().appVersionOverride).toBe("2026.05-admin");
			expect(getResolvedAdminConfigValues().APP_VERSION_OVERRIDE).toBe(
				"2026.05-admin",
			);
		});

		it("getConfig() should allow admin config to enable Composer Command Registry", async () => {
			adminConfigRows = [
				{ key: "COMPOSER_COMMAND_REGISTRY_ENABLED", value: "true" },
			];

			await refreshConfig();

			expect(getConfig().composerCommandRegistryEnabled).toBe(true);
		});

		it("getResolvedAdminConfigValues() should expose remaining shared admin config keys", () => {
			const values = getResolvedAdminConfigValues();

			expect(values).toMatchObject({
				COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
				DEFAULT_NEW_USER_MODEL: "model1",
				MEMORY_LEGACY_CURATION_MODEL: "model1",
			});
		});

		it("getResolvedAdminConfigValues() should not expose retired Langflow model routing keys", async () => {
			adminConfigRows = [
				{ key: "MODEL_1_FLOW_ID", value: "legacy-flow" },
				{ key: "MODEL_1_COMPONENT_ID", value: "legacy-node" },
				{ key: "MODEL_2_FLOW_ID", value: "legacy-flow-2" },
				{ key: "MODEL_2_COMPONENT_ID", value: "legacy-node-2" },
			];

			await refreshConfig();

			const values = getResolvedAdminConfigValues();
			expect(values).not.toHaveProperty("MODEL_1_FLOW_ID");
			expect(values).not.toHaveProperty("MODEL_1_COMPONENT_ID");
			expect(values).not.toHaveProperty("MODEL_2_FLOW_ID");
			expect(values).not.toHaveProperty("MODEL_2_COMPONENT_ID");
		});
	});
});
