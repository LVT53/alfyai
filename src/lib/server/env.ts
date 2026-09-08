// src/lib/server/env.ts
// Centralized environment configuration module
import type { ModelId } from "$lib/model-types";
import {
	DEFAULT_MAX_MODEL_CONTEXT_TOKENS,
	deriveDefaultCompactionUiThreshold as deriveCompactionUiThreshold,
	deriveDefaultTargetConstructedContext as deriveTargetConstructedContext,
	MIN_MODEL_CONTEXT_TOKENS,
} from "../model-context-defaults";
import { deriveMaxMessageLengthFromContextTokens } from "../model-limit-presets";

export interface ModelConfig {
	baseUrl: string;
	apiKey: string;
	modelName: string;
	displayName: string;
	systemPrompt: string;
	maxTokens: number | null;
	reasoningEffort:
		| "none"
		| "minimal"
		| "low"
		| "medium"
		| "high"
		| "max"
		| "xhigh"
		| null;
	thinkingType: "enabled" | "disabled" | null;
}

interface Config {
	alfyaiApiSigningKey: string;
	attachmentTraceDebug: boolean;
	composerCommandRegistryEnabled: boolean;
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
	model2Enabled: boolean;
	memoryMaintenanceIntervalMinutes: number;
	mineruApiUrl: string;
	mineruTimeoutMs: number;
	// On-box OwnTracks Recorder base URL (e.g. http://127.0.0.1:8083). Admin
	// config only — the user never supplies this (see providers/owntracks.ts)
	// — so, unlike Immich/Plex/Nextcloud's user-pasted serverUrl, this is
	// intentionally NOT run through the SSRF guard (assertPublicHttpsUrl):
	// there is no user-controlled fetch target here to protect against.
	owntracksRecorderUrl: string;
	owntracksRecorderUser: string;
	owntracksRecorderPass: string;
	parallelApiKey: string;
	parallelBaseUrl: string;
	// On-box OpenRouteService (ORS) v2 API base URL for the map_route tool
	// (e.g. http://127.0.0.1:8080/ors). Admin config only — the user never
	// supplies this. Empty => the routing tool degrades to "unavailable" and is
	// not registered. Self-hosted, so nothing leaves the box.
	orsBaseUrl: string;
	// Optional geocoder base URL (Nominatim `/search` JSON API) for resolving
	// place-name strings to coordinates. ORS core ships no geocoder, so this is
	// a separate service. Empty => geocoding degrades ("pass coordinates").
	geocoderBaseUrl: string;
	// Optional label for the region the ORS graph covers (e.g. "Hungary").
	// Shown to the model in the map_route description and in out-of-coverage
	// failures so it can explain the limit instead of calling the tool "down".
	orsCoverageLabel: string;
	// On-demand routing coverage (region manager). See routing/region-manager.ts.
	routingOnDemandEnabled: boolean;
	routingRegionsDir: string;
	routingOrsImage: string;
	routingRegionXmx: string;
	routingRegionPortRange: string;
	routingRegionHostIp: string;
	routingRegionIdleMinutes: number;
	routingRegionMaxPbfMb: number;
	routingGeocoderImportContainer: string;
	routingLegacyRegionId: string;
	// Comma-separated mirror bases tried when Geofabrik cannot serve an
	// extract (Geofabrik's *.osm.pbf endpoints answered 502 for days in
	// September 2026 while its index stayed up).
	routingExtractMirrors: string;
	// Comma-separated Geofabrik ids that are downloaded on start and never
	// stopped by the idle sweep.
	routingResidentRegionIds: string;
	// Public-transport timetables. `regionId=url[|url...][,regionId=...]` — `|`
	// separates the feeds of one region, `,` separates regions. Empty or the
	// literal "catalogue" uses the shipped feed catalogue (gtfs-catalogue.ts),
	// which is national for Hungary, Ireland and the Netherlands. A region with
	// feeds gets a `public-transport` profile built into its ORS container;
	// regions without one keep road routing only.
	routingGtfsFeeds: string;
	// `regionId:feedId[,regionId:feedId...]` dropped from the resolved feed set
	// (`regionId:*` drops a whole region). For feeds an operator may not
	// redistribute — e.g. `hungary:mav-gysev` without MÁV's request form.
	routingGtfsFeedExclude: string;
	// How old a downloaded GTFS feed may get before the region's
	// public-transport graph is rebuilt from a fresh download (nightly window).
	routingGtfsRefreshDays: number;
	// Hard cap on a single GTFS feed download, in MB.
	routingGtfsMaxMb: number;
	// Tile proxy for the inline map_route card (GET /api/map-tiles/[z]/[x]/[y]).
	// There is no self-hosted tile server yet, so this proxies+caches OSM's
	// standard raster tiles. Swapping to a self-hosted server later is a
	// one-line change: point mapTileUpstreamBaseUrl at it instead.
	mapTileUpstreamBaseUrl: string;
	// Contact appended to the tile proxy's User-Agent, per OSM's tile usage
	// policy ("identify with a valid User-Agent... include a way to contact
	// you"), e.g. an email or URL. Empty => the header identifies only the
	// app name.
	mapTileContact: string;
	// Disk cache directory for proxied tiles.
	mapTilesDir: string;
	// Send prior turns as native chat messages (with tool parts) instead of a
	// flattened "Session Context" block. Default on; the flag is the rollback.
	nativeHistoryEnabled: boolean;
	// Log the outbound message shape (roles, part types, token estimates —
	// never content) for each model call. Verification aid; off by default.
	normalChatDebugOutbound: boolean;
	braveSearchApiKey: string;
	googleOauthClientId: string;
	googleOauthClientSecret: string;
	onedriveClientId: string;
	onedriveClientSecret: string;
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

function parseByteSizeLimit(value: string): number {
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
		value === "none" ||
		value === "minimal" ||
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

function validateConfiguredModelIdEnv(
	value: string | undefined,
	key: string,
	fallback: ModelId = "model1",
): ModelId {
	const trimmed = value?.trim();
	if (!trimmed) return fallback;

	if (trimmed === "model1" || trimmed === "model2") {
		return trimmed;
	}

	if (trimmed.startsWith("provider:")) {
		const parts = trimmed.split(":");
		if (parts.length === 3 && parts[1] && parts[2]) {
			return trimmed as ModelId;
		}
	}

	console.warn(
		`[CONFIG] Invalid ${key} format: "${value}". Expected "model1", "model2", or "provider:<providerId>:<modelId>". Using "${fallback}".`,
	);
	return fallback;
}

function normalizeConfiguredModelId(value: unknown): ModelId {
	if (value === "model1" || value === "model2") return value;
	if (typeof value === "string" && value.startsWith("provider:")) {
		return value as ModelId;
	}
	return "model1";
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

// Read and validate environment variables
function readConfig(): Config {
	// Required variables (mocked if missing for local dev/testing)
	const sessionSecret =
		process.env.SESSION_SECRET || "mock-session-secret-for-dev-testing-only";

	const databasePath = getDatabasePath();
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
			parseInt(process.env.TEI_EMBEDDER_BATCH_SIZE || "8", 10) || 8,
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
		memoryJudgeModel: validateConfiguredModelIdEnv(
			process.env.MEMORY_JUDGE_MODEL,
			"MEMORY_JUDGE_MODEL",
		),
		memoryConsolidationModel: validateConfiguredModelIdEnv(
			process.env.MEMORY_CONSOLIDATION_MODEL,
			"MEMORY_CONSOLIDATION_MODEL",
		),
		memoryJudgeIdleMinutes: Math.max(
			1,
			parseIntegerEnv(process.env.MEMORY_JUDGE_IDLE_MINUTES, 30),
		),
		memoryConsolidationIntervalMinutes: Math.max(
			1,
			parseIntegerEnv(process.env.MEMORY_CONSOLIDATION_INTERVAL_MINUTES, 1440),
		),
		memoryJudgeDryRun: process.env.MEMORY_JUDGE_DRY_RUN === "true",
		atlasWorkerEnabled: process.env.ATLAS_WORKER_ENABLED !== "false",
		atlasGlobalActiveLimit: Math.max(
			1,
			parseIntegerEnv(process.env.ATLAS_GLOBAL_ACTIVE_LIMIT, 2),
		),
		atlasSearchConcurrency: Math.max(
			1,
			parseIntegerEnv(process.env.ATLAS_SEARCH_CONCURRENCY, 3),
		),
		atlasSearchBatchDelayMs: Math.max(
			0,
			parseIntegerEnv(process.env.ATLAS_SEARCH_BATCH_DELAY_MS, 500),
		),
		atlasSynthesisModel: validateConfiguredModelIdEnv(
			process.env.ATLAS_SYNTHESIS_MODEL,
			"ATLAS_SYNTHESIS_MODEL",
			"model1",
		),
		atlasAuditModel: validateConfiguredModelIdEnv(
			process.env.ATLAS_AUDIT_MODEL,
			"ATLAS_AUDIT_MODEL",
			"model2",
		),
		atlasOverviewMaxOutputTokens: parsePositiveIntegerEnv(
			process.env.ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS,
			16000,
			1,
		),
		atlasInDepthMaxOutputTokens: parsePositiveIntegerEnv(
			process.env.ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS,
			24000,
			1,
		),
		atlasExhaustiveMaxOutputTokens: parsePositiveIntegerEnv(
			process.env.ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS,
			32000,
			1,
		),
		atlasMaxWriterPromptChars: parsePositiveIntegerEnv(
			process.env.ATLAS_MAX_WRITER_PROMPT_CHARS,
			80000,
			100,
		),
		webPushVapidPublicKey: process.env.WEB_PUSH_VAPID_PUBLIC_KEY || "",
		webPushVapidPrivateKey: process.env.WEB_PUSH_VAPID_PRIVATE_KEY || "",
		webPushVapidSubject:
			process.env.WEB_PUSH_VAPID_SUBJECT || "mailto:admin@localhost",
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
		owntracksRecorderUrl: process.env.OWNTRACKS_RECORDER_URL || "",
		owntracksRecorderUser: process.env.OWNTRACKS_RECORDER_USER || "",
		owntracksRecorderPass: process.env.OWNTRACKS_RECORDER_PASS || "",
		parallelApiKey: process.env.PARALLEL_API_KEY || "",
		parallelBaseUrl: process.env.PARALLEL_BASE_URL || "https://api.parallel.ai",
		orsBaseUrl: process.env.ORS_BASE_URL || "",
		geocoderBaseUrl: process.env.GEOCODER_BASE_URL || "",
		orsCoverageLabel: process.env.ORS_COVERAGE_LABEL || "",
		routingOnDemandEnabled: process.env.ROUTING_ON_DEMAND_ENABLED === "true",
		routingRegionsDir:
			process.env.ROUTING_REGIONS_DIR || "./data/routing-regions",
		routingOrsImage:
			process.env.ROUTING_ORS_IMAGE ||
			"openrouteservice/openrouteservice:latest",
		routingRegionXmx: process.env.ROUTING_REGION_XMX || "12g",
		routingRegionPortRange:
			process.env.ROUTING_REGION_PORT_RANGE || "8300-8399",
		routingRegionHostIp: process.env.ROUTING_REGION_HOST_IP || "127.0.0.1",
		routingRegionIdleMinutes: Math.max(
			5,
			parseInt(process.env.ROUTING_REGION_IDLE_MINUTES || "180", 10) || 180,
		),
		routingRegionMaxPbfMb: Math.max(
			50,
			parseInt(process.env.ROUTING_REGION_MAX_PBF_MB || "2500", 10) || 2500,
		),
		routingGeocoderImportContainer:
			process.env.ROUTING_GEOCODER_IMPORT_CONTAINER || "",
		routingLegacyRegionId: process.env.ROUTING_LEGACY_REGION_ID || "hungary",
		routingExtractMirrors:
			process.env.ROUTING_EXTRACT_MIRRORS ||
			"https://download.openstreetmap.fr/extracts",
		routingResidentRegionIds: process.env.ROUTING_RESIDENT_REGION_IDS || "",
		routingGtfsFeeds: process.env.ROUTING_GTFS_FEEDS || "",
		routingGtfsFeedExclude: process.env.ROUTING_GTFS_FEED_EXCLUDE || "",
		routingGtfsRefreshDays: Math.max(
			1,
			parseInt(process.env.ROUTING_GTFS_REFRESH_DAYS || "7", 10) || 7,
		),
		routingGtfsMaxMb: Math.max(
			10,
			parseInt(process.env.ROUTING_GTFS_MAX_MB || "600", 10) || 600,
		),
		mapTileUpstreamBaseUrl:
			process.env.MAP_TILE_UPSTREAM_BASE_URL ||
			"https://tile.openstreetmap.org",
		mapTileContact: process.env.MAP_TILE_CONTACT || "",
		mapTilesDir: process.env.MAP_TILES_DIR || "./data/map-tiles",
		nativeHistoryEnabled: process.env.NATIVE_HISTORY_ENABLED !== "false",
		normalChatDebugOutbound: process.env.NORMAL_CHAT_DEBUG_OUTBOUND === "1",
		systemPrompt:
			process.env.DEFAULT_SYSTEM_PROMPT || process.env.SYSTEM_PROMPT || "",
		braveSearchApiKey: process.env.BRAVE_SEARCH_API_KEY || "",
		googleOauthClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || "",
		googleOauthClientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET || "",
		onedriveClientId: process.env.ONEDRIVE_CLIENT_ID || "",
		onedriveClientSecret: process.env.ONEDRIVE_CLIENT_SECRET || "",
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

function getConfig(): Config {
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
