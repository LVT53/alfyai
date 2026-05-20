import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import {
	decryptApiKey,
	getProviderWithSecrets,
} from "$lib/server/services/inference-providers";
import { buildOpenAICompatibleUrl } from "$lib/server/services/openai-compatible-url";
import { isProviderModelId, type ModelId } from "$lib/types";
import {
	formatDeepResearchDiagnosticsJson,
	isSqliteForeignKeyConstraintError,
} from "./diagnostics";
import {
	type DeepResearchModelRole,
	type ResolvedDeepResearchModel,
	resolveDeepResearchModel,
} from "./model-config";
import type { ResearchTimelineStage } from "./timeline";
import {
	buildResearchUsageRecord,
	getResearchUsageForeignKeyDiagnostics,
	type ResearchProviderUsageSnapshot,
	type ResearchUsageOperation,
	saveResearchUsageRecord,
} from "./usage";

const DEFAULT_DEEP_RESEARCH_MODEL_TIMEOUT_MS = 90_000;

export type DeepResearchModelMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type DeepResearchModelRunResult = {
	content: string;
	modelId: string;
	modelDisplayName: string;
	providerId: string | null;
	providerDisplayName: string | null;
	providerModelName: string | null;
	runtimeMs: number;
	usage: ResearchProviderUsageSnapshot | null;
};

type DeepResearchModelAttempt = {
	modelId: ModelId;
	modelDisplayName: string;
	providerId: string | null;
	providerDisplayName: string | null;
	providerModelName: string | null;
	baseUrl: string;
	model: string;
	apiKey: string;
	maxTokens: number | null;
	includeBuiltInRequestOptions: boolean;
	timeoutMs: number;
	logLabel: string;
};

class DeepResearchModelHttpError extends Error {
	constructor(
		role: DeepResearchModelRole,
		readonly status: number,
	) {
		super(`Deep Research model ${role} failed: ${status}`);
		this.name = "DeepResearchModelHttpError";
	}
}

export async function runDeepResearchModel(input: {
	role: DeepResearchModelRole;
	jobId?: string;
	messages: DeepResearchModelMessage[];
	temperature?: number;
	maxTokens?: number;
	fetchImpl?: typeof fetch;
}): Promise<DeepResearchModelRunResult> {
	const resolved = await resolveDeepResearchModel(input.role);
	const config = getConfig();
	const primaryAttempt = await buildDeepResearchModelAttemptFromResolved(
		resolved,
		config,
	);
	try {
		return await runDeepResearchModelAttempt(input, primaryAttempt);
	} catch (error) {
		if (isRateLimitModelError(error)) {
			const failoverAttempt = await resolveRateLimitFailoverAttempt({
				role: input.role,
				sourceAttempt: primaryAttempt,
				config,
			});
			if (failoverAttempt) {
				console.warn("[DEEP_RESEARCH] LLM role switching to failover model", {
					role: input.role,
					jobId: input.jobId,
					from: primaryAttempt.logLabel,
					to: failoverAttempt.logLabel,
					reason: "rate_limit",
					status: error.status,
				});
				return runDeepResearchModelAttempt(input, failoverAttempt);
			}
		}
		throw error;
	}
}

async function runDeepResearchModelAttempt(
	input: {
		role: DeepResearchModelRole;
		jobId?: string;
		messages: DeepResearchModelMessage[];
		temperature?: number;
		maxTokens?: number;
		fetchImpl?: typeof fetch;
	},
	attempt: DeepResearchModelAttempt,
): Promise<DeepResearchModelRunResult> {
	if (!attempt.baseUrl || !attempt.model) {
		throw new Error(`Deep Research model ${input.role} is not configured`);
	}

	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (attempt.apiKey) headers.Authorization = `Bearer ${attempt.apiKey}`;
	const startedAt = Date.now();
	const body: Record<string, unknown> = {
		model: attempt.model,
		messages: input.messages,
		temperature: input.temperature ?? 0.2,
		max_tokens: input.maxTokens ?? attempt.maxTokens ?? 1800,
	};
	if (attempt.includeBuiltInRequestOptions) {
		body.chat_template_kwargs = { enable_thinking: false };
		body.extra_body = {
			chat_template_kwargs: { enable_thinking: false },
		};
	}
	const response = await (input.fetchImpl ?? fetch)(
		buildOpenAICompatibleUrl(attempt.baseUrl, "/v1/chat/completions"),
		{
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(attempt.timeoutMs),
		},
	);
	if (!response.ok) {
		throw new DeepResearchModelHttpError(input.role, response.status);
	}
	const json = await response.json();
	const content = String(json?.choices?.[0]?.message?.content ?? "").trim();
	return {
		content,
		modelId: attempt.modelId,
		modelDisplayName: attempt.modelDisplayName,
		providerId: attempt.providerId,
		providerDisplayName: attempt.providerDisplayName,
		providerModelName: attempt.providerModelName,
		runtimeMs: Date.now() - startedAt,
		usage: mapUsage(json?.usage),
	};
}

async function buildDeepResearchModelAttemptFromResolved(
	resolved: ResolvedDeepResearchModel,
	config: RuntimeConfig,
): Promise<DeepResearchModelAttempt> {
	const credentials = await resolveModelCredentials(resolved.modelId);
	const baseUrl = resolved.providerBaseUrl ?? credentials.baseUrl;
	const model = resolved.providerModelName ?? credentials.modelName;
	return {
		modelId: resolved.modelId,
		modelDisplayName: resolved.modelDisplayName,
		providerId: resolved.providerId,
		providerDisplayName: resolved.providerDisplayName,
		providerModelName: resolved.providerModelName,
		baseUrl,
		model,
		apiKey: credentials.apiKey,
		maxTokens: resolved.limits.maxTokens,
		includeBuiltInRequestOptions: !resolved.providerId,
		timeoutMs: deepResearchModelTimeoutMs(config.requestTimeoutMs),
		logLabel: buildDeepResearchModelLogLabel({
			modelId: resolved.modelId,
			providerId: resolved.providerId,
			providerModelName: resolved.providerModelName,
		}),
	};
}

async function resolveRateLimitFailoverAttempt(input: {
	role: DeepResearchModelRole;
	sourceAttempt: DeepResearchModelAttempt;
	config: RuntimeConfig;
}): Promise<DeepResearchModelAttempt | null> {
	const providerFallback = await buildProviderRateLimitFailoverAttempt(input);
	if (providerFallback) return providerFallback;
	return buildGlobalRateLimitFailoverAttempt(input);
}

async function buildProviderRateLimitFailoverAttempt(input: {
	sourceAttempt: DeepResearchModelAttempt;
	config: RuntimeConfig;
}): Promise<DeepResearchModelAttempt | null> {
	const providerId = input.sourceAttempt.providerId;
	if (!providerId) return null;
	const provider = await getProviderWithSecrets(providerId).catch(() => null);
	if (!provider?.enabled || provider.rateLimitFallbackEnabled !== true) {
		return null;
	}
	const baseUrl = provider.rateLimitFallbackBaseUrl?.trim();
	const modelName = provider.rateLimitFallbackModelName?.trim();
	if (
		!baseUrl ||
		!modelName ||
		!provider.rateLimitFallbackApiKeyEncrypted ||
		!provider.rateLimitFallbackApiKeyIv
	) {
		return null;
	}
	const apiKey = decryptApiKey(
		provider.rateLimitFallbackApiKeyEncrypted,
		provider.rateLimitFallbackApiKeyIv,
	);
	const modelId = input.sourceAttempt.modelId;
	const providerDisplayName = provider.displayName;
	return {
		modelId,
		modelDisplayName: `${providerDisplayName} (rate-limit fallback)`,
		providerId,
		providerDisplayName,
		providerModelName: modelName,
		baseUrl,
		model: modelName,
		apiKey,
		maxTokens: provider.maxTokens ?? input.sourceAttempt.maxTokens,
		includeBuiltInRequestOptions: false,
		timeoutMs: deepResearchModelTimeoutMs(
			provider.rateLimitFallbackTimeoutMs ?? input.config.requestTimeoutMs,
		),
		logLabel: `provider:${providerId}:${modelName}`,
	};
}

async function buildGlobalRateLimitFailoverAttempt(input: {
	role: DeepResearchModelRole;
	sourceAttempt: DeepResearchModelAttempt;
	config: RuntimeConfig;
}): Promise<DeepResearchModelAttempt | null> {
	if (!input.config.modelTimeoutFailoverEnabled) return null;
	const targetModelId = input.config.modelTimeoutFailoverTargetModel;
	if (!targetModelId || targetModelId === input.sourceAttempt.modelId) {
		return null;
	}
	return buildDeepResearchModelAttemptFromModelId({
		modelId: targetModelId,
		config: input.config,
	});
}

async function buildDeepResearchModelAttemptFromModelId(input: {
	modelId: ModelId;
	config: RuntimeConfig;
}): Promise<DeepResearchModelAttempt | null> {
	if (input.modelId === "model2" && input.config.model2Enabled === false) {
		return null;
	}
	if (isProviderModelId(input.modelId)) {
		const providerId = input.modelId.slice("provider:".length);
		const provider = await getProviderWithSecrets(providerId).catch(() => null);
		if (!provider?.enabled) return null;
		const apiKey =
			provider.apiKeyEncrypted && provider.apiKeyIv
				? decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv)
				: "";
		return {
			modelId: input.modelId,
			modelDisplayName: provider.displayName,
			providerId,
			providerDisplayName: provider.displayName,
			providerModelName: provider.modelName,
			baseUrl: provider.baseUrl,
			model: provider.modelName,
			apiKey,
			maxTokens: provider.maxTokens ?? null,
			includeBuiltInRequestOptions: false,
			timeoutMs: deepResearchModelTimeoutMs(input.config.requestTimeoutMs),
			logLabel: `provider:${providerId}:${provider.modelName}`,
		};
	}

	const modelConfig =
		input.modelId === "model2" ? input.config.model2 : input.config.model1;
	const maxTokens =
		input.modelId === "model2"
			? input.config.model2.maxTokens
			: input.config.model1.maxTokens;
	return {
		modelId: input.modelId,
		modelDisplayName: modelConfig.displayName,
		providerId: null,
		providerDisplayName: null,
		providerModelName: null,
		baseUrl: modelConfig.baseUrl,
		model: modelConfig.modelName,
		apiKey: modelConfig.apiKey,
		maxTokens,
		includeBuiltInRequestOptions: true,
		timeoutMs: deepResearchModelTimeoutMs(input.config.requestTimeoutMs),
		logLabel: input.modelId,
	};
}

function buildDeepResearchModelLogLabel(input: {
	modelId: ModelId;
	providerId: string | null;
	providerModelName: string | null;
}): string {
	if (input.providerId && input.providerModelName) {
		return `provider:${input.providerId}:${input.providerModelName}`;
	}
	return input.modelId;
}

function isRateLimitModelError(
	error: unknown,
): error is DeepResearchModelHttpError {
	return error instanceof DeepResearchModelHttpError && error.status === 429;
}

function deepResearchModelTimeoutMs(configuredTimeoutMs: number): number {
	if (!Number.isFinite(configuredTimeoutMs)) {
		return DEFAULT_DEEP_RESEARCH_MODEL_TIMEOUT_MS;
	}
	return Math.max(
		1_000,
		Math.min(
			Math.floor(configuredTimeoutMs),
			DEFAULT_DEEP_RESEARCH_MODEL_TIMEOUT_MS,
		),
	);
}

export async function tryRunAndRecordDeepResearchModel(input: {
	role: DeepResearchModelRole;
	jobId: string;
	conversationId: string;
	userId: string;
	taskId?: string | null;
	stage: ResearchTimelineStage;
	operation?: ResearchUsageOperation;
	messages: DeepResearchModelMessage[];
	temperature?: number;
	maxTokens?: number;
	occurredAt?: Date;
	fetchImpl?: typeof fetch;
}): Promise<DeepResearchModelRunResult | null> {
	if (process.env.NODE_ENV === "test" && !input.fetchImpl) {
		return null;
	}

	try {
		const result = await runDeepResearchModel({
			role: input.role,
			jobId: input.jobId,
			messages: input.messages,
			temperature: input.temperature,
			maxTokens: input.maxTokens,
			fetchImpl: input.fetchImpl,
		});
		let usageRecord: Awaited<
			ReturnType<typeof buildResearchUsageRecord>
		> | null = null;
		try {
			usageRecord = await buildResearchUsageRecord({
				jobId: input.jobId,
				taskId: input.taskId ?? null,
				conversationId: input.conversationId,
				userId: input.userId,
				stage: input.stage,
				operation: input.operation ?? input.role,
				modelId: result.modelId,
				modelDisplayName: result.modelDisplayName,
				providerId: result.providerId,
				providerDisplayName: result.providerDisplayName,
				providerModelName: result.providerModelName,
				occurredAt: input.occurredAt,
				runtimeMs: result.runtimeMs,
				providerUsage: result.usage,
			});
			await saveResearchUsageRecord(usageRecord);
		} catch (error) {
			const foreignKeyDiagnostics =
				usageRecord && isSqliteForeignKeyConstraintError(error)
					? await getResearchUsageForeignKeyDiagnostics(usageRecord).catch(
							(diagnosticError) => ({
								error:
									diagnosticError instanceof Error
										? diagnosticError.message
										: "unknown diagnostic error",
							}),
						)
					: null;
			console.warn("[DEEP_RESEARCH] Usage record save failed", {
				role: input.role,
				jobId: input.jobId,
				taskId: input.taskId ?? null,
				error: error instanceof Error ? error.message : "unknown error",
				foreignKeyDiagnosticsJson: foreignKeyDiagnostics
					? formatDeepResearchDiagnosticsJson(foreignKeyDiagnostics)
					: null,
			});
		}
		return result;
	} catch (error) {
		console.warn(
			"[DEEP_RESEARCH] LLM role failed; using deterministic fallback",
			{
				role: input.role,
				jobId: input.jobId,
				error: error instanceof Error ? error.message : "unknown error",
			},
		);
		return null;
	}
}

async function resolveModelCredentials(modelId: string): Promise<{
	baseUrl: string;
	modelName: string;
	apiKey: string;
}> {
	const config = getConfig();
	if (modelId === "model2") {
		return {
			baseUrl: config.model2.baseUrl,
			modelName: config.model2.modelName,
			apiKey: config.model2.apiKey,
		};
	}
	if (modelId.startsWith("provider:")) {
		const provider = await getProviderWithSecrets(
			modelId.slice("provider:".length),
		);
		if (!provider) return { baseUrl: "", modelName: "", apiKey: "" };
		return {
			baseUrl: provider.baseUrl,
			modelName: provider.modelName,
			apiKey: decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv),
		};
	}
	return {
		baseUrl: config.model1.baseUrl,
		modelName: config.model1.modelName,
		apiKey: config.model1.apiKey,
	};
}

function mapUsage(value: unknown): ResearchProviderUsageSnapshot | null {
	if (!value || typeof value !== "object") return null;
	const usage = value as Record<string, unknown>;
	return {
		promptTokens: readNumber(usage.prompt_tokens),
		completionTokens: readNumber(usage.completion_tokens),
		totalTokens: readNumber(usage.total_tokens),
		reasoningTokens: readNumber(usage.reasoning_tokens),
		source: "provider",
	};
}

function readNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}
