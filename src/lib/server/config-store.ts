// Runtime config store: merges env vars with admin_config DB overrides.
// All services should call getConfig() instead of importing from env.ts directly.

import {
	deriveDefaultCompactionUiThreshold as deriveCompactionUiThreshold,
	deriveDefaultTargetConstructedContext as deriveTargetConstructedContext,
} from "$lib/model-context-defaults";
import { deriveMaxMessageLengthFromContextTokens } from "$lib/model-limit-presets";
import type { ModelId } from "$lib/types";
import { db } from "./db";
import { adminConfig } from "./db/schema";
import type { ModelConfig } from "./env";
import { config as envConfig } from "./env";
import { getSystemPrompt, normalizeSystemPromptReference } from "./prompts";
import {
	getAvailableModelsWithProvidersForSettings,
	projectBuiltInAvailableModels,
	modelIconUrl as projectedModelIconUrl,
} from "./services/available-models";

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
	"MINERU_API_URL",
	"MINERU_TIMEOUT_MS",
	"GOOGLE_OAUTH_CLIENT_ID",
	"GOOGLE_OAUTH_CLIENT_SECRET",
	"ONEDRIVE_CLIENT_ID",
	"ONEDRIVE_CLIENT_SECRET",
	"OWNTRACKS_RECORDER_URL",
	"OWNTRACKS_RECORDER_USER",
	"OWNTRACKS_RECORDER_PASS",
	"PARALLEL_API_KEY",
	"PARALLEL_BASE_URL",
	"BRAVE_SEARCH_API_KEY",
	"APP_VERSION_OVERRIDE",
	"SYSTEM_PROMPT",
	"MAX_FILE_UPLOAD_SIZE",
	"REQUEST_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_ENABLED",
	"MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS",
	"MODEL_TIMEOUT_FAILOVER_TARGET_MODEL",
	"DEFAULT_NEW_USER_MODEL",
	"MEMORY_JUDGE_MODEL",
	"MEMORY_CONSOLIDATION_MODEL",
	"MEMORY_JUDGE_IDLE_MINUTES",
	"MEMORY_CONSOLIDATION_INTERVAL_MINUTES",
	"MEMORY_JUDGE_DRY_RUN",
	"ATLAS_WORKER_ENABLED",
	"ATLAS_GLOBAL_ACTIVE_LIMIT",
	"ATLAS_SEARCH_CONCURRENCY",
	"ATLAS_SEARCH_BATCH_DELAY_MS",
	"ATLAS_SYNTHESIS_MODEL",
	"ATLAS_AUDIT_MODEL",
	"ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS",
	"ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS",
	"ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS",
	"ATLAS_MAX_WRITER_PROMPT_CHARS",
	"WEB_PUSH_VAPID_PUBLIC_KEY",
	"WEB_PUSH_VAPID_PRIVATE_KEY",
	"WEB_PUSH_VAPID_SUBJECT",
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
	"ANALYTICS_EXCLUDED_USER_IDS",
	"CONTEXT_DIAGNOSTICS_DEBUG",
] as const;

export type AdminConfigKey = (typeof ADMIN_CONFIG_KEYS)[number];

export interface RuntimeConfig {
	attachmentTraceDebug: boolean;
	composerCommandRegistryEnabled: boolean;
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
	memoryJudgeModel: ModelId;
	memoryConsolidationModel: ModelId;
	memoryJudgeIdleMinutes: number;
	memoryConsolidationIntervalMinutes: number;
	memoryJudgeDryRun: boolean;
	atlasWorkerEnabled: boolean;
	atlasGlobalActiveLimit: number;
	atlasSearchConcurrency: number;
	atlasSearchBatchDelayMs: number;
	atlasSynthesisModel: ModelId;
	atlasAuditModel: ModelId;
	atlasOverviewMaxOutputTokens: number;
	atlasInDepthMaxOutputTokens: number;
	atlasExhaustiveMaxOutputTokens: number;
	atlasMaxWriterPromptChars: number;
	webPushVapidPublicKey: string;
	webPushVapidPrivateKey: string;
	webPushVapidSubject: string;
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
	memoryMaintenanceIntervalMinutes: number;
	mineruApiUrl: string;
	mineruTimeoutMs: number;
	owntracksRecorderUrl: string;
	owntracksRecorderUser: string;
	owntracksRecorderPass: string;
	parallelApiKey: string;
	parallelBaseUrl: string;
	braveSearchApiKey: string;
	googleOauthClientId: string;
	googleOauthClientSecret: string;
	onedriveClientId: string;
	onedriveClientSecret: string;
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
	analyticsExcludedUserIds: string[];
}

function buildDefaultConfig(): RuntimeConfig {
	return {
		...envConfig,
		model1: { ...envConfig.model1 },
		model2: { ...envConfig.model2 },
		braveSearchApiKey: envConfig.braveSearchApiKey,
		appVersionOverride: null,
		model1IconAssetId: null,
		model2IconAssetId: null,
		memoryJudgeModel: envConfig.memoryJudgeModel,
		memoryConsolidationModel: envConfig.memoryConsolidationModel,
		memoryJudgeIdleMinutes: envConfig.memoryJudgeIdleMinutes,
		memoryConsolidationIntervalMinutes:
			envConfig.memoryConsolidationIntervalMinutes,
		memoryJudgeDryRun: envConfig.memoryJudgeDryRun,
		composerCommandRegistryEnabled:
			envConfig.composerCommandRegistryEnabled ?? true,
		analyticsExcludedUserIds: [],
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
		value === "none" ||
		value === "minimal" ||
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

function normalizeConfiguredModelId(value: unknown): ModelId {
	if (value === "model1" || value === "model2") return value;
	if (typeof value === "string" && value.startsWith("provider:")) {
		return value as ModelId;
	}
	return "model1";
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

	return Math.min(
		...candidates.filter((value): value is number => value != null),
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

function validateConfiguredMemoryModelField(
	config: RuntimeConfig,
	field: "memoryJudgeModel" | "memoryConsolidationModel",
	label: string,
): void {
	const modelId = config[field]?.trim();
	if (!modelId) {
		config[field] = "model1";
		return;
	}

	if (modelId === "model1" || modelId === "model2") {
		if (!isModelEnabled(modelId, config)) {
			console.warn(
				`[CONFIG] ${label} "${modelId}" is not enabled. Falling back to "model1".`,
			);
			config[field] = "model1";
		}
		return;
	}

	if (modelId.startsWith("provider:")) {
		const parts = modelId.split(":");
		if (parts.length === 3 && parts[1] && parts[2]) {
			return;
		}
	}

	console.warn(
		`[CONFIG] Invalid ${label} format: "${modelId}". Expected "model1", "model2", or "provider:<providerId>:<modelId>". Falling back to "model1".`,
	);
	config[field] = "model1";
}

function validateMemoryJudgeAndConsolidationConfig(
	config: RuntimeConfig,
): void {
	validateConfiguredMemoryModelField(
		config,
		"memoryJudgeModel",
		"Memory judge model",
	);
	validateConfiguredMemoryModelField(
		config,
		"memoryConsolidationModel",
		"Memory consolidation model",
	);
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
	MINERU_API_URL: (config, value) => {
		config.mineruApiUrl = value;
	},
	MINERU_TIMEOUT_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined) {
			config.mineruTimeoutMs = Math.max(10000, parsed);
		}
	},
	OWNTRACKS_RECORDER_URL: (config, value) => {
		config.owntracksRecorderUrl = value.trim();
	},
	OWNTRACKS_RECORDER_USER: (config, value) => {
		config.owntracksRecorderUser = value.trim();
	},
	OWNTRACKS_RECORDER_PASS: (config, value) => {
		config.owntracksRecorderPass = value;
	},
	PARALLEL_API_KEY: (config, value) => {
		config.parallelApiKey = value.trim();
	},
	PARALLEL_BASE_URL: (config, value) => {
		config.parallelBaseUrl = value.trim() || "https://api.parallel.ai";
	},
	BRAVE_SEARCH_API_KEY: (config, value) => {
		config.braveSearchApiKey = value;
	},
	GOOGLE_OAUTH_CLIENT_ID: (config, value) => {
		config.googleOauthClientId = value.trim();
	},
	GOOGLE_OAUTH_CLIENT_SECRET: (config, value) => {
		config.googleOauthClientSecret = value.trim();
	},
	ONEDRIVE_CLIENT_ID: (config, value) => {
		config.onedriveClientId = value.trim();
	},
	ONEDRIVE_CLIENT_SECRET: (config, value) => {
		config.onedriveClientSecret = value.trim();
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
	MEMORY_JUDGE_MODEL: (config, value) => {
		config.memoryJudgeModel = normalizeConfiguredModelId(value);
	},
	MEMORY_CONSOLIDATION_MODEL: (config, value) => {
		config.memoryConsolidationModel = normalizeConfiguredModelId(value);
	},
	MEMORY_JUDGE_IDLE_MINUTES: (config, value) => {
		const n = Number.parseInt(value, 10);
		if (Number.isFinite(n) && n > 0) config.memoryJudgeIdleMinutes = n;
	},
	MEMORY_CONSOLIDATION_INTERVAL_MINUTES: (config, value) => {
		const n = Number.parseInt(value, 10);
		if (Number.isFinite(n) && n > 0)
			config.memoryConsolidationIntervalMinutes = n;
	},
	MEMORY_JUDGE_DRY_RUN: (config, value) => {
		config.memoryJudgeDryRun = value.trim().toLowerCase() === "true";
	},
	ATLAS_WORKER_ENABLED: (config, value) => {
		config.atlasWorkerEnabled = value !== "false";
	},
	ATLAS_GLOBAL_ACTIVE_LIMIT: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasGlobalActiveLimit = Math.max(1, parsed);
	},
	ATLAS_SEARCH_CONCURRENCY: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasSearchConcurrency = Math.max(1, parsed);
	},
	ATLAS_SEARCH_BATCH_DELAY_MS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasSearchBatchDelayMs = Math.max(0, parsed);
	},
	ATLAS_SYNTHESIS_MODEL: (config, value) => {
		config.atlasSynthesisModel = normalizeConfiguredModelId(value);
	},
	ATLAS_AUDIT_MODEL: (config, value) => {
		config.atlasAuditModel = normalizeConfiguredModelId(value);
	},
	ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasOverviewMaxOutputTokens = Math.max(1, parsed);
	},
	ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasInDepthMaxOutputTokens = Math.max(1, parsed);
	},
	ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasExhaustiveMaxOutputTokens = Math.max(1, parsed);
	},
	ATLAS_MAX_WRITER_PROMPT_CHARS: (config, value) => {
		const parsed = parseIntOverride(value);
		if (parsed !== undefined)
			config.atlasMaxWriterPromptChars = Math.max(100, parsed);
	},
	WEB_PUSH_VAPID_PUBLIC_KEY: (config, value) => {
		config.webPushVapidPublicKey = value.trim();
	},
	WEB_PUSH_VAPID_PRIVATE_KEY: (config, value) => {
		config.webPushVapidPrivateKey = value.trim();
	},
	WEB_PUSH_VAPID_SUBJECT: (config, value) => {
		config.webPushVapidSubject = value.trim() || "mailto:admin@localhost";
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
	ANALYTICS_EXCLUDED_USER_IDS: (config, value) => {
		try {
			const parsed: unknown = JSON.parse(value);
			if (
				Array.isArray(parsed) &&
				parsed.every((id): id is string => typeof id === "string")
			) {
				config.analyticsExcludedUserIds = parsed.filter((id) => id.length > 0);
			}
		} catch {
			config.analyticsExcludedUserIds = [];
		}
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
	validateMemoryJudgeAndConsolidationConfig(base);

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

export function getAtlasOverviewMaxOutputTokens(): number {
	return runtimeConfig.atlasOverviewMaxOutputTokens;
}

export function getAtlasInDepthMaxOutputTokens(): number {
	return runtimeConfig.atlasInDepthMaxOutputTokens;
}

export function getAtlasExhaustiveMaxOutputTokens(): number {
	return runtimeConfig.atlasExhaustiveMaxOutputTokens;
}

export function getAtlasMaxWriterPromptChars(): number {
	return runtimeConfig.atlasMaxWriterPromptChars;
}

export function getAnalyticsExcludedUserIds(): string[] {
	return [...runtimeConfig.analyticsExcludedUserIds];
}

export function isModelEnabled(
	modelId: ModelId,
	config: RuntimeConfig = runtimeConfig,
): boolean {
	if (modelId === "model1") {
		return !!(config.model1.baseUrl && config.model1.modelName);
	}
	return (
		config.model2Enabled !== false &&
		!!(config.model2.baseUrl && config.model2.modelName)
	);
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
	if (!modelId?.startsWith("provider:")) {
		return normalizeModelSelection(modelId, config);
	}

	const raw = modelId.slice("provider:".length);
	const [providerToken, modelToken] = raw.split(":");
	if (!providerToken) return normalizeModelSelection(null, config);

	try {
		const [
			{ getProviderByName, getProviderWithSecrets },
			{ listEnabledProviderModels },
		] = await Promise.all([
			import("$lib/server/services/providers"),
			import("$lib/server/services/provider-models"),
		]);
		let provider = await getProviderWithSecrets(providerToken).catch(
			() => null,
		);
		if (!provider) {
			const providerByName = await getProviderByName(providerToken).catch(
				() => null,
			);
			if (providerByName) {
				provider = await getProviderWithSecrets(providerByName.id).catch(
					() => null,
				);
			}
		}

		if (!provider?.enabled) return normalizeModelSelection(null, config);

		const models = await listEnabledProviderModels(provider.id).catch(() => []);
		const selectedModel = modelToken
			? models.find((model) => model.id === modelToken)
			: models[0];

		if (!selectedModel) return normalizeModelSelection(null, config);

		return `provider:${provider.id}:${selectedModel.id}` as ModelId;
	} catch {
		return normalizeModelSelection(null, config);
	}
}

export function modelIconUrl(
	iconAssetId: string | null | undefined,
): string | null {
	return projectedModelIconUrl(iconAssetId);
}

export function getAvailableModels(
	config: RuntimeConfig = runtimeConfig,
): Array<{
	id: ModelId;
	displayName: string;
	iconAssetId: string | null;
	iconUrl: string | null;
}> {
	return projectBuiltInAvailableModels(config);
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
		MINERU_API_URL: config.mineruApiUrl,
		MINERU_TIMEOUT_MS: String(config.mineruTimeoutMs),
		OWNTRACKS_RECORDER_URL: config.owntracksRecorderUrl,
		OWNTRACKS_RECORDER_USER: config.owntracksRecorderUser,
		OWNTRACKS_RECORDER_PASS: config.owntracksRecorderPass ? "[set]" : "",
		PARALLEL_API_KEY: config.parallelApiKey,
		PARALLEL_BASE_URL: config.parallelBaseUrl,
		BRAVE_SEARCH_API_KEY: config.braveSearchApiKey,
		GOOGLE_OAUTH_CLIENT_ID: config.googleOauthClientId,
		GOOGLE_OAUTH_CLIENT_SECRET: config.googleOauthClientSecret ? "[set]" : "",
		ONEDRIVE_CLIENT_ID: config.onedriveClientId,
		ONEDRIVE_CLIENT_SECRET: config.onedriveClientSecret ? "[set]" : "",
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
		MEMORY_JUDGE_MODEL: config.memoryJudgeModel,
		MEMORY_CONSOLIDATION_MODEL: config.memoryConsolidationModel,
		MEMORY_JUDGE_IDLE_MINUTES: String(config.memoryJudgeIdleMinutes),
		MEMORY_CONSOLIDATION_INTERVAL_MINUTES: String(
			config.memoryConsolidationIntervalMinutes,
		),
		MEMORY_JUDGE_DRY_RUN: String(config.memoryJudgeDryRun),
		ATLAS_WORKER_ENABLED: String(config.atlasWorkerEnabled),
		ATLAS_GLOBAL_ACTIVE_LIMIT: String(config.atlasGlobalActiveLimit),
		ATLAS_SEARCH_CONCURRENCY: String(config.atlasSearchConcurrency),
		ATLAS_SEARCH_BATCH_DELAY_MS: String(config.atlasSearchBatchDelayMs),
		ATLAS_SYNTHESIS_MODEL: config.atlasSynthesisModel,
		ATLAS_AUDIT_MODEL: config.atlasAuditModel,
		ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS: String(
			config.atlasOverviewMaxOutputTokens,
		),
		ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS: String(
			config.atlasInDepthMaxOutputTokens,
		),
		ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS: String(
			config.atlasExhaustiveMaxOutputTokens,
		),
		ATLAS_MAX_WRITER_PROMPT_CHARS: String(config.atlasMaxWriterPromptChars),
		WEB_PUSH_VAPID_PUBLIC_KEY: config.webPushVapidPublicKey,
		WEB_PUSH_VAPID_PRIVATE_KEY: config.webPushVapidPrivateKey ? "[set]" : "",
		WEB_PUSH_VAPID_SUBJECT: config.webPushVapidSubject,
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
		ANALYTICS_EXCLUDED_USER_IDS: JSON.stringify(
			config.analyticsExcludedUserIds,
		),
		CONTEXT_DIAGNOSTICS_DEBUG: String(config.contextDiagnosticsDebug),
	};
}

// Returns the env-var default value for each admin config key (for UI display)
export function getEnvDefaults(): Record<AdminConfigKey, string> {
	return getResolvedAdminConfigValues(buildDefaultConfig());
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
	return getAvailableModelsWithProvidersForSettings(runtimeConfig);
}
