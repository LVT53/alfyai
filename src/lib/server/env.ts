// src/lib/server/env.ts
// Centralized environment configuration module
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
	DEEP_RESEARCH_MODEL_ROLES,
	type DeepResearchDepthBudgetPolicy,
	type DeepResearchModelSelections,
	defaultDeepResearchModelSelections,
	normalizeConfiguredModelId,
	normalizeDeepResearchDepthBudgetPolicy,
} from "../deep-research-models";
import { deriveMaxMessageLengthFromContextTokens } from "../model-limit-presets";

export interface ModelConfig {
	baseUrl: string;
	apiKey: string;
	modelName: string;
	displayName: string;
	systemPrompt: string;
	maxTokens: number | null;
	reasoningEffort: "low" | "medium" | "high" | "max" | "xhigh" | null;
	thinkingType: "enabled" | "disabled" | null;
}

interface Config {
	alfyaiApiSigningKey: string;
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
	modelTimeoutFailoverTargetModel: import("$lib/types").ModelId;
	defaultNewUserModel: import("$lib/types").ModelId;
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
	systemPrompt: string;
	perUserStreamLimit: number;
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

export function getDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
	return env.DATABASE_PATH || "./data/chat.db";
}

const DEFAULT_ADAPTER_BODY_SIZE_LIMIT = "100M";
const BYTE_SUFFIX_MULTIPLIERS: Record<string, number> = {
	K: 1024,
	M: 1024 * 1024,
	G: 1024 * 1024 * 1024,
};
const DEFAULT_MAX_MODEL_CONTEXT_TOKENS = 262_144;
const MIN_MODEL_CONTEXT_TOKENS = 1_000;
const COMPACTION_THRESHOLD_RATIO = 0.8;
const TARGET_CONSTRUCTED_CONTEXT_RATIO = 0.9;

export function parseByteSizeLimit(value: string): number {
	const trimmed = value.trim();
	if (/^infinity$/i.test(trimmed)) return Infinity;

	const suffix = trimmed.at(-1)?.toUpperCase() ?? "";
	const multiplier = BYTE_SUFFIX_MULTIPLIERS[suffix] ?? 1;
	const numeric = multiplier === 1 ? trimmed : trimmed.slice(0, -1);
	return Number(numeric) * multiplier;
}

export function getAdapterBodySizeLimitBytes(
	env: NodeJS.ProcessEnv = process.env,
): number {
	return parseByteSizeLimit(
		env.BODY_SIZE_LIMIT || DEFAULT_ADAPTER_BODY_SIZE_LIMIT,
	);
}

function normalizeModelReasoningEffort(
	value: string | undefined,
): ModelConfig["reasoningEffort"] {
	return value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "max" ||
		value === "xhigh"
		? value
		: null;
}

function normalizeModelThinkingType(
	value: string | undefined,
): ModelConfig["thinkingType"] {
	return value === "enabled" || value === "disabled" ? value : null;
}

function parseIntegerEnv(value: string | undefined, fallback: number): number {
	const parsed = parseInt(value ?? "", 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function parsePositiveIntegerEnv(
	value: string | undefined,
	fallback: number,
	minimum = 1,
): number {
	const parsed = parseInt(value ?? "", 10);
	return Math.max(
		minimum,
		Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed,
	);
}

function deriveCompactionUiThreshold(maxModelContext: number): number {
	return Math.max(
		1,
		Math.min(
			maxModelContext - 1,
			Math.floor(maxModelContext * COMPACTION_THRESHOLD_RATIO),
		),
	);
}

function deriveTargetConstructedContext(maxModelContext: number): number {
	return Math.max(
		1,
		Math.min(
			maxModelContext - 1,
			Math.floor(maxModelContext * TARGET_CONSTRUCTED_CONTEXT_RATIO),
		),
	);
}

function readDeepResearchModelSelections(): DeepResearchModelSelections {
	const selections = defaultDeepResearchModelSelections();
	for (const role of DEEP_RESEARCH_MODEL_ROLES) {
		selections[role.id] = normalizeConfiguredModelId(
			process.env[role.configKey],
		);
	}
	return selections;
}

function readDeepResearchDepthBudgets(): DeepResearchDepthBudgetPolicy {
	const rawValue = process.env.DEEP_RESEARCH_DEPTH_BUDGETS_JSON;
	if (!rawValue) return normalizeDeepResearchDepthBudgetPolicy(undefined);
	try {
		return normalizeDeepResearchDepthBudgetPolicy(JSON.parse(rawValue));
	} catch {
		return normalizeDeepResearchDepthBudgetPolicy(undefined);
	}
}

function buildDefaultHonchoIdentityNamespace(
	databasePath: string,
	honchoWorkspace: string,
): string {
	const digest = createHash("sha256")
		.update(`${honchoWorkspace}\0${resolve(databasePath)}`)
		.digest("hex")
		.slice(0, 16);
	return `db_${digest}`;
}

// Read and validate environment variables
function readConfig(): Config {
	// Required variables (mocked if missing for local dev/testing)
	const sessionSecret =
		process.env.SESSION_SECRET || "mock-session-secret-for-dev-testing-only";

	const databasePath = getDatabasePath();
	const honchoWorkspace = process.env.HONCHO_WORKSPACE || "alfyai-prod";
	const model2Enabled = process.env.MODEL_2_ENABLED !== "false";
	const maxModelContext = parsePositiveIntegerEnv(
		process.env.MAX_MODEL_CONTEXT,
		DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
		MIN_MODEL_CONTEXT_TOKENS,
	);
	const compactionUiThreshold =
		process.env.COMPACTION_UI_THRESHOLD !== undefined
			? parsePositiveIntegerEnv(
					process.env.COMPACTION_UI_THRESHOLD,
					deriveCompactionUiThreshold(maxModelContext),
				)
			: deriveCompactionUiThreshold(maxModelContext);
	const targetConstructedContext =
		process.env.TARGET_CONSTRUCTED_CONTEXT !== undefined
			? parsePositiveIntegerEnv(
					process.env.TARGET_CONSTRUCTED_CONTEXT,
					deriveTargetConstructedContext(maxModelContext),
				)
			: deriveTargetConstructedContext(maxModelContext);
	const model1MaxModelContext = parsePositiveIntegerEnv(
		process.env.MODEL_1_MAX_MODEL_CONTEXT ?? process.env.MAX_MODEL_CONTEXT,
		maxModelContext,
		MIN_MODEL_CONTEXT_TOKENS,
	);
	const model1CompactionUiThreshold =
		process.env.MODEL_1_COMPACTION_UI_THRESHOLD !== undefined
			? parsePositiveIntegerEnv(
					process.env.MODEL_1_COMPACTION_UI_THRESHOLD,
					deriveCompactionUiThreshold(model1MaxModelContext),
				)
			: process.env.COMPACTION_UI_THRESHOLD !== undefined
				? compactionUiThreshold
				: deriveCompactionUiThreshold(model1MaxModelContext);
	const model1TargetConstructedContext =
		process.env.MODEL_1_TARGET_CONSTRUCTED_CONTEXT !== undefined
			? parsePositiveIntegerEnv(
					process.env.MODEL_1_TARGET_CONSTRUCTED_CONTEXT,
					deriveTargetConstructedContext(model1MaxModelContext),
				)
			: process.env.TARGET_CONSTRUCTED_CONTEXT !== undefined
				? targetConstructedContext
				: deriveTargetConstructedContext(model1MaxModelContext);
	const model2MaxModelContext = parsePositiveIntegerEnv(
		process.env.MODEL_2_MAX_MODEL_CONTEXT ?? process.env.MAX_MODEL_CONTEXT,
		maxModelContext,
		MIN_MODEL_CONTEXT_TOKENS,
	);
	const model2CompactionUiThreshold =
		process.env.MODEL_2_COMPACTION_UI_THRESHOLD !== undefined
			? parsePositiveIntegerEnv(
					process.env.MODEL_2_COMPACTION_UI_THRESHOLD,
					deriveCompactionUiThreshold(model2MaxModelContext),
				)
			: process.env.COMPACTION_UI_THRESHOLD !== undefined
				? compactionUiThreshold
				: deriveCompactionUiThreshold(model2MaxModelContext);
	const model2TargetConstructedContext =
		process.env.MODEL_2_TARGET_CONSTRUCTED_CONTEXT !== undefined
			? parsePositiveIntegerEnv(
					process.env.MODEL_2_TARGET_CONSTRUCTED_CONTEXT,
					deriveTargetConstructedContext(model2MaxModelContext),
				)
			: process.env.TARGET_CONSTRUCTED_CONTEXT !== undefined
				? targetConstructedContext
				: deriveTargetConstructedContext(model2MaxModelContext);
	const parsedMaxMessageLength = parseInt(
		process.env.MAX_MESSAGE_LENGTH || "",
		10,
	);
	const explicitMaxMessageLength = Number.isNaN(parsedMaxMessageLength)
		? null
		: Math.max(1, parsedMaxMessageLength);
	const model1MaxMessageLength = Math.max(
		1,
		parseInt(process.env.MODEL_1_MAX_MESSAGE_LENGTH || "", 10) ||
			explicitMaxMessageLength ||
			deriveMaxMessageLengthFromContextTokens(model1MaxModelContext),
	);
	const model2MaxMessageLength = Math.max(
		1,
		parseInt(process.env.MODEL_2_MAX_MESSAGE_LENGTH || "", 10) ||
			explicitMaxMessageLength ||
			deriveMaxMessageLengthFromContextTokens(model2MaxModelContext),
	);
	const maxMessageLength =
		explicitMaxMessageLength ??
		Math.min(
			model1MaxMessageLength,
			...(model2Enabled ? [model2MaxMessageLength] : []),
		);

	return {
		alfyaiApiSigningKey: process.env.ALFYAI_API_SIGNING_KEY || "",
		attachmentTraceDebug: process.env.ATTACHMENT_TRACE_DEBUG === "true",
		composerCommandRegistryEnabled:
			process.env.COMPOSER_COMMAND_REGISTRY_ENABLED !== "false",
		deepResearchEnabled: process.env.DEEP_RESEARCH_ENABLED === "true",
		deepResearchWorkerEnabled:
			process.env.DEEP_RESEARCH_WORKER_ENABLED === "true",
		deepResearchWorkerIntervalMs: Math.max(
			1000,
			parseIntegerEnv(process.env.DEEP_RESEARCH_WORKER_INTERVAL_MS, 5000),
		),
		deepResearchWorkerStaleTimeoutMs: Math.max(
			60000,
			parseIntegerEnv(
				process.env.DEEP_RESEARCH_WORKER_STALE_TIMEOUT_MS,
				1800000,
			),
		),
		deepResearchJobRuntimeLimitMs: Math.max(
			60000,
			parseIntegerEnv(process.env.DEEP_RESEARCH_JOB_RUNTIME_LIMIT_MS, 7200000),
		),
		deepResearchWorkerGlobalConcurrency: Math.max(
			0,
			parseIntegerEnv(process.env.DEEP_RESEARCH_WORKER_GLOBAL_CONCURRENCY, 2),
		),
		deepResearchWorkerUserConcurrency: Math.max(
			0,
			parseIntegerEnv(process.env.DEEP_RESEARCH_WORKER_USER_CONCURRENCY, 2),
		),
		deepResearchActiveConversationLimit: Math.max(
			1,
			parseIntegerEnv(process.env.DEEP_RESEARCH_ACTIVE_CONVERSATION_LIMIT, 1),
		),
		deepResearchActiveUserLimit: Math.max(
			0,
			parseIntegerEnv(process.env.DEEP_RESEARCH_ACTIVE_USER_LIMIT, 2),
		),
		deepResearchActiveGlobalLimit: Math.max(
			0,
			parseIntegerEnv(process.env.DEEP_RESEARCH_ACTIVE_GLOBAL_LIMIT, 4),
		),
		deepResearchGlobalReasoningConcurrency: Math.max(
			1,
			parseIntegerEnv(
				process.env.DEEP_RESEARCH_GLOBAL_REASONING_CONCURRENCY,
				4,
			),
		),
		deepResearchUserReasoningConcurrency: Math.max(
			0,
			parseIntegerEnv(process.env.DEEP_RESEARCH_USER_REASONING_CONCURRENCY, 4),
		),
		deepResearchDepthBudgets: readDeepResearchDepthBudgets(),
		deepResearchModels: readDeepResearchModelSelections(),
		contextDiagnosticsDebug: process.env.CONTEXT_DIAGNOSTICS_DEBUG === "true",
		titleGenUrl: process.env.TITLE_GEN_URL || "http://localhost:30001/v1",
		titleGenApiKey: process.env.TITLE_GEN_API_KEY || "",
		titleGenModel: process.env.TITLE_GEN_MODEL || "nemotron-nano",
		titleGenSystemPromptEn: process.env.TITLE_GEN_SYSTEM_PROMPT_EN || "",
		titleGenSystemPromptHu: process.env.TITLE_GEN_SYSTEM_PROMPT_HU || "",
		titleGenSystemPromptCodeAppendixEn:
			process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_EN || "",
		titleGenSystemPromptCodeAppendixHu:
			process.env.TITLE_GEN_SYSTEM_PROMPT_CODE_APPENDIX_HU || "",
		contextSummarizerUrl:
			process.env.CONTEXT_SUMMARIZER_URL || process.env.TITLE_GEN_URL || "",
		contextSummarizerApiKey:
			process.env.CONTEXT_SUMMARIZER_API_KEY ||
			process.env.TITLE_GEN_API_KEY ||
			"",
		contextSummarizerModel:
			process.env.CONTEXT_SUMMARIZER_MODEL || process.env.TITLE_GEN_MODEL || "",
		teiEmbedderUrl: process.env.TEI_EMBEDDER_URL || "",
		teiEmbedderApiKey: process.env.TEI_EMBEDDER_API_KEY || "",
		teiEmbedderModel: process.env.TEI_EMBEDDER_MODEL || "",
		teiEmbedderBatchSize: Math.max(
			1,
			parseInt(process.env.TEI_EMBEDDER_BATCH_SIZE || "32", 10) || 32,
		),
		teiRerankerUrl: process.env.TEI_RERANKER_URL || "",
		teiRerankerApiKey: process.env.TEI_RERANKER_API_KEY || "",
		teiRerankerModel: process.env.TEI_RERANKER_MODEL || "",
		teiRerankerMaxTexts: Math.max(
			1,
			parseInt(process.env.TEI_RERANKER_MAX_TEXTS || "32", 10) || 32,
		),
		teiTimeoutMs: Math.max(
			100,
			parseInt(
				process.env.TEI_TIMEOUT_MS ||
					process.env.REQUEST_TIMEOUT_MS ||
					"300000",
				10,
			) || 300000,
		),
		requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || "300000", 10),
		modelTimeoutFailoverEnabled:
			process.env.MODEL_TIMEOUT_FAILOVER_ENABLED === "true",
		modelTimeoutFailoverTimeoutMs: Math.max(
			1000,
			parseInt(
				process.env.MODEL_TIMEOUT_FAILOVER_TIMEOUT_MS ||
					process.env.REQUEST_TIMEOUT_MS ||
					"60000",
				10,
			) || 60000,
		),
		modelTimeoutFailoverTargetModel: normalizeConfiguredModelId(
			process.env.MODEL_TIMEOUT_FAILOVER_TARGET_MODEL || "model2",
		),
		defaultNewUserModel: normalizeConfiguredModelId(
			process.env.DEFAULT_NEW_USER_MODEL || "model1",
		),
		maxMessageLength,
		maxModelContext,
		compactionUiThreshold,
		targetConstructedContext,
		model1MaxModelContext,
		model1CompactionUiThreshold,
		model1TargetConstructedContext,
		model1MaxMessageLength,
		model2MaxModelContext,
		model2CompactionUiThreshold,
		model2TargetConstructedContext,
		model2MaxMessageLength,
		workingSetDocumentTokenBudget: Math.max(
			100,
			parseInt(process.env.WORKING_SET_DOCUMENT_TOKEN_BUDGET || "4000", 10) ||
				4000,
		),
		workingSetPromptTokenBudget: Math.max(
			1000,
			parseInt(process.env.WORKING_SET_PROMPT_TOKEN_BUDGET || "20000", 10) ||
				20000,
		),
		smallFileThresholdChars: Math.max(
			100,
			parseInt(process.env.SMALL_FILE_THRESHOLD_CHARS || "5000", 10) || 5000,
		),
		sessionSecret,
		databasePath,
		model1: {
			baseUrl: process.env.MODEL_1_BASEURL || "http://localhost:30001/v1",
			apiKey: process.env.MODEL_1_API_KEY || "",
			modelName: process.env.MODEL_1_NAME || "model-1",
			displayName: process.env.MODEL_1_DISPLAY_NAME || "Model 1",
			systemPrompt:
				process.env.SYSTEM_PROMPT || process.env.MODEL_1_SYSTEM_PROMPT || "",
			maxTokens: process.env.MODEL_1_MAX_TOKENS
				? Math.max(1, parseInt(process.env.MODEL_1_MAX_TOKENS, 10) || 1)
				: null,
			reasoningEffort: normalizeModelReasoningEffort(
				process.env.MODEL_1_REASONING_EFFORT,
			),
			thinkingType: normalizeModelThinkingType(
				process.env.MODEL_1_THINKING_TYPE,
			),
		},
		model2: {
			baseUrl: process.env.MODEL_2_BASEURL || "",
			apiKey: process.env.MODEL_2_API_KEY || "",
			modelName: process.env.MODEL_2_NAME || "",
			displayName: process.env.MODEL_2_DISPLAY_NAME || "Model 2",
			systemPrompt:
				process.env.SYSTEM_PROMPT || process.env.MODEL_2_SYSTEM_PROMPT || "",
			maxTokens: process.env.MODEL_2_MAX_TOKENS
				? Math.max(1, parseInt(process.env.MODEL_2_MAX_TOKENS, 10) || 1)
				: null,
			reasoningEffort: normalizeModelReasoningEffort(
				process.env.MODEL_2_REASONING_EFFORT,
			),
			thinkingType: normalizeModelThinkingType(
				process.env.MODEL_2_THINKING_TYPE,
			),
		},
		model2Enabled,
		honchoApiKey: process.env.HONCHO_API_KEY || "",
		honchoBaseUrl: process.env.HONCHO_BASE_URL || "http://localhost:8000",
		honchoWorkspace,
		honchoIdentityNamespace:
			process.env.HONCHO_IDENTITY_NAMESPACE ||
			buildDefaultHonchoIdentityNamespace(databasePath, honchoWorkspace),
		honchoEnabled: process.env.HONCHO_ENABLED === "true",
		honchoContextWaitMs: Math.max(
			0,
			parseInt(process.env.HONCHO_CONTEXT_WAIT_MS || "8000", 10) || 8000,
		),
		honchoPersonaContextWaitMs: Math.max(
			0,
			parseInt(process.env.HONCHO_PERSONA_CONTEXT_WAIT_MS || "8000", 10) ||
				8000,
		),
		honchoOverviewWaitMs: Math.max(
			0,
			parseInt(process.env.HONCHO_OVERVIEW_WAIT_MS || "10000", 10) || 10000,
		),
		memoryMaintenanceIntervalMinutes: Math.max(
			0,
			parseInt(process.env.MEMORY_MAINTENANCE_INTERVAL_MINUTES || "0", 10) || 0,
		),
		mineruApiUrl: process.env.MINERU_API_URL || "http://127.0.0.1:8001",
		mineruTimeoutMs: Math.max(
			10000,
			parseInt(
				process.env.MINERU_TIMEOUT_MS ||
					process.env.REQUEST_TIMEOUT_MS ||
					"300000",
				10,
			) || 300000,
		),
		searxngBaseUrl: process.env.SEARXNG_BASE_URL || "",
		webResearchSearxngNumResults: Math.max(
			1,
			parseInt(process.env.WEB_RESEARCH_SEARXNG_NUM_RESULTS || "12", 10) || 12,
		),
		webResearchSearxngLanguage:
			process.env.WEB_RESEARCH_SEARXNG_LANGUAGE || "en",
		webResearchSearxngSafesearch: Math.max(
			0,
			Math.min(
				2,
				parseIntegerEnv(process.env.WEB_RESEARCH_SEARXNG_SAFESEARCH, 1),
			),
		),
		webResearchSearxngCategories:
			process.env.WEB_RESEARCH_SEARXNG_CATEGORIES || "general",
		webResearchMaxSources: Math.max(
			1,
			parseInt(process.env.WEB_RESEARCH_MAX_SOURCES || "8", 10) || 8,
		),
		webResearchHighlightChars: Math.max(
			200,
			parseInt(process.env.WEB_RESEARCH_HIGHLIGHT_CHARS || "4000", 10) || 4000,
		),
		webResearchContentChars: Math.max(
			1000,
			parseInt(process.env.WEB_RESEARCH_CONTENT_CHARS || "12000", 10) || 12000,
		),
		webResearchFreshnessHours: Math.max(
			-1,
			parseIntegerEnv(process.env.WEB_RESEARCH_FRESHNESS_HOURS, 24),
		),
		systemPrompt:
			process.env.DEFAULT_SYSTEM_PROMPT || process.env.SYSTEM_PROMPT || "",
		braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
		concurrentStreamLimit: Math.max(
			1,
			parseInt(process.env.CONCURRENT_STREAM_LIMIT || "3", 10) || 3,
		),
		perUserStreamLimit: Math.max(
			1,
			parseInt(process.env.PER_USER_STREAM_LIMIT || "1", 10) || 1,
		),
		maxFileUploadSize: Math.max(
			1048576,
			parseInt(process.env.MAX_FILE_UPLOAD_SIZE || "104857600", 10) ||
				104857600,
		),
		fileProductionMaxOutputs: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_OUTPUTS || "5", 10) || 5,
		),
		fileProductionMaxSourceJsonBytes: Math.max(
			1024,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_SOURCE_JSON_BYTES || "2097152",
				10,
			) || 2097152,
		),
		fileProductionMaxProjectionBytes: Math.max(
			1024,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_PROJECTION_BYTES || "1048576",
				10,
			) || 1048576,
		),
		fileProductionMaxPdfPages: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_PDF_PAGES || "250", 10) || 250,
		),
		fileProductionMaxTableRows: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_TABLE_ROWS || "10000", 10) ||
				10000,
		),
		fileProductionMaxTableColumns: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_TABLE_COLUMNS || "50", 10) || 50,
		),
		fileProductionMaxChartDataPoints: Math.max(
			1,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_CHART_DATA_POINTS || "20000",
				10,
			) || 20000,
		),
		fileProductionMaxChartSeries: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_CHART_SERIES || "50", 10) || 50,
		),
		fileProductionMaxImageCount: Math.max(
			1,
			parseInt(process.env.FILE_PRODUCTION_MAX_IMAGE_COUNT || "50", 10) || 50,
		),
		fileProductionMaxImageBytes: Math.max(
			1024,
			parseInt(process.env.FILE_PRODUCTION_MAX_IMAGE_BYTES || "26214400", 10) ||
				26214400,
		),
		fileProductionMaxTotalImageBytes: Math.max(
			1024,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_TOTAL_IMAGE_BYTES || "209715200",
				10,
			) || 209715200,
		),
		fileProductionSandboxTimeoutMs: Math.max(
			1000,
			parseInt(
				process.env.FILE_PRODUCTION_SANDBOX_TIMEOUT_MS || "300000",
				10,
			) || 300000,
		),
		fileProductionRendererTimeoutMs: Math.max(
			1000,
			parseInt(
				process.env.FILE_PRODUCTION_RENDERER_TIMEOUT_MS || "300000",
				10,
			) || 300000,
		),
		fileProductionMaxOutputFileBytes: Math.max(
			1024,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_OUTPUT_FILE_BYTES || "104857600",
				10,
			) || 104857600,
		),
		fileProductionMaxTotalOutputBytes: Math.max(
			1024,
			parseInt(
				process.env.FILE_PRODUCTION_MAX_TOTAL_OUTPUT_BYTES || "262144000",
				10,
			) || 262144000,
		),
	};
}

let cachedConfig: Config | null = null;

export function getConfig(): Config {
	if (!cachedConfig) {
		cachedConfig = readConfig();
	}

	return cachedConfig;
}

export const config: Config = new Proxy({} as Config, {
	get(_target, prop) {
		const resolved = getConfig() as unknown as Record<PropertyKey, unknown>;
		return resolved[prop];
	},
	has(_target, prop) {
		return prop in getConfig();
	},
	ownKeys() {
		return Reflect.ownKeys(getConfig());
	},
	getOwnPropertyDescriptor(_target, prop) {
		const descriptor = Object.getOwnPropertyDescriptor(getConfig(), prop);
		return descriptor ? { ...descriptor, configurable: true } : undefined;
	},
});
