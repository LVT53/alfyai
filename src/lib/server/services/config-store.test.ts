import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let adminConfigRows: Array<{ key: string; value: string }> = [];
let providerRows: Array<{
	enabled: boolean | null;
	maxModelContext: number | null;
	maxMessageLength: number | null;
}> = [];

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
		deepResearchEnabled: false,
		deepResearchWorkerEnabled: false,
		deepResearchWorkerIntervalMs: 5000,
		deepResearchWorkerStaleTimeoutMs: 1800000,
		deepResearchJobRuntimeLimitMs: 7200000,
		deepResearchWorkerGlobalConcurrency: 2,
		deepResearchWorkerUserConcurrency: 2,
		deepResearchActiveConversationLimit: 1,
		deepResearchActiveUserLimit: 2,
		deepResearchActiveGlobalLimit: 4,
		deepResearchGlobalReasoningConcurrency: 4,
		deepResearchUserReasoningConcurrency: 4,
		deepResearchModels: {
			plan_generation: "model1",
			plan_revision: "model1",
			source_review: "model1",
			research_task: "model1",
			synthesis: "model1",
			citation_audit: "model1",
			report_writing: "model1",
		},
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTimeoutMs: 60000,
		modelTimeoutFailoverTargetModel: "model2",
		composerCommandRegistryEnabled: true,
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
		deepResearchEnabled: false,
		deepResearchWorkerEnabled: false,
		deepResearchWorkerIntervalMs: 5000,
		deepResearchWorkerStaleTimeoutMs: 1800000,
		deepResearchJobRuntimeLimitMs: 7200000,
		deepResearchWorkerGlobalConcurrency: 2,
		deepResearchWorkerUserConcurrency: 2,
		deepResearchActiveConversationLimit: 1,
		deepResearchActiveUserLimit: 2,
		deepResearchActiveGlobalLimit: 4,
		deepResearchGlobalReasoningConcurrency: 4,
		deepResearchUserReasoningConcurrency: 4,
		deepResearchModels: {
			plan_generation: "model1",
			plan_revision: "model1",
			source_review: "model1",
			research_task: "model1",
			synthesis: "model1",
			citation_audit: "model1",
			report_writing: "model1",
		},
		modelTimeoutFailoverEnabled: false,
		modelTimeoutFailoverTimeoutMs: 60000,
		modelTimeoutFailoverTargetModel: "model2",
		composerCommandRegistryEnabled: true,
	},
}));

// Import after mocks are defined
const {
	getDocumentTokenBudget,
	getWorkingSetPromptTokenBudget,
	getSmallFileThreshold,
	refreshConfig,
	getConfig,
	getResolvedAdminConfigValues,
} = await import("../config-store");

describe("Knowledge Store Config", () => {
	beforeEach(async () => {
		adminConfigRows = [];
		providerRows = [];
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

		it("getConfig() should keep Deep Research disabled by default", () => {
			const config = getConfig();
			expect(config.deepResearchEnabled).toBe(false);
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

		it("getConfig() should default max message length to the lowest enabled model cap", async () => {
			providerRows = [
				{ enabled: true, maxModelContext: 196_608, maxMessageLength: null },
				{
					enabled: true,
					maxModelContext: 1_048_576,
					maxMessageLength: 4_194_304,
				},
				{ enabled: false, maxModelContext: 50_000, maxMessageLength: 200_000 },
			];

			await refreshConfig();

			expect(getConfig().maxMessageLength).toBe(786_432);
		});

		it("getConfig() should allow an explicit global max message length override", async () => {
			adminConfigRows = [{ key: "MAX_MESSAGE_LENGTH", value: "50000" }];
			providerRows = [
				{ enabled: true, maxModelContext: 196_608, maxMessageLength: 786_432 },
			];

			await refreshConfig();

			expect(getConfig().maxMessageLength).toBe(50_000);
		});

		it("getConfig() should apply and clamp model timeout failover admin overrides", async () => {
			adminConfigRows = [
				{ key: "MODEL_TIMEOUT_FAILOVER_ENABLED", value: "true" },
				{ key: "MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS", value: "250" },
				{
					key: "MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
					value: "provider:backup",
				},
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.modelTimeoutFailoverEnabled).toBe(true);
			expect(config.modelTimeoutFailoverTimeoutMs).toBe(1000);
			expect(config.modelTimeoutFailoverTargetModel).toBe("provider:backup");
		});

		it("getConfig() should allow admin config to enable Deep Research", async () => {
			adminConfigRows = [{ key: "DEEP_RESEARCH_ENABLED", value: "true" }];

			await refreshConfig();

			expect(getConfig().deepResearchEnabled).toBe(true);
		});

		it("getConfig() should allow admin config to enable Composer Command Registry", async () => {
			adminConfigRows = [
				{ key: "COMPOSER_COMMAND_REGISTRY_ENABLED", value: "true" },
			];

			await refreshConfig();

			expect(getConfig().composerCommandRegistryEnabled).toBe(true);
		});

		it("getConfig() should expose Deep Research worker defaults", () => {
			const config = getConfig();

			expect(config.deepResearchEnabled).toBe(false);
			expect(config.deepResearchWorkerEnabled).toBe(false);
			expect(config.deepResearchWorkerIntervalMs).toBe(5000);
			expect(config.deepResearchWorkerStaleTimeoutMs).toBe(1800000);
			expect(config.deepResearchJobRuntimeLimitMs).toBe(7200000);
			expect(config.deepResearchWorkerGlobalConcurrency).toBe(2);
			expect(config.deepResearchWorkerUserConcurrency).toBe(2);
			expect(config.deepResearchActiveConversationLimit).toBe(1);
			expect(config.deepResearchActiveUserLimit).toBe(2);
			expect(config.deepResearchActiveGlobalLimit).toBe(4);
			expect(config.deepResearchGlobalReasoningConcurrency).toBe(4);
			expect(config.deepResearchUserReasoningConcurrency).toBe(4);
		});

		it("getConfig() should apply Deep Research worker admin overrides", async () => {
			adminConfigRows = [
				{ key: "DEEP_RESEARCH_ENABLED", value: "true" },
				{ key: "DEEP_RESEARCH_WORKER_ENABLED", value: "true" },
				{ key: "DEEP_RESEARCH_WORKER_INTERVAL_MS", value: "12000" },
				{ key: "DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS", value: "3600000" },
				{ key: "DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS", value: "5400000" },
				{ key: "DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY", value: "3" },
				{ key: "DEEP_RESEARCH_WORKER_USER_CONCURRENCY", value: "2" },
				{ key: "DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT", value: "1" },
				{ key: "DEEP_RESEARCH_ACTIVE_USER_LIMIT", value: "5" },
				{ key: "DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT", value: "8" },
				{ key: "DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY", value: "7" },
				{ key: "DEEP_RESEARCH_USER_REASONING_CONCURRENCY", value: "3" },
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.deepResearchEnabled).toBe(true);
			expect(config.deepResearchWorkerEnabled).toBe(true);
			expect(config.deepResearchWorkerIntervalMs).toBe(12000);
			expect(config.deepResearchWorkerStaleTimeoutMs).toBe(3600000);
			expect(config.deepResearchJobRuntimeLimitMs).toBe(5400000);
			expect(config.deepResearchWorkerGlobalConcurrency).toBe(3);
			expect(config.deepResearchWorkerUserConcurrency).toBe(2);
			expect(config.deepResearchActiveConversationLimit).toBe(1);
			expect(config.deepResearchActiveUserLimit).toBe(5);
			expect(config.deepResearchActiveGlobalLimit).toBe(8);
			expect(config.deepResearchGlobalReasoningConcurrency).toBe(7);
			expect(config.deepResearchUserReasoningConcurrency).toBe(3);
		});

		it("getConfig() should clamp small Deep Research worker overrides", async () => {
			adminConfigRows = [
				{ key: "DEEP_RESEARCH_WORKER_INTERVAL_MS", value: "250" },
				{ key: "DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS", value: "5000" },
				{ key: "DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS", value: "30000" },
				{ key: "DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY", value: "-2" },
				{ key: "DEEP_RESEARCH_WORKER_USER_CONCURRENCY", value: "-1" },
				{ key: "DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT", value: "0" },
				{ key: "DEEP_RESEARCH_ACTIVE_USER_LIMIT", value: "-1" },
				{ key: "DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT", value: "-4" },
				{ key: "DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY", value: "0" },
				{ key: "DEEP_RESEARCH_USER_REASONING_CONCURRENCY", value: "-3" },
			];

			await refreshConfig();

			const config = getConfig();
			expect(config.deepResearchWorkerIntervalMs).toBe(1000);
			expect(config.deepResearchWorkerStaleTimeoutMs).toBe(60000);
			expect(config.deepResearchJobRuntimeLimitMs).toBe(60000);
			expect(config.deepResearchWorkerGlobalConcurrency).toBe(0);
			expect(config.deepResearchWorkerUserConcurrency).toBe(0);
			expect(config.deepResearchActiveConversationLimit).toBe(1);
			expect(config.deepResearchActiveUserLimit).toBe(0);
			expect(config.deepResearchActiveGlobalLimit).toBe(0);
			expect(config.deepResearchGlobalReasoningConcurrency).toBe(1);
			expect(config.deepResearchUserReasoningConcurrency).toBe(0);
		});

		it("getConfig() should apply Deep Research role model admin overrides", async () => {
			adminConfigRows = [
				{ key: "DEEP_RESEARCH_PLAN_MODEL", value: "model2" },
				{
					key: "DEEP_RESEARCH_SOURCE_REVIEW_MODEL",
					value: "provider:openrouter",
				},
				{ key: "DEEP_RESEARCH_REPORT_MODEL", value: "invalid-model" },
			];

			await refreshConfig();

			expect(getConfig().deepResearchModels).toMatchObject({
				plan_generation: "model2",
				source_review: "provider:openrouter",
				report_writing: "model1",
			});
		});

		it("getConfig() should expose and override Deep Research depth budget policy", async () => {
			expect(getConfig().deepResearchDepthBudgets.focused).toMatchObject({
				sourceReviewCeiling: 24,
				meaningfulPassFloor: 2,
				meaningfulPassCeiling: 3,
				repairPassCeiling: 1,
				sourceProcessingConcurrency: 6,
				modelReasoningConcurrency: 2,
			});

			adminConfigRows = [
				{
					key: "DEEP_RESEARCH_DEPTH_BUDGETS_JSON",
					value: JSON.stringify({
						focused: {
							sourceReviewCeiling: 18,
							meaningfulPassFloor: 2,
							meaningfulPassCeiling: 4,
							repairPassCeiling: 2,
							sourceProcessingConcurrency: 5,
							modelReasoningConcurrency: 2,
						},
					}),
				},
			];

			await refreshConfig();

			expect(getConfig().deepResearchDepthBudgets.focused).toEqual({
				sourceReviewCeiling: 18,
				meaningfulPassFloor: 2,
				meaningfulPassCeiling: 4,
				repairPassCeiling: 2,
				sourceProcessingConcurrency: 5,
				modelReasoningConcurrency: 2,
			});
			expect(getConfig().deepResearchDepthBudgets.standard.sourceReviewCeiling).toBe(75);
		});

		it("getResolvedAdminConfigValues() should expose all Deep Research admin config keys", () => {
			const values = getResolvedAdminConfigValues();

			expect(values).toMatchObject({
				DEEP_RESEARCH_ENABLED: "false",
				DEEP_RESEARCH_WORKER_ENABLED: "false",
				DEEP_RESEARCH_WORKER_INTERVAL_MS: "5000",
				DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS: "1800000",
				DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS: "7200000",
				DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY: "2",
				DEEP_RESEARCH_WORKER_USER_CONCURRENCY: "2",
				DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT: "1",
				DEEP_RESEARCH_ACTIVE_USER_LIMIT: "2",
				DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT: "4",
				DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY: "4",
				DEEP_RESEARCH_USER_REASONING_CONCURRENCY: "4",
				DEEP_RESEARCH_PLAN_MODEL: "model1",
				DEEP_RESEARCH_PLAN_REVISION_MODEL: "model1",
				DEEP_RESEARCH_SOURCE_REVIEW_MODEL: "model1",
				DEEP_RESEARCH_RESEARCH_TASK_MODEL: "model1",
				DEEP_RESEARCH_SYNTHESIS_MODEL: "model1",
				DEEP_RESEARCH_CITATION_AUDIT_MODEL: "model1",
				DEEP_RESEARCH_REPORT_MODEL: "model1",
				COMPOSER_COMMAND_REGISTRY_ENABLED: "true",
			});
			const depthBudgets = JSON.parse(values.DEEP_RESEARCH_DEPTH_BUDGETS_JSON);
			expect(depthBudgets.focused).toMatchObject({
				sourceReviewCeiling: 24,
				meaningfulPassFloor: 2,
			});
			expect(depthBudgets.standard).toBeDefined();
			expect(depthBudgets.max).toBeDefined();
		});
	});
});
