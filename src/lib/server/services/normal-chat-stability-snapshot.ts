import type { RuntimeConfig } from "$lib/server/config-store";
import { getConfig } from "$lib/server/config-store";
import {
	getStreamStats,
	type StreamStats,
} from "$lib/server/services/chat-turn/active-streams";
import {
	getAllMetrics,
	type MaintenanceMetrics,
} from "$lib/server/services/maintenance-metrics";
import { TOOL_TIMEOUTS_MS } from "$lib/server/services/normal-chat-tools/shared";
import {
	listEnabledProviderModels,
	type ProviderModel,
} from "$lib/server/services/provider-models";
import { listProviders, type Provider } from "$lib/server/services/providers";

type StabilityComponentStatus = "ok" | "degraded";

export type NormalChatStabilitySnapshot = {
	generatedAt: string;
	status: StabilityComponentStatus;
	streams: StreamStabilitySnapshot;
	providers: ProviderStabilitySnapshot;
	tools: ToolStabilitySnapshot;
	webGrounding: WebGroundingStabilitySnapshot;
	context: ContextStabilitySnapshot;
	maintenance: MaintenanceStabilitySnapshot;
};

export type StreamStabilitySnapshot = {
	status: StabilityComponentStatus;
	activeCount: number;
	activeUserCount: number;
	largestUserActiveCount: number;
	maxGlobal: number;
	maxPerUser: number;
	globalSaturated: boolean;
	perUserSaturated: boolean;
};

export type ProviderStabilitySnapshot = {
	status: StabilityComponentStatus;
	builtinConfiguredCount: number;
	model2Enabled: boolean;
	enabledCustomProviderCount: number;
	enabledCustomProviderModelCount: number;
	enabledProvidersWithoutModels: number;
	rateLimitFallbackEnabledCount: number;
	requestTimeoutMs: number;
	timeoutFailoverEnabled: boolean;
	timeoutFailoverTargetModel: string;
	timeoutFailoverTimeoutMs: number;
	readable: boolean;
	errorCode: string | null;
};

export type ToolStabilitySnapshot = {
	status: StabilityComponentStatus;
	toolTimeoutsMs: Record<string, number>;
	allToolTimeoutsConfigured: boolean;
	fileProduction: {
		maxOutputs: number;
		sandboxTimeoutMs: number;
		rendererTimeoutMs: number;
		maxOutputFileBytes: number;
	};
	imageSearchConfigured: boolean;
	memoryContextAvailable: boolean;
};

export type WebGroundingStabilitySnapshot = {
	status: StabilityComponentStatus;
	parallelConfigured: boolean;
	degradedReason: string | null;
};

export type ContextStabilitySnapshot = {
	status: StabilityComponentStatus;
	global: ContextLimitSnapshot;
	model1: ContextLimitSnapshot;
	model2: ContextLimitSnapshot & { enabled: boolean };
	providerModels: ProviderModelContextStabilitySnapshot;
	maxMessageLength: number;
};

export type ProviderModelContextStabilitySnapshot = {
	enabledModelCount: number;
	invalidContextLimitCount: number;
	valid: boolean;
};

export type ContextLimitSnapshot = {
	maxModelContext: number;
	compactionUiThreshold: number;
	targetConstructedContext: number;
	valid: boolean;
};

export type MaintenanceStabilitySnapshot = {
	status: StabilityComponentStatus;
	trackedUserCount: number;
	stepCount: number;
	failedStepCount: number;
	lastRunAt: string | null;
	lastFailureAt: string | null;
};

export type NormalChatStabilitySnapshotDeps = {
	now?: () => Date;
	getConfig?: () => RuntimeConfig;
	getStreamStats?: () => StreamStats;
	listProviders?: () => Promise<Provider[]>;
	listEnabledProviderModels?: typeof listEnabledProviderModels;
	getAllMetrics?: () => MaintenanceMetrics[];
};

type ProviderStabilityInputs = {
	providers: Provider[];
	enabledModelRows: ProviderModel[];
	readable: boolean;
	errorCode: string | null;
};

export async function getNormalChatStabilitySnapshot(
	deps: NormalChatStabilitySnapshotDeps = {},
): Promise<NormalChatStabilitySnapshot> {
	const now = deps.now?.() ?? new Date();
	const config = deps.getConfig?.() ?? getConfig();
	const streams = buildStreamSnapshot(
		deps.getStreamStats?.() ?? getStreamStats(),
	);
	const providerInputs = await readProviderStabilityInputs({
		listProviders: deps.listProviders ?? listProviders,
		listEnabledProviderModels:
			deps.listEnabledProviderModels ?? listEnabledProviderModels,
	});
	const providers = buildProviderSnapshot({
		config,
		...providerInputs,
	});
	const tools = buildToolSnapshot(config);
	const webGrounding = buildWebGroundingSnapshot(config);
	const context = buildContextSnapshot(
		config,
		selectEnabledProviderModelRows(providerInputs),
	);
	const maintenance = buildMaintenanceSnapshot(
		deps.getAllMetrics?.() ?? getAllMetrics(),
	);
	const status = [
		streams,
		providers,
		tools,
		webGrounding,
		context,
		maintenance,
	].some((component) => component.status === "degraded")
		? "degraded"
		: "ok";

	return {
		generatedAt: now.toISOString(),
		status,
		streams,
		providers,
		tools,
		webGrounding,
		context,
		maintenance,
	};
}

async function readProviderStabilityInputs(params: {
	listProviders: () => Promise<Provider[]>;
	listEnabledProviderModels: typeof listEnabledProviderModels;
}): Promise<ProviderStabilityInputs> {
	try {
		const [providers, enabledModelRows] = await Promise.all([
			params.listProviders(),
			params.listEnabledProviderModels(),
		]);
		return {
			providers,
			enabledModelRows,
			readable: true,
			errorCode: null,
		};
	} catch {
		return {
			providers: [],
			enabledModelRows: [],
			readable: false,
			errorCode: "provider_read_failed",
		};
	}
}

function buildStreamSnapshot(stats: StreamStats): StreamStabilitySnapshot {
	const perUserCounts = [...stats.perUserCounts.values()];
	const largestUserActiveCount = perUserCounts.length
		? Math.max(...perUserCounts)
		: 0;
	const globalSaturated = stats.globalActiveCount >= stats.maxGlobal;
	const perUserSaturated = largestUserActiveCount >= stats.maxPerUser;

	return {
		status: globalSaturated || perUserSaturated ? "degraded" : "ok",
		activeCount: stats.globalActiveCount,
		activeUserCount: perUserCounts.length,
		largestUserActiveCount,
		maxGlobal: stats.maxGlobal,
		maxPerUser: stats.maxPerUser,
		globalSaturated,
		perUserSaturated,
	};
}

function buildProviderSnapshot(
	params: {
		config: RuntimeConfig;
	} & ProviderStabilityInputs,
): ProviderStabilitySnapshot {
	const enabledProviders = params.providers.filter(
		(provider) => provider.enabled,
	);
	const selectableEnabledModelRows = selectEnabledProviderModelRows(params);
	const enabledProviderIdsWithModels = new Set(
		selectableEnabledModelRows.map((model) => model.providerId),
	);
	const builtinConfiguredCount =
		(isBuiltinModelConfigured(params.config.model1) ? 1 : 0) +
		(params.config.model2Enabled &&
		isBuiltinModelConfigured(params.config.model2)
			? 1
			: 0);
	const enabledCustomProviderModelCount = selectableEnabledModelRows.length;
	const hasModelCapacity =
		builtinConfiguredCount + enabledCustomProviderModelCount > 0;
	const enabledProvidersWithoutModels = enabledProviders.filter(
		(provider) => !enabledProviderIdsWithModels.has(provider.id),
	).length;

	return {
		status: params.readable && hasModelCapacity ? "ok" : "degraded",
		builtinConfiguredCount,
		model2Enabled: params.config.model2Enabled,
		enabledCustomProviderCount: enabledProviders.length,
		enabledCustomProviderModelCount,
		enabledProvidersWithoutModels,
		rateLimitFallbackEnabledCount: params.providers.filter(
			(provider) => provider.enabled && provider.rateLimitFallbackEnabled,
		).length,
		requestTimeoutMs: params.config.requestTimeoutMs,
		timeoutFailoverEnabled: params.config.modelTimeoutFailoverEnabled,
		timeoutFailoverTargetModel: params.config.modelTimeoutFailoverTargetModel,
		timeoutFailoverTimeoutMs: params.config.modelTimeoutFailoverTimeoutMs,
		readable: params.readable,
		errorCode: params.errorCode,
	};
}

function selectEnabledProviderModelRows(
	input: ProviderStabilityInputs,
): ProviderModel[] {
	const enabledProviderIds = new Set(
		input.providers
			.filter((provider) => provider.enabled)
			.map((provider) => provider.id),
	);
	return input.enabledModelRows.filter((model) =>
		enabledProviderIds.has(model.providerId),
	);
}

function isBuiltinModelConfigured(model: RuntimeConfig["model1"]): boolean {
	return Boolean(model.baseUrl.trim() && model.modelName.trim());
}

function buildToolSnapshot(config: RuntimeConfig): ToolStabilitySnapshot {
	const allToolTimeoutsConfigured = Object.values(TOOL_TIMEOUTS_MS).every(
		(timeoutMs) => Number.isFinite(timeoutMs) && timeoutMs > 0,
	);
	const fileProductionReady =
		config.fileProductionMaxOutputs > 0 &&
		config.fileProductionSandboxTimeoutMs > 0 &&
		config.fileProductionRendererTimeoutMs > 0 &&
		config.fileProductionMaxOutputFileBytes > 0;

	return {
		status:
			allToolTimeoutsConfigured && fileProductionReady ? "ok" : "degraded",
		toolTimeoutsMs: { ...TOOL_TIMEOUTS_MS },
		allToolTimeoutsConfigured,
		fileProduction: {
			maxOutputs: config.fileProductionMaxOutputs,
			sandboxTimeoutMs: config.fileProductionSandboxTimeoutMs,
			rendererTimeoutMs: config.fileProductionRendererTimeoutMs,
			maxOutputFileBytes: config.fileProductionMaxOutputFileBytes,
		},
		imageSearchConfigured: Boolean(config.braveSearchApiKey.trim()),
		memoryContextAvailable: true,
	};
}

function buildWebGroundingSnapshot(
	config: RuntimeConfig,
): WebGroundingStabilitySnapshot {
	const parallelConfigured = Boolean(config.parallelApiKey.trim());
	return {
		status: parallelConfigured ? "ok" : "degraded",
		parallelConfigured,
		degradedReason: parallelConfigured ? null : "parallel_not_configured",
	};
}

function buildContextSnapshot(
	config: RuntimeConfig,
	enabledProviderModels: ProviderModel[],
): ContextStabilitySnapshot {
	const global = contextLimits({
		maxModelContext: config.maxModelContext,
		compactionUiThreshold: config.compactionUiThreshold,
		targetConstructedContext: config.targetConstructedContext,
	});
	const model1 = contextLimits({
		maxModelContext: config.model1MaxModelContext,
		compactionUiThreshold: config.model1CompactionUiThreshold,
		targetConstructedContext: config.model1TargetConstructedContext,
	});
	const model2 = {
		...contextLimits({
			maxModelContext: config.model2MaxModelContext,
			compactionUiThreshold: config.model2CompactionUiThreshold,
			targetConstructedContext: config.model2TargetConstructedContext,
		}),
		enabled: config.model2Enabled,
	};
	const providerModels = providerModelContextSnapshot(enabledProviderModels);

	return {
		status:
			[global, model1, model2].every((limits) => limits.valid) &&
			providerModels.valid
				? "ok"
				: "degraded",
		global,
		model1,
		model2,
		providerModels,
		maxMessageLength: config.maxMessageLength,
	};
}

function contextLimits(input: Omit<ContextLimitSnapshot, "valid">) {
	return {
		...input,
		valid:
			input.maxModelContext > 0 &&
			input.compactionUiThreshold > 0 &&
			input.targetConstructedContext > 0 &&
			input.compactionUiThreshold < input.maxModelContext &&
			input.targetConstructedContext < input.maxModelContext,
	};
}

function providerModelContextSnapshot(
	models: ProviderModel[],
): ProviderModelContextStabilitySnapshot {
	const invalidContextLimitCount = models.filter(
		(model) => !providerModelContextLimitsValid(model),
	).length;
	return {
		enabledModelCount: models.length,
		invalidContextLimitCount,
		valid: invalidContextLimitCount === 0,
	};
}

function providerModelContextLimitsValid(model: ProviderModel): boolean {
	const values = [
		model.maxModelContext,
		model.compactionUiThreshold,
		model.targetConstructedContext,
	].filter((value): value is number => value !== null && value !== undefined);
	if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
		return false;
	}
	if (model.maxModelContext === null || model.maxModelContext === undefined) {
		return true;
	}
	return (
		(model.compactionUiThreshold === null ||
			model.compactionUiThreshold === undefined ||
			model.compactionUiThreshold < model.maxModelContext) &&
		(model.targetConstructedContext === null ||
			model.targetConstructedContext === undefined ||
			model.targetConstructedContext < model.maxModelContext)
	);
}

function buildMaintenanceSnapshot(
	metrics: MaintenanceMetrics[],
): MaintenanceStabilitySnapshot {
	const steps = metrics.flatMap((entry) => Object.values(entry.steps));
	const failedSteps = steps.filter((step) => Boolean(step.lastError));
	const lastRunAt = maxTimestamp(
		steps.map((step) => step.lastRunAt).filter(isNumber),
	);
	const lastFailureAt = maxTimestamp(
		failedSteps.map((step) => step.lastRunAt).filter(isNumber),
	);

	return {
		status: failedSteps.length > 0 ? "degraded" : "ok",
		trackedUserCount: metrics.length,
		stepCount: steps.length,
		failedStepCount: failedSteps.length,
		lastRunAt: lastRunAt === null ? null : new Date(lastRunAt).toISOString(),
		lastFailureAt:
			lastFailureAt === null ? null : new Date(lastFailureAt).toISOString(),
	};
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function maxTimestamp(values: number[]): number | null {
	if (values.length === 0) return null;
	return Math.max(...values);
}
