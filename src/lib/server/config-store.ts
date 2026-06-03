// Runtime config store: merges env vars with admin_config DB overrides.
// All services should call getConfig() instead of importing from env.ts directly.

import {
	type DeepResearchDepthBudgetPolicy,
	type DeepResearchModelSelections,
	defaultDeepResearchModelSelections,
	normalizeConfiguredModelId,
	normalizeDeepResearchDepthBudgetPolicy,
} from "$lib/deep-research-models";
import { deriveMaxMessageLengthFromContextTokens } from "$lib/model-limit-presets";
import type { ModelId } from "$lib/types";
import { db } from "./db";
import { adminConfig, inferenceProviders } from "./db/schema";
import type { ModelConfig } from "./env";
import { config as envConfig } from "./env";
import { getSystemPrompt, normalizeSystemPromptReference } from "./prompts";

export type { ModelConfig } from "./env";

export const ADMIN_CONFIG_KEYS = [
	"MAX_MESSAGE_LENGTH",
	"MAX_MODEL_CONTEXT",
	"COMPACTION_UI_THRESHOLD",
	"TARGET_CONSTRUCTED_CONTEXT",
	"MODEL_1_MAX_MODEL_CONTEXT",
	"MODEL_1_COMPACTION_UI_THRESHOLD",
	"MODEL_1_TARGET_CONSTRUCTED_CONTEXT",
	"MODEL_1_MAX_MESSAGE_LENGTH",
	"MODEL_2_MAX_MODEL_CONTEXT",
	"MODEL_2_COMPACTION_UI_THRESHOLD",
	"MODEL_2_TARGET_CONSTRUCTED_CONTEXT",
	"MODEL_2_MAX_MESSAGE_LENGTH",
	"WORKING_SET_DOCUMENT_TOKEN_BUDGET",
	"WORKING_SET_PROMPT_TOKEN_BUDGET",
	"SMALL_FILE_THRESHOLD_CHARS",
	"MODEL_1_BASEURL",
	"MODEL_1_API_KEY",
	"MODEL_1_NAME",
	"MODEL_1_DISPLAY_NAME",
	"MODEL_1_ICON_ASSET_ID",
	"MODEL_1_SYSTEM_PROMPT",
	"MODEL_1_MAX_TOKENS",
	"MODEL_1_REASONING_EFFORT",
	"MODEL_1_THINKING_TYPE",
	"MODEL_2_BASEURL",
	"MODEL_2_API_KEY",
	"MODEL_2_NAME",
	"MODEL_2_DISPLAY_NAME",
	"MODEL_2_ICON_ASSET_ID",
	"MODEL_2_SYSTEM_PROMPT",
	"MODEL_2_MAX_TOKENS",
	"MODEL_2_REASONING_EFFORT",
	"MODEL_2_THINKING_TYPE",
	"MODEL_2_ENABLED",
	"COMPOSER_COMMAND_REGISTRY_ENABLED",
	"DEEP_RESEARCH_ENABLED",
	"DEEP_RESEARCH_WORKER_ENABLED",
	"DEEP_RESEARCH_WORKER_INTERVAL_MS",
	"DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS",
	"DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS",
	"DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY",
	"DEEP_RESEARCH_WORKER_USER_CONCURRENCY",
	"DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT",
	"DEEP_RESEARCH_ACTIVE_USER_LIMIT",
	"DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT",
	"DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY",
	"DEEP_RESEARCH_USER_REASONING_CONCURRENCY",
	"DEEP_RESEARCH_DEPTH_BUDGETS_JSON",
	"DEEP_RESEARCH_PLAN_MODEL",
	"DEEP_RESEARCH_PLAN_REVISION_MODEL",
	"DEEP_RESEARCH_SOURCE_REVIEW_MODEL",
	"DEEP_RESEARCH_RESEARCH_TASK_MODEL",
	"DEEP_RESEARCH_SYNTHESIS_MODEL",
	"DEEP_RESEARCH_CITATION_AUDIT_MODEL",
	"DEEP_RESEARCH_REPORT_MODEL",
	"TITLE_GEN_URL",
	"TITLE_GEN_MODEL",
	"TITLE_GEN_SYSTEM_PROMPT_EN",
	"TITLE_GEN_SYSTEM_PROMPT_HU",
	"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN",
	"TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU",
	"CONTEXT_SUMMARIZER_URL",
	"CONTEXT_SUMMARIZER_MODEL",
	"TEI_EMBEDDER_URL",
	"TEI_EMBEDDER_MODEL",
	"TEI_EMBEDDER_BATCH_SIZE",
	"TEI_RERANKER_URL",
	"TEI_RERANKER_MODEL",
	"TEI_RERANKER_MAX_TEXTS",
	"HONCHO_ENABLED",
	"HONCHO_CONTEXT_WAIT_MS",
	"HONCHO_PERSONA_CONTEXT_WAIT_MS",
	"HONCHO_OVERVIEW_WAIT_MS",
	"MINERU_API_URL",
	"MINERU_TIMEOUT_MS",
	"SEARXNG_BASE_URL",
	"WEB_RESEARCH_SEARXNG_NUM_RESULTS",
	"WEB_RESEARCH_SEARXNG_LANGUAGE",
	"WEB_RESEARCH_SEARXNG_SAFESEARCH",
	"WEB_RESEARCH_SEARXNG_CATEGORIES",
	"WEB_RESEARCH_MAX_SOURCES",
	"WEB_RESEARCH_HIGHLIGHT_CHARS",
	"WEB_RESEARCH_CONTENT_CHARS",
	"WEB_RESEARCH_FRESHNESS_HOURS",
	"BRAVE_SEARCH_API_KEY",
	"APP_VERSION_OVERRIDE",
	"SYSTEM_PROMPT",
	"MAX_FILE_UPLOAD_SIZE",
	"REQUEST_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_ENABLED",
	"MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
	"DEFAULT_NEW_USER_MODEL",
	"FILE_PRODUCTION_MAX_OUTPUTS",
	"FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES",
	"FILE_PRODUCTION_MAX_PROJECTION_BYTES",
	"FILE_PRODUCTION_MAX_PDF_PAGES",
	"FILE_PRODUCTION_MAX_TABLE_ROWS",
	"FILE_PRODUCTION_MAX_TABLE_COLUMNS",
	"FILE_PRODUCTION_MAX_CHART_DATA_POINTS",
	"FILE_PRODUCTION_MAX_CHART_SERIES",
	"FILE_PRODUCTION_MAX_IMAGE_COUNT",
	"FILE_PRODUCTION_MAX_IMAGE_BYTES",
	"FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES",
	"FILE_PRODUCTION_SANDBOX_TIMEOUT_MS",
	"FILE_PRODUCTION_RENDERER_TIMEOUT_MS",
	"FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES",
	"FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES",
	"CONTEXT_DIAGNOSTICS_DEBUG",
] as const;

export type AdminConfigKey = (typeof ADMIN_CONFIG_KEYS)[number];

export interface RuntimeConfig {
	attachmentTraceDebug: boolean;
	composerCommandRegistryEnabled: boolean;
	deepResearchEnabled: boolean;
	deepResearchWorkerEnabled: boolean;
	deepResearchWorkerIntervalMs: number;
	deepResearchWorkerStaleTimeoutMs: number;
	deepResearchJobRuntimeLimitMs: number;
	deepResearchWorkerGlobalConcurrency: number;
	deepResearchWorkerUserConcurrency: number;
	deepResearchActiveConversationLimit: number;
	deepResearchActiveUserLimit: number;
	deepResearchActiveGlobalLimit: number;
	deepResearchGlobalReasoningConcurrency: number;
	deepResearchUserReasoningConcurrency: number;
	deepResearchDepthBudgets: DeepResearchDepthBudgetPolicy;
	deepResearchModels: DeepResearchModelSelections;
	contextDiagnosticsDebug: boolean;
	appVersionOverride: string | null;
	titleGenUrl: string;
	titleGenApiKey: string;
	titleGenModel: string;
	titleGenSystemPromptEn: string;
	titleGenSystemPromptHu: string;
	titleGenSystemPromptCodeAppendixEn: string;
	titleGenSystemPromptCodeAppendixHu: string;
	contextSummarizerUrl: string;
	contextSummarizerApiKey: string;
	contextSummarizerModel: string;
	teiEmbedderUrl: string;
	teiEmbedderApiKey: string;
	teiEmbedderModel: string;
	teiEmbedderBatchSize: number;
	teiRerankerUrl: string;
	teiRerankerApiKey: string;
	teiRerankerModel: string;
	teiRerankerMaxTexts: number;
	teiTimeoutMs: number;
	requestTimeoutMs: number;
	modelTimeoutFailoverEnabled: boolean;
	modelTimeoutFailoverTimeoutMs: number;
	modelTimeoutFailoverTargetModel: ModelId;
	defaultNewUserModel: ModelId;
	maxMessageLength: number;
	maxModelContext: number;
	compactionUiThreshold: number;
	targetConstructedContext: number;
	model1MaxModelContext: number;
	model1CompactionUiThreshold: number;
	model1TargetConstructedContext: number;
	model1MaxMessageLength: number;
	model2MaxModelContext: number;
	model2CompactionUiThreshold: number;
	model2TargetConstructedContext: number;
	model2MaxMessageLength: number;
	workingSetDocumentTokenBudget: number;
	workingSetPromptTokenBudget: number;
	smallFileThresholdChars: number;
	sessionSecret: string;
	databasePath: string;
	model1: ModelConfig;
	model2: ModelConfig;
	model1IconAssetId: string | null;
	model2IconAssetId: string | null;
	model2Enabled: boolean;
	honchoApiKey: string;
	honchoBaseUrl: string;
	honchoWorkspace: string;
	honchoIdentityNamespace: string;
	honchoEnabled: boolean;
	honchoContextWaitMs: number;
	honchoPersonaContextWaitMs: number;
	honchoOverviewWaitMs: number;
	memoryMaintenanceIntervalMinutes: number;
	mineruApiUrl: string;
	mineruTimeoutMs: number;
	searxngBaseUrl: string;
	webResearchSearxngNumResults: number;
	webResearchSearxngLanguage: string;
	webResearchSearxngSafesearch: number;
	webResearchSearxngCategories: string;
	webResearchMaxSources: number;
	webResearchHighlightChars: number;
	webResearchContentChars: number;
	webResearchFreshnessHours: number;
	braveSearchApiKey: string;
	concurrentStreamLimit: number;
	perUserStreamLimit: number;
	systemPrompt: string;
	maxFileUploadSize: number;
	fileProductionMaxOutputs: number;
	fileProductionMaxSourceJsonBytes: number;
	fileProductionMaxProjectionBytes: number;
	fileProductionMaxPdfPages: number;
	fileProductionMaxTableRows: number;
	fileProductionMaxTableColumns: number;
	fileProductionMaxChartDataPoints: number;
	fileProductionMaxChartSeries: number;
	fileProductionMaxImageCount: number;
	fileProductionMaxImageBytes: number;
	fileProductionMaxTotalImageBytes: number;
	fileProductionSandboxTimeoutMs: number;
	fileProductionRendererTimeoutMs: number;
	fileProductionMaxOutputFileBytes: number;
	fileProductionMaxTotalOutputBytes: number;
}

function buildDefaultConfig(): RuntimeConfig {
	return {
		...envConfig,
		model1: { ...envConfig.model1 },
		model2: { ...envConfig.model2 },
		deepResearchModels: {
			...(envConfig.deepResearchModels ?? defaultDeepResearchModelSelections()),
		},
		deepResearchDepthBudgets: normalizeDeepResearchDepthBudgetPolicy(
			envConfig.deepResearchDepthBudgets,
		),
		braveSearchApiKey: envConfig.braveSearchApiKey,
		appVersionOverride: null,
		model1IconAssetId: null,
		model2IconAssetId: null,
		composerCommandRegistryEnabled:
			envConfig.composerCommandRegistryEnabled ?? true,
		deepResearchEnabled: envConfig.deepResearchEnabled ?? false,
	};
}

let runtimeConfig: RuntimeConfig = buildDefaultConfig();

type OverrideApplier = (config: RuntimeConfig, value: string) => void;

function parseIntOverride(value: string): number | undefined {
	const parsed = parseInt(value, 10);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeReasoningEffortOverride(
	value: string,
): ModelConfig["reasoningEffort"] {
	return value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "max" ||
		value === "xhigh"
		? value
		: null;
}

function normalizeThinkingTypeOverride(
	value: string,
): ModelConfig["thinkingType"] {
	return value === "enabled" || value === "disabled" ? value : null;
}

function positiveIntegerOrNull(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) && value > 0
		? value
		: null;
}

async function resolveLowestModelMaxMessageLength(
	config: RuntimeConfig,
): Promise<number> {
	const candidates = [
		positiveIntegerOrNull(config.model1MaxMessageLength),
		config.model2Enabled === false
			? null
			: positiveIntegerOrNull(config.model2MaxMessageLength),
	];

	const providerRows = await db
		.select({
			enabled: inferenceProviders.enabled,
			maxModelContext: inferenceProviders.maxModelContext,
			maxMessageLength: inferenceProviders.maxMessageLength,
		})
		.from(inferenceProviders);

	for (const provider of providerRows) {
		if (provider.enabled === false) continue;
		candidates.push(
			positiveIntegerOrNull(provider.maxMessageLength) ??
				(provider.maxModelContext != null
					? deriveMaxMessageLengthFromContextTokens(provider.maxModelContext)
					: null),
		);
	}

	return Math.min(
		...candidates.filter((value): value is number => value != null),
	);
}

function deriveCompactionUiThreshold(maxModelContext: number): number {
	return Math.max(
		1,
		Math.min(maxModelContext - 1, Math.floor(maxModelContext * 0.8)),
	);
}

function deriveTargetConstructedContext(maxModelContext: number): number {
	return Math.max(
		1,
		Math.min(maxModelContext - 1, Math.floor(maxModelContext * 0.9)),
	);
}

function applyDerivedContextLimitDefaults(
	config: RuntimeConfig,
	overrides: Record<string, string>,
): void {
	if (overrides.MAX_MODEL_CONTEXT !== undefined) {
		if (overrides.COMPACTION_UI_THRESHOLD === undefined) {
			config.compactionUiThreshold = deriveCompactionUiThreshold(
				config.maxModelContext,
			);
		}
		if (overrides.TARGET_CONSTRUCTED_CONTEXT === undefined) {
			config.targetConstructedContext = deriveTargetConstructedContext(
				config.maxModelContext,
			);
		}
	}

	if (overrides.MODEL_1_MAX_MODEL_CONTEXT !== undefined) {
		if (overrides.MODEL_1_COMPACTION_UI_THRESHOLD === undefined) {
			config.model1CompactionUiThreshold = deriveCompactionUiThreshold(
				config.model1MaxModelContext,
			);
		}
		if (overrides.MODEL_1_TARGET_CONSTRUCTED_CONTEXT === undefined) {
			config.model1TargetConstructedContext = deriveTargetConstructedContext(
				config.model1MaxModelContext,
			);
		}
	}

	if (overrides.MODEL_2_MAX_MODEL_CONTEXT !== undefined) {
		if (overrides.MODEL_2_COMPACTION_UI_THRESHOLD === undefined) {
			config.model2CompactionUiThreshold = deriveCompactionUiThreshold(
				config.model2MaxModelContext,
			);
		}
		if (overrides.MODEL_2_TARGET_CONSTRUCTED_CONTEXT === undefined) {
			config.model2TargetConstructedContext = deriveTargetConstructedContext(
				config.model2MaxModelContext,
			);
		}
	}
}

function applyDerivedMaxMessageLengthDefaults(
	config: RuntimeConfig,
	overrides: Record<string, string>,
): void {
	if (
		overrides.MODEL_1_MAX_MODEL_CONTEXT !== undefined &&
		overrides.MODEL_1_MAX_MESSAGE_LENGTH === undefined
	) {
		config.model1MaxMessageLength = deriveMaxMessageLengthFromContextTokens(
			config.model1MaxModelContext,
		);
	}

	if (
		overrides.MODEL_2_MAX_MODEL_CONTEXT !== undefined &&
		overrides.MODEL_2_MAX_MESSAGE_LENGTH === undefined
	) {
		config.model2MaxMessageLength = deriveMaxMessageLengthFromContextTokens(
			config.model2MaxModelContext,
		);
	}
}

function validateContextLimitTriples(config: RuntimeConfig): void {
	function invalidTriple(
		max: number,
		threshold: number,
		target: number,
	): boolean {
		return target >= max || threshold >= max;
	}

	if (
		invalidTriple(
			config.maxModelContext,
			config.compactionUiThreshold,
			config.targetConstructedContext,
		)
	) {
		config.targetConstructedContext = envConfig.targetConstructedContext;
		config.compactionUiThreshold = envConfig.compactionUiThreshold;
		config.maxModelContext = envConfig.maxModelContext;
	}

	if (
		invalidTriple(
			config.model1MaxModelContext,
			config.model1CompactionUiThreshold,
			config.model1TargetConstructedContext,
		)
	) {
		config.model1TargetConstructedContext =
			envConfig.model1TargetConstructedContext;
		config.model1CompactionUiThreshold = envConfig.model1CompactionUiThreshold;
		config.model1MaxModelContext = envConfig.model1MaxModelContext;
	}

	if (
		invalidTriple(
			config.model2MaxModelContext,
			config.model2CompactionUiThreshold,
			config.model2TargetConstructedContext,
		)
	) {
		config.model2TargetConstructedContext =
			envConfig.model2TargetConstructedContext;
		config.model2CompactionUiThreshold = envConfig.model2CompactionUiThreshold;
		config.model2MaxModelContext = envConfig.model2MaxModelContext;
	}
}

const overrideAppliers: Record<AdminConfigKey, OverrideApplier> = {
	MAX_MESSAGE_LENGTH: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.maxMessageLength = parsed;
	},
	MAX_MODEL_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.maxModelContext = parsed;
	},
	COMPACTION_UI_THRESHOLD: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.compactionUiThreshold = parsed;
	},
	TARGET_CONSTRUCTED_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.targetConstructedContext = parsed;
	},
	MODEL_1_MAX_MODEL_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model1MaxModelContext = parsed;
	},
	MODEL_1_COMPACTION_UI_THRESHOLD: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model1CompactionUiThreshold = parsed;
	},
	MODEL_1_TARGET_CONSTRUCTED_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model1TargetConstructedContext = parsed;
	},
	MODEL_1_MAX_MESSAGE_LENGTH: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model1MaxMessageLength = parsed;
	},
	MODEL_2_MAX_MODEL_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model2MaxModelContext = parsed;
	},
	MODEL_2_COMPACTION_UI_THRESHOLD: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model2CompactionUiThreshold = parsed;
	},
	MODEL_2_TARGET_CONSTRUCTED_CONTEXT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model2TargetConstructedContext = parsed;
	},
	MODEL_2_MAX_MESSAGE_LENGTH: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.model2MaxMessageLength = parsed;
	},
	WORKING_SET_DOCUMENT_TOKEN_BUDGET: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.workingSetDocumentTokenBudget = Math.max(100, parsed);
	},
	WORKING_SET_PROMPT_TOKEN_BUDGET: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.workingSetPromptTokenBudget = Math.max(1000, parsed);
	},
	SMALL_FILE_THRESHOLD_CHARS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.smallFileThresholdChars = Math.max(100, parsed);
	},
	MODEL_1_BASEURL: (config, value) => {
		config.model1.baseUrl = value;
	},
	MODEL_1_API_KEY: (config, value) => {
		config.model1.apiKey = value;
	},
	MODEL_1_NAME: (config, value) => {
		config.model1.modelName = value;
	},
	MODEL_1_DISPLAY_NAME: (config, value) => {
		config.model1.displayName = value;
	},
	MODEL_1_ICON_ASSET_ID: (config, value) => {
		config.model1IconAssetId = value.trim() || null;
	},
	MODEL_1_SYSTEM_PROMPT: (config, value) => {
		config.model1.systemPrompt = normalizeSystemPromptReference(value) ?? "";
	},
	MODEL_1_MAX_TOKENS: (config, value) => {
		const parsed = parseIntOverride(value);
		config.model1.maxTokens = parsed !== undefined ? Math.max(1, parsed) : null;
	},
	MODEL_1_REASONING_EFFORT: (config, value) => {
		config.model1.reasoningEffort = normalizeReasoningEffortOverride(value);
	},
	MODEL_1_THINKING_TYPE: (config, value) => {
		config.model1.thinkingType = normalizeThinkingTypeOverride(value);
	},
	MODEL_2_BASEURL: (config, value) => {
		config.model2.baseUrl = value;
	},
	MODEL_2_API_KEY: (config, value) => {
		config.model2.apiKey = value;
	},
	MODEL_2_NAME: (config, value) => {
		config.model2.modelName = value;
	},
	MODEL_2_DISPLAY_NAME: (config, value) => {
		config.model2.displayName = value;
	},
	MODEL_2_ICON_ASSET_ID: (config, value) => {
		config.model2IconAssetId = value.trim() || null;
	},
	MODEL_2_SYSTEM_PROMPT: (config, value) => {
		config.model2.systemPrompt = normalizeSystemPromptReference(value) ?? "";
	},
	MODEL_2_MAX_TOKENS: (config, value) => {
		const parsed = parseIntOverride(value);
		config.model2.maxTokens = parsed !== undefined ? Math.max(1, parsed) : null;
	},
	MODEL_2_REASONING_EFFORT: (config, value) => {
		config.model2.reasoningEffort = normalizeReasoningEffortOverride(value);
	},
	MODEL_2_THINKING_TYPE: (config, value) => {
		config.model2.thinkingType = normalizeThinkingTypeOverride(value);
	},
	MODEL_2_ENABLED: (config, value) => {
		config.model2Enabled = value === "true";
	},
	COMPOSER_COMMAND_REGISTRY_ENABLED: (config, value) => {
		config.composerCommandRegistryEnabled = value === "true";
	},
	DEEP_RESEARCH_ENABLED: (config, value) => {
		config.deepResearchEnabled = value === "true";
	},
	DEEP_RESEARCH_WORKER_ENABLED: (config, value) => {
		config.deepResearchWorkerEnabled = value === "true";
	},
	DEEP_RESEARCH_WORKER_INTERVAL_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchWorkerIntervalMs = Math.max(1000, parsed);
		}
	},
	DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchWorkerStaleTimeoutMs = Math.max(60000, parsed);
		}
	},
	DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchJobRuntimeLimitMs = Math.max(60000, parsed);
		}
	},
	DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchWorkerGlobalConcurrency = Math.max(0, parsed);
		}
	},
	DEEP_RESEARCH_WORKER_USER_CONCURRENCY: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchWorkerUserConcurrency = Math.max(0, parsed);
		}
	},
	DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchActiveConversationLimit = Math.max(1, parsed);
		}
	},
	DEEP_RESEARCH_ACTIVE_USER_LIMIT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchActiveUserLimit = Math.max(0, parsed);
		}
	},
	DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchActiveGlobalLimit = Math.max(0, parsed);
		}
	},
	DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchGlobalReasoningConcurrency = Math.max(1, parsed);
		}
	},
	DEEP_RESEARCH_USER_REASONING_CONCURRENCY: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.deepResearchUserReasoningConcurrency = Math.max(0, parsed);
		}
	},
	DEEP_RESEARCH_DEPTH_BUDGETS_JSON: (config, value) => {
		try {
			config.deepResearchDepthBudgets = normalizeDeepResearchDepthBudgetPolicy(
				JSON.parse(value),
			);
		} catch {
			config.deepResearchDepthBudgets =
				normalizeDeepResearchDepthBudgetPolicy(undefined);
		}
	},
	DEEP_RESEARCH_PLAN_MODEL: (config, value) => {
		config.deepResearchModels.plan_generation =
			normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_PLAN_REVISION_MODEL: (config, value) => {
		config.deepResearchModels.plan_revision = normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_SOURCE_REVIEW_MODEL: (config, value) => {
		config.deepResearchModels.source_review = normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_RESEARCH_TASK_MODEL: (config, value) => {
		config.deepResearchModels.research_task = normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_SYNTHESIS_MODEL: (config, value) => {
		config.deepResearchModels.synthesis = normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_CITATION_AUDIT_MODEL: (config, value) => {
		config.deepResearchModels.citation_audit =
			normalizeConfiguredModelId(value);
	},
	DEEP_RESEARCH_REPORT_MODEL: (config, value) => {
		config.deepResearchModels.report_writing =
			normalizeConfiguredModelId(value);
	},
	TITLE_GEN_URL: (config, value) => {
		config.titleGenUrl = value;
	},
	TITLE_GEN_MODEL: (config, value) => {
		config.titleGenModel = value;
	},
	TITLE_GEN_SYSTEM_PROMPT_EN: (config, value) => {
		config.titleGenSystemPromptEn = value;
	},
	TITLE_GEN_SYSTEM_PROMPT_HU: (config, value) => {
		config.titleGenSystemPromptHu = value;
	},
	TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN: (config, value) => {
		config.titleGenSystemPromptCodeAppendixEn = value;
	},
	TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU: (config, value) => {
		config.titleGenSystemPromptCodeAppendixHu = value;
	},
	CONTEXT_SUMMARIZER_URL: (config, value) => {
		config.contextSummarizerUrl = value;
	},
	CONTEXT_SUMMARIZER_MODEL: (config, value) => {
		config.contextSummarizerModel = value;
	},
	TEI_EMBEDDER_URL: (config, value) => {
		config.teiEmbedderUrl = value;
	},
	TEI_EMBEDDER_MODEL: (config, value) => {
		config.teiEmbedderModel = value;
	},
	TEI_EMBEDDER_BATCH_SIZE: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.teiEmbedderBatchSize = Math.max(1, parsed);
	},
	TEI_RERANKER_URL: (config, value) => {
		config.teiRerankerUrl = value;
	},
	TEI_RERANKER_MODEL: (config, value) => {
		config.teiRerankerModel = value;
	},
	TEI_RERANKER_MAX_TEXTS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.teiRerankerMaxTexts = Math.max(1, parsed);
	},
	HONCHO_ENABLED: (config, value) => {
		config.honchoEnabled = value === "true";
	},
	HONCHO_CONTEXT_WAIT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.honchoContextWaitMs = Math.max(0, parsed);
	},
	HONCHO_PERSONA_CONTEXT_WAIT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.honchoPersonaContextWaitMs = Math.max(0, parsed);
		}
	},
	HONCHO_OVERVIEW_WAIT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.honchoOverviewWaitMs = Math.max(0, parsed);
		}
	},
	MINERU_API_URL: (config, value) => {
		config.mineruApiUrl = value;
	},
	MINERU_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.mineruTimeoutMs = Math.max(10000, parsed);
		}
	},
	SEARXNG_BASE_URL: (config, value) => {
		config.searxngBaseUrl = value.trim();
	},
	WEB_RESEARCH_SEARXNG_NUM_RESULTS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.webResearchSearxngNumResults = Math.max(1, parsed);
	},
	WEB_RESEARCH_SEARXNG_LANGUAGE: (config, value) => {
		config.webResearchSearxngLanguage = value.trim() || "en";
	},
	WEB_RESEARCH_SEARXNG_SAFESEARCH: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.webResearchSearxngSafesearch = Math.max(0, Math.min(2, parsed));
		}
	},
	WEB_RESEARCH_SEARXNG_CATEGORIES: (config, value) => {
		config.webResearchSearxngCategories = value.trim() || "general";
	},
	WEB_RESEARCH_MAX_SOURCES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.webResearchMaxSources = Math.max(1, parsed);
	},
	WEB_RESEARCH_HIGHLIGHT_CHARS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.webResearchHighlightChars = Math.max(200, parsed);
	},
	WEB_RESEARCH_CONTENT_CHARS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.webResearchContentChars = Math.max(1000, parsed);
	},
	WEB_RESEARCH_FRESHNESS_HOURS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.webResearchFreshnessHours = Math.max(-1, parsed);
	},
	BRAVE_SEARCH_API_KEY: (config, value) => {
		config.braveSearchApiKey = value;
	},
	APP_VERSION_OVERRIDE: (config, value) => {
		config.appVersionOverride = value.trim() || null;
	},
	SYSTEM_PROMPT: (config, value) => {
		config.systemPrompt = normalizeSystemPromptReference(value) ?? "";
	},
	MAX_FILE_UPLOAD_SIZE: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.maxFileUploadSize = Math.max(1048576, parsed);
	},
	REQUEST_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) config.requestTimeoutMs = Math.max(1000, parsed);
	},
	MODEL_TIMEOUT_FAILOVER_ENABLED: (config, value) => {
		config.modelTimeoutFailoverEnabled = value === "true";
	},
	MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.modelTimeoutFailoverTimeoutMs = Math.max(1000, parsed);
		}
	},
	MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: (config, value) => {
		config.modelTimeoutFailoverTargetModel = normalizeConfiguredModelId(value);
	},
	DEFAULT_NEW_USER_MODEL: (config, value) => {
		config.defaultNewUserModel = normalizeConfiguredModelId(value);
	},
	FILE_PRODUCTION_MAX_OUTPUTS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxOutputs = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxSourceJsonBytes = Math.max(1024, parsed);
	},
	FILE_PRODUCTION_MAX_PROJECTION_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxProjectionBytes = Math.max(1024, parsed);
	},
	FILE_PRODUCTION_MAX_PDF_PAGES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxPdfPages = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_TABLE_ROWS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxTableRows = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_TABLE_COLUMNS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxTableColumns = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_CHART_DATA_POINTS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxChartDataPoints = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_CHART_SERIES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxChartSeries = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_IMAGE_COUNT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxImageCount = Math.max(1, parsed);
	},
	FILE_PRODUCTION_MAX_IMAGE_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxImageBytes = Math.max(1024, parsed);
	},
	FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxTotalImageBytes = Math.max(1024, parsed);
	},
	FILE_PRODUCTION_SANDBOX_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionSandboxTimeoutMs = Math.max(1000, parsed);
	},
	FILE_PRODUCTION_RENDERER_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionRendererTimeoutMs = Math.max(1000, parsed);
	},
	FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxOutputFileBytes = Math.max(1024, parsed);
	},
	FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.fileProductionMaxTotalOutputBytes = Math.max(1024, parsed);
	},
	CONTEXT_DIAGNOSTICS_DEBUG: (config, value) => {
		config.contextDiagnosticsDebug = value === "true";
	},
};

export async function refreshConfig(): Promise<void> {
	const rows = await db.select().from(adminConfig);
	const overrides: Record<string, string> = Object.fromEntries(
		rows.map((r) => [r.key, r.value]),
	);
	const hasMaxMessageLengthOverride =
		overrides.MAX_MESSAGE_LENGTH !== undefined;

	const base = buildDefaultConfig();

	for (const key of ADMIN_CONFIG_KEYS) {
		const value = overrides[key];
		if (value === undefined) continue;
		overrideAppliers[key](base, value);
	}

	applyDerivedContextLimitDefaults(base, overrides);
	validateContextLimitTriples(base);
	applyDerivedMaxMessageLengthDefaults(base, overrides);

	if (!hasMaxMessageLengthOverride) {
		base.maxMessageLength = await resolveLowestModelMaxMessageLength(base);
	}

	runtimeConfig = base;
	// Global SYSTEM_PROMPT overrides per-model system prompts
	if (runtimeConfig.systemPrompt) {
		runtimeConfig.model1.systemPrompt = runtimeConfig.systemPrompt;
		runtimeConfig.model2.systemPrompt = runtimeConfig.systemPrompt;
	}
}

export function getConfig(): RuntimeConfig {
	return runtimeConfig;
}

export function getDocumentTokenBudget(): number {
	return runtimeConfig.workingSetDocumentTokenBudget;
}

export function getWorkingSetPromptTokenBudget(): number {
	return runtimeConfig.workingSetPromptTokenBudget;
}

export function getSmallFileThreshold(): number {
	return runtimeConfig.smallFileThresholdChars;
}

export function getMaxFileUploadSize(): number {
	return runtimeConfig.maxFileUploadSize;
}

// Per-model context limit getters

export function getMaxModelContext(modelId?: string): number {
	if (modelId === "model1") return runtimeConfig.model1MaxModelContext;
	if (modelId === "model2") return runtimeConfig.model2MaxModelContext;
	return runtimeConfig.maxModelContext;
}

export function getCompactionUiThreshold(modelId?: string): number {
	if (modelId === "model1") return runtimeConfig.model1CompactionUiThreshold;
	if (modelId === "model2") return runtimeConfig.model2CompactionUiThreshold;
	return runtimeConfig.compactionUiThreshold;
}

export function getTargetConstructedContext(modelId?: string): number {
	if (modelId === "model1") return runtimeConfig.model1TargetConstructedContext;
	if (modelId === "model2") return runtimeConfig.model2TargetConstructedContext;
	return runtimeConfig.targetConstructedContext;
}

export function getMaxMessageLength(modelId?: string): number {
	if (modelId === "model1") return runtimeConfig.model1MaxMessageLength;
	if (modelId === "model2") return runtimeConfig.model2MaxMessageLength;
	return runtimeConfig.maxMessageLength;
}

export function isModelEnabled(
	modelId: ModelId,
	config: RuntimeConfig = runtimeConfig,
): boolean {
	if (modelId === "model1") return true;
	return config.model2Enabled !== false;
}

export function normalizeModelSelection(
	modelId: string | null | undefined,
	config: RuntimeConfig = runtimeConfig,
): ModelId {
	if (modelId === "model2" && config.model2Enabled !== false) {
		return "model2";
	}
	return "model1";
}

export async function normalizeModelSelectionWithProviders(
	modelId: string | null | undefined,
	config: RuntimeConfig = runtimeConfig,
): Promise<ModelId> {
	if (modelId?.startsWith("provider:")) {
		const provider = await getProviderById(modelId.slice("provider:".length));
		if (provider?.enabled) {
			return modelId as ModelId;
		}
	}
	return normalizeModelSelection(modelId, config);
}

export function modelIconUrl(
	iconAssetId: string | null | undefined,
): string | null {
	return iconAssetId
		? `/api/campaign-assets/${encodeURIComponent(iconAssetId)}/content`
		: null;
}

export function getAvailableModels(
	config: RuntimeConfig = runtimeConfig,
): Array<{
	id: ModelId;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
}> {
	const models: Array<{
		id: ModelId;
		displayName: string;
		iconAssetId: string | null;
		iconUrl: string | null;
	}> = [
		{
			id: "model1",
			displayName: config.model1.displayName,
			iconAssetId: config.model1IconAssetId,
			iconUrl: modelIconUrl(config.model1IconAssetId),
		},
	];

	if (config.model2Enabled !== false) {
		models.push({
			id: "model2",
			displayName: config.model2.displayName,
			iconAssetId: config.model2IconAssetId,
			iconUrl: modelIconUrl(config.model2IconAssetId),
		});
	}

	return models;
}

export function getResolvedAdminConfigValues(
	config: RuntimeConfig = runtimeConfig,
): Record<AdminConfigKey, string> {
	return {
		MAX_MESSAGE_LENGTH: String(config.maxMessageLength),
		MAX_MODEL_CONTEXT: String(config.maxModelContext),
		COMPACTION_UI_THRESHOLD: String(config.compactionUiThreshold),
		TARGET_CONSTRUCTED_CONTEXT: String(config.targetConstructedContext),
		MODEL_1_MAX_MODEL_CONTEXT: String(config.model1MaxModelContext),
		MODEL_1_COMPACTION_UI_THRESHOLD: String(config.model1CompactionUiThreshold),
		MODEL_1_TARGET_CONSTRUCTED_CONTEXT: String(
			config.model1TargetConstructedContext,
		),
		MODEL_1_MAX_MESSAGE_LENGTH: String(config.model1MaxMessageLength),
		MODEL_2_MAX_MODEL_CONTEXT: String(config.model2MaxModelContext),
		MODEL_2_COMPACTION_UI_THRESHOLD: String(config.model2CompactionUiThreshold),
		MODEL_2_TARGET_CONSTRUCTED_CONTEXT: String(
			config.model2TargetConstructedContext,
		),
		MODEL_2_MAX_MESSAGE_LENGTH: String(config.model2MaxMessageLength),
		WORKING_SET_DOCUMENT_TOKEN_BUDGET: String(
			config.workingSetDocumentTokenBudget,
		),
		WORKING_SET_PROMPT_TOKEN_BUDGET: String(config.workingSetPromptTokenBudget),
		SMALL_FILE_THRESHOLD_CHARS: String(config.smallFileThresholdChars),
		MODEL_1_BASEURL: config.model1.baseUrl,
		MODEL_1_API_KEY: config.model1.apiKey,
		MODEL_1_NAME: config.model1.modelName,
		MODEL_1_DISPLAY_NAME: config.model1.displayName,
		MODEL_1_ICON_ASSET_ID: config.model1IconAssetId ?? "",
		MODEL_1_SYSTEM_PROMPT: getSystemPrompt(config.model1.systemPrompt),
		MODEL_1_MAX_TOKENS:
			config.model1.maxTokens != null ? String(config.model1.maxTokens) : "",
		MODEL_1_REASONING_EFFORT: config.model1.reasoningEffort ?? "",
		MODEL_1_THINKING_TYPE: config.model1.thinkingType ?? "",
		MODEL_2_BASEURL: config.model2.baseUrl,
		MODEL_2_API_KEY: config.model2.apiKey,
		MODEL_2_NAME: config.model2.modelName,
		MODEL_2_DISPLAY_NAME: config.model2.displayName,
		MODEL_2_ICON_ASSET_ID: config.model2IconAssetId ?? "",
		MODEL_2_SYSTEM_PROMPT: getSystemPrompt(config.model2.systemPrompt),
		MODEL_2_MAX_TOKENS:
			config.model2.maxTokens != null ? String(config.model2.maxTokens) : "",
		MODEL_2_REASONING_EFFORT: config.model2.reasoningEffort ?? "",
		MODEL_2_THINKING_TYPE: config.model2.thinkingType ?? "",
		MODEL_2_ENABLED: String(config.model2Enabled),
		COMPOSER_COMMAND_REGISTRY_ENABLED: String(
			config.composerCommandRegistryEnabled,
		),
		DEEP_RESEARCH_ENABLED: String(config.deepResearchEnabled),
		DEEP_RESEARCH_WORKER_ENABLED: String(config.deepResearchWorkerEnabled),
		DEEP_RESEARCH_WORKER_INTERVAL_MS: String(
			config.deepResearchWorkerIntervalMs,
		),
		DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS: String(
			config.deepResearchWorkerStaleTimeoutMs,
		),
		DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS: String(
			config.deepResearchJobRuntimeLimitMs,
		),
		DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY: String(
			config.deepResearchWorkerGlobalConcurrency,
		),
		DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT: String(
			config.deepResearchActiveConversationLimit,
		),
		DEEP_RESEARCH_ACTIVE_USER_LIMIT: String(config.deepResearchActiveUserLimit),
		DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT: String(
			config.deepResearchActiveGlobalLimit,
		),
		DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY: String(
			config.deepResearchGlobalReasoningConcurrency,
		),
		DEEP_RESEARCH_USER_REASONING_CONCURRENCY: String(
			config.deepResearchUserReasoningConcurrency,
		),
		DEEP_RESEARCH_WORKER_USER_CONCURRENCY: String(
			config.deepResearchWorkerUserConcurrency,
		),
		DEEP_RESEARCH_DEPTH_BUDGETS_JSON: JSON.stringify(
			config.deepResearchDepthBudgets,
		),
		DEEP_RESEARCH_PLAN_MODEL: config.deepResearchModels.plan_generation,
		DEEP_RESEARCH_PLAN_REVISION_MODEL: config.deepResearchModels.plan_revision,
		DEEP_RESEARCH_SOURCE_REVIEW_MODEL: config.deepResearchModels.source_review,
		DEEP_RESEARCH_RESEARCH_TASK_MODEL: config.deepResearchModels.research_task,
		DEEP_RESEARCH_SYNTHESIS_MODEL: config.deepResearchModels.synthesis,
		DEEP_RESEARCH_CITATION_AUDIT_MODEL:
			config.deepResearchModels.citation_audit,
		DEEP_RESEARCH_REPORT_MODEL: config.deepResearchModels.report_writing,
		TITLE_GEN_URL: config.titleGenUrl,
		TITLE_GEN_MODEL: config.titleGenModel,
		TITLE_GEN_SYSTEM_PROMPT_EN: config.titleGenSystemPromptEn,
		TITLE_GEN_SYSTEM_PROMPT_HU: config.titleGenSystemPromptHu,
		TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN:
			config.titleGenSystemPromptCodeAppendixEn,
		TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU:
			config.titleGenSystemPromptCodeAppendixHu,
		CONTEXT_SUMMARIZER_URL: config.contextSummarizerUrl,
		CONTEXT_SUMMARIZER_MODEL: config.contextSummarizerModel,
		TEI_EMBEDDER_URL: config.teiEmbedderUrl,
		TEI_EMBEDDER_MODEL: config.teiEmbedderModel,
		TEI_EMBEDDER_BATCH_SIZE: String(config.teiEmbedderBatchSize),
		TEI_RERANKER_URL: config.teiRerankerUrl,
		TEI_RERANKER_MODEL: config.teiRerankerModel,
		TEI_RERANKER_MAX_TEXTS: String(config.teiRerankerMaxTexts),
		HONCHO_ENABLED: String(config.honchoEnabled),
		HONCHO_CONTEXT_WAIT_MS: String(config.honchoContextWaitMs),
		HONCHO_PERSONA_CONTEXT_WAIT_MS: String(config.honchoPersonaContextWaitMs),
		HONCHO_OVERVIEW_WAIT_MS: String(config.honchoOverviewWaitMs),
		MINERU_API_URL: config.mineruApiUrl,
		MINERU_TIMEOUT_MS: String(config.mineruTimeoutMs),
		SEARXNG_BASE_URL: config.searxngBaseUrl,
		WEB_RESEARCH_SEARXNG_NUM_RESULTS: String(
			config.webResearchSearxngNumResults,
		),
		WEB_RESEARCH_SEARXNG_LANGUAGE: config.webResearchSearxngLanguage,
		WEB_RESEARCH_SEARXNG_SAFESEARCH: String(
			config.webResearchSearxngSafesearch,
		),
		WEB_RESEARCH_SEARXNG_CATEGORIES: config.webResearchSearxngCategories,
		WEB_RESEARCH_MAX_SOURCES: String(config.webResearchMaxSources),
		WEB_RESEARCH_HIGHLIGHT_CHARS: String(config.webResearchHighlightChars),
		WEB_RESEARCH_CONTENT_CHARS: String(config.webResearchContentChars),
		WEB_RESEARCH_FRESHNESS_HOURS: String(config.webResearchFreshnessHours),
		BRAVE_SEARCH_API_KEY: config.braveSearchApiKey,
		APP_VERSION_OVERRIDE: config.appVersionOverride ?? "",
		SYSTEM_PROMPT: getSystemPrompt(config.systemPrompt),
		MAX_FILE_UPLOAD_SIZE: String(config.maxFileUploadSize),
		REQUEST_TIMEOUT_MS: String(config.requestTimeoutMs),
		MODEL_TIMEOUT_FAILOVER_ENABLED: String(config.modelTimeoutFailoverEnabled),
		MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS: String(
			config.modelTimeoutFailoverTimeoutMs,
		),
		MODEL_TIMEOUT_FAILOVER_TARGET_MODEL: config.modelTimeoutFailoverTargetModel,
		DEFAULT_NEW_USER_MODEL: config.defaultNewUserModel,
		FILE_PRODUCTION_MAX_OUTPUTS: String(config.fileProductionMaxOutputs),
		FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES: String(
			config.fileProductionMaxSourceJsonBytes,
		),
		FILE_PRODUCTION_MAX_PROJECTION_BYTES: String(
			config.fileProductionMaxProjectionBytes,
		),
		FILE_PRODUCTION_MAX_PDF_PAGES: String(config.fileProductionMaxPdfPages),
		FILE_PRODUCTION_MAX_TABLE_ROWS: String(config.fileProductionMaxTableRows),
		FILE_PRODUCTION_MAX_TABLE_COLUMNS: String(
			config.fileProductionMaxTableColumns,
		),
		FILE_PRODUCTION_MAX_CHART_DATA_POINTS: String(
			config.fileProductionMaxChartDataPoints,
		),
		FILE_PRODUCTION_MAX_CHART_SERIES: String(
			config.fileProductionMaxChartSeries,
		),
		FILE_PRODUCTION_MAX_IMAGE_COUNT: String(config.fileProductionMaxImageCount),
		FILE_PRODUCTION_MAX_IMAGE_BYTES: String(config.fileProductionMaxImageBytes),
		FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES: String(
			config.fileProductionMaxTotalImageBytes,
		),
		FILE_PRODUCTION_SANDBOX_TIMEOUT_MS: String(
			config.fileProductionSandboxTimeoutMs,
		),
		FILE_PRODUCTION_RENDERER_TIMEOUT_MS: String(
			config.fileProductionRendererTimeoutMs,
		),
		FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES: String(
			config.fileProductionMaxOutputFileBytes,
		),
		FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES: String(
			config.fileProductionMaxTotalOutputBytes,
		),
		CONTEXT_DIAGNOSTICS_DEBUG: String(config.contextDiagnosticsDebug),
	};
}

// Returns the env-var default value for each admin config key (for UI display)
export function getEnvDefaults(): Record<AdminConfigKey, string> {
	return getResolvedAdminConfigValues(buildDefaultConfig());
}

let cachedProviders:
	| import("$lib/server/services/inference-providers").InferenceProvider[]
	| null = null;
let providersLoadTime = 0;
const PROVIDERS_CACHE_TTL_MS = 60000;

export async function getInferenceProviders(): Promise<
	import("$lib/server/services/inference-providers").InferenceProvider[]
> {
	const now = Date.now();
	if (cachedProviders && now - providersLoadTime < PROVIDERS_CACHE_TTL_MS) {
		return cachedProviders;
	}

	const { listProviders } = await import(
		"$lib/server/services/inference-providers"
	);
	cachedProviders = await listProviders();
	providersLoadTime = now;
	return cachedProviders;
}

export async function getEnabledProviders(): Promise<
	import("$lib/server/services/inference-providers").InferenceProvider[]
> {
	const providers = await getInferenceProviders();
	return providers.filter((p) => p.enabled);
}

export async function getProviderById(
	id: string,
): Promise<
	import("$lib/server/services/inference-providers").InferenceProvider | null
> {
	const providers = await getInferenceProviders();
	return providers.find((p) => p.id === id) ?? null;
}

export async function getAvailableModelsWithProviders(): Promise<
	Array<{
		id: ModelId;
		displayName: string;
		isThirdParty: boolean;
		iconAssetId: string | null;
		iconUrl: string | null;
	}>
> {
	const [builtIn, providers, newProviders] = await Promise.all([
		Promise.resolve(getAvailableModels()),
		getEnabledProviders(),
		(async () => {
			try {
				const { listEnabledProviders } = await import(
					"$lib/server/services/providers"
				);
				return listEnabledProviders();
			} catch {
				return [];
			}
		})(),
	]);

	const models = builtIn.map((m) => ({ ...m, isThirdParty: false }));

	for (const provider of providers) {
		models.push({
			id: `provider:${provider.id}` as ModelId,
			displayName: provider.displayName,
			isThirdParty: true,
			iconAssetId: provider.iconAssetId,
			iconUrl: modelIconUrl(provider.iconAssetId),
		});
	}

	for (const provider of newProviders) {
		try {
			const { listEnabledProviderModels: listModels } = await import(
				"$lib/server/services/provider-models"
			);
			const providerModels = await listModels(provider.id);
			for (const model of providerModels) {
				if (model.enabled) {
					models.push({
						id: `provider:${provider.id}:${model.id}` as ModelId,
						displayName: `${provider.displayName} - ${model.displayName}`,
						isThirdParty: true,
						iconAssetId: provider.iconAssetId,
						iconUrl: modelIconUrl(provider.iconAssetId),
					});
				}
			}
		} catch {
			models.push({
				id: `provider:${provider.id}` as ModelId,
				displayName: provider.displayName,
				isThirdParty: true,
				iconAssetId: provider.iconAssetId,
				iconUrl: modelIconUrl(provider.iconAssetId),
			});
		}
	}

	return models;
}

export function clearProvidersCache(): void {
	cachedProviders = null;
	providersLoadTime = 0;
}
