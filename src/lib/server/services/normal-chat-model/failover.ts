import { canUseProviderModelFallback } from "$lib/model-fallback-compatibility";
import type { RuntimeConfig } from "$lib/server/config-store";
import { getConfig } from "$lib/server/config-store";
import type { ModelId } from "$lib/types";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import {
	getProviderModel,
	listEnabledProviderModels,
} from "../provider-models";
import {
	decryptApiKey,
	getProviderByName,
	getProviderWithSecrets,
} from "../providers";
import type { NormalChatModelRunProvider } from "./index";
import {
	type NormalChatModelRunCompatibilityProvider,
	type OpenAICompatibleProviderErrorClassification,
	resolveOpenAICompatibleProviderAdapterProfile,
} from "./provider-compatibility";

type ModelTimeoutLikeError = Error & {
	code?: unknown;
	cause?: unknown;
};

type ModelRateLimitLikeError = Error & {
	statusCode?: unknown;
	status?: unknown;
	code?: unknown;
	cause?: unknown;
};

type NormalChatFallbackClassificationOptions = {
	provider?: NormalChatModelRunCompatibilityProvider | null;
};

const TIMEOUT_ERROR_NAMES = new Set(["apitimeouterror", "timeouterror"]);

const TIMEOUT_ERROR_CODES = new Set([
	"abort_err_timeout",
	"etimedout",
	"und_err_body_timeout",
	"und_err_headers_timeout",
]);

export function isModelTimeoutError(error: unknown): boolean {
	return isModelTimeoutErrorInner(error, new Set<unknown>());
}

export async function resolveModelTimeoutFailoverTargetModelId(
	modelId?: ModelId | null,
	config: RuntimeConfig = getConfig(),
): Promise<ModelId | null> {
	if (!config.modelTimeoutFailoverEnabled) return null;

	const sourceModelId = modelId ?? "model1";
	const targetModelId = config.modelTimeoutFailoverTargetModel;
	return resolveValidatedModelFailoverTargetModelId(
		sourceModelId,
		targetModelId,
		config,
	);
}

export function resolveModelStreamFirstOutputTimeoutMs(
	modelId?: ModelId | null,
	config: RuntimeConfig = getConfig(),
): number | null {
	const sourceModelId = modelId ?? "model1";
	const failoverTargetModelId = config.modelTimeoutFailoverTargetModel;
	if (
		config.modelTimeoutFailoverEnabled &&
		failoverTargetModelId &&
		failoverTargetModelId !== sourceModelId
	) {
		return Math.min(
			config.requestTimeoutMs,
			Math.max(1000, config.modelTimeoutFailoverTimeoutMs),
		);
	}

	return null;
}

async function resolveValidatedModelFailoverTargetModelId(
	sourceModelId: ModelId,
	candidate: ModelId | null,
	config: RuntimeConfig,
): Promise<ModelId | null> {
	if (!candidate || candidate === sourceModelId) return null;

	if (candidate === "model2" && config.model2Enabled === false) {
		return null;
	}

	if (candidate.startsWith("provider:")) {
		const parsed = parseCompositeProviderModelId(candidate);
		if (!parsed?.providerModelId) return null;
		const provider = await getProviderWithSecrets(parsed.providerId).catch(
			() => null,
		);
		if (!provider?.enabled) return null;
	}

	return candidate;
}

function isModelTimeoutErrorInner(error: unknown, seen: Set<unknown>): boolean {
	if (!(error instanceof Error)) return false;
	if (seen.has(error)) return false;
	seen.add(error);

	const codeValue = (error as ModelTimeoutLikeError).code;
	const code = typeof codeValue === "string" ? codeValue.toLowerCase() : null;
	const name = error.name.toLowerCase();
	const message = error.message.toLowerCase();
	const cause = (error as ModelTimeoutLikeError).cause;
	const causeTimedOut = isModelTimeoutErrorInner(cause, seen);

	if (name === "aborterror") {
		return causeTimedOut || timeoutTextMatches(message) || codeMatches(code);
	}

	return (
		causeTimedOut ||
		TIMEOUT_ERROR_NAMES.has(name) ||
		codeMatches(code) ||
		timeoutTextMatches(message)
	);
}

function codeMatches(code: string | null): boolean {
	return Boolean(code && TIMEOUT_ERROR_CODES.has(code));
}

function timeoutTextMatches(text: string): boolean {
	return (
		text.includes("timed out") ||
		text.includes("timeout") ||
		text.includes("apitimeouterror") ||
		text.includes("readtimeout") ||
		text.includes("read timeout")
	);
}

export function isModelRateLimitError(error: unknown): boolean {
	return isModelRateLimitErrorInner(error, new Set<unknown>());
}

export function isRetryableNormalChatFallbackError(
	error: unknown,
	options: NormalChatFallbackClassificationOptions = {},
): boolean {
	if (isModelTimeoutError(error) || isModelRateLimitError(error)) {
		return true;
	}

	if (
		error instanceof Error &&
		isNonRetryableFallbackMessage(error.message.toLowerCase())
	) {
		return false;
	}

	const adapterClassification = classifyProviderErrorForFallback(
		error,
		options.provider,
	);

	const statusCode = readHttpStatusCode(error);
	if (statusCode !== null) {
		if (statusCode === 401 || statusCode === 403) return false;
		if (statusCode >= 500) return true;
		if (statusCode === 429) return true;
		if (adapterClassification === "retryable") return true;
		return false;
	}

	if (adapterClassification === "retryable") return true;
	if (adapterClassification === "non_retryable") return false;

	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();
	return (
		isRetryableTransportMessage(message) ||
		isRetryableUnavailableMessage(message) ||
		isRetryablePrematureCompletionMessage(message)
	);
}

export async function resolveNormalChatFallbackTargetModelId(
	modelId?: ModelId | null,
	config: RuntimeConfig = getConfig(),
	options?: { skipPerModelFallback?: boolean },
): Promise<ModelId | null> {
	const sourceModelId = modelId ?? "model1";
	const sourceProviderModel =
		await resolveCompositeProviderModelRow(sourceModelId);

	if (
		!options?.skipPerModelFallback &&
		sourceProviderModel?.fallbackProviderModelId
	) {
		const modelSpecificFallback =
			await resolveProviderModelFallbackTargetModelId(
				sourceProviderModel,
				sourceProviderModel.fallbackProviderModelId,
			);
		if (modelSpecificFallback) return modelSpecificFallback;
	}

	if (!config.modelTimeoutFailoverEnabled) return null;

	const globalTarget = config.modelTimeoutFailoverTargetModel;
	if (!globalTarget || globalTarget === sourceModelId) return null;

	return resolveGlobalFallbackTargetModelId({
		sourceModelId,
		sourceProviderModel,
		candidateModelId: globalTarget,
		config,
	});
}

function readHttpStatusCode(error: unknown): number | null {
	if (typeof error !== "object" || error === null) return null;
	const maybe = error as ModelRateLimitLikeError;
	if (typeof maybe.statusCode === "number") return maybe.statusCode;
	if (typeof maybe.status === "number") return maybe.status;
	return null;
}

function classifyProviderErrorForFallback(
	error: unknown,
	provider?: NormalChatModelRunCompatibilityProvider | null,
): OpenAICompatibleProviderErrorClassification {
	if (!provider) return "unknown";
	const payload = readStructuredProviderErrorPayload(error);
	if (!payload) return "unknown";

	try {
		return resolveOpenAICompatibleProviderAdapterProfile(
			provider,
		).classifyProviderError(payload);
	} catch {
		return "unknown";
	}
}

function readStructuredProviderErrorPayload(
	error: unknown,
	seen = new Set<unknown>(),
): Record<string, unknown> | null {
	if (!isRecord(error)) return null;
	if (seen.has(error)) return null;
	seen.add(error);

	if (isRecord(error.data)) return error.data;

	const parsedResponseBody = parseStructuredProviderErrorResponseBody(
		error.responseBody,
	);
	if (parsedResponseBody) return parsedResponseBody;

	return readStructuredProviderErrorPayload(error.cause, seen);
}

function parseStructuredProviderErrorResponseBody(
	responseBody: unknown,
): Record<string, unknown> | null {
	if (typeof responseBody !== "string") return null;
	const trimmed = responseBody.trim();
	if (!trimmed.startsWith("{")) return null;

	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRetryableTransportMessage(message: string): boolean {
	return (
		message.includes("connect") ||
		message.includes("connection") ||
		message.includes("fetch failed") ||
		message.includes("socket hang up") ||
		message.includes("network error") ||
		message.includes("econnreset") ||
		message.includes("econnrefused") ||
		message.includes("eai_again") ||
		message.includes("request timeout") ||
		message.includes("read timeout")
	);
}

function isRetryableUnavailableMessage(message: string): boolean {
	return (
		message.includes("temporarily unavailable") ||
		message.includes("service unavailable") ||
		message.includes("overloaded") ||
		message.includes("overload")
	);
}

function isRetryablePrematureCompletionMessage(message: string): boolean {
	return (
		message.includes("premature") ||
		message.includes("before any output") ||
		message.includes("before usable assistant answer") ||
		message.includes("stream ended unexpectedly") ||
		message.includes("stream closed unexpectedly")
	);
}

function isNonRetryableFallbackMessage(message: string): boolean {
	return (
		message.includes("invalid api key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("prompt") ||
		message.includes("schema") ||
		message.includes("response_format") ||
		message.includes("refusal") ||
		message.includes("abort")
	);
}

function parseCompositeProviderModelId(modelId: string): {
	providerId: string;
	providerModelId: string | null;
} | null {
	if (!modelId.startsWith("provider:")) return null;
	const parts = modelId.split(":");
	if (parts.length < 2) return null;
	return {
		providerId: parts[1] || "",
		providerModelId: parts.length >= 3 ? parts[2] || null : null,
	};
}

async function resolveCompositeProviderModelRow(
	modelId: string,
): Promise<Awaited<ReturnType<typeof getProviderModel>> | null> {
	const parsed = parseCompositeProviderModelId(modelId);
	if (!parsed?.providerId || !parsed.providerModelId) return null;

	const provider = await getProviderWithSecrets(parsed.providerId).catch(
		() => null,
	);
	if (!provider?.enabled) return null;

	const row = await getProviderModel(parsed.providerModelId).catch(() => null);
	if (!row || row.providerId !== provider.id || row.enabled !== true)
		return null;

	return row;
}

async function resolveProviderModelFallbackTargetModelId(
	source: NonNullable<
		Awaited<ReturnType<typeof resolveCompositeProviderModelRow>>
	>,
	fallbackProviderModelId: string,
): Promise<ModelId | null> {
	if (fallbackProviderModelId === source.id) return null;

	const fallback = await getProviderModel(fallbackProviderModelId).catch(
		() => null,
	);
	if (fallback?.enabled !== true) return null;

	const fallbackProvider = await getProviderWithSecrets(
		fallback.providerId,
	).catch(() => null);
	if (!fallbackProvider?.enabled) return null;

	const compatibility = canUseProviderModelFallback(
		{
			capabilitiesJson: source.capabilitiesJson || "{}",
			reasoningEffort: source.reasoningEffort,
			thinkingType: source.thinkingType,
		},
		{
			capabilitiesJson: fallback.capabilitiesJson || "{}",
			reasoningEffort: fallback.reasoningEffort,
			thinkingType: fallback.thinkingType,
		},
	);
	if (!compatibility.compatible) {
		return null;
	}

	return `provider:${fallback.providerId}:${fallback.id}` as ModelId;
}

async function resolveGlobalFallbackTargetModelId(params: {
	sourceModelId: ModelId;
	sourceProviderModel: Awaited<
		ReturnType<typeof resolveCompositeProviderModelRow>
	>;
	candidateModelId: ModelId;
	config: RuntimeConfig;
}): Promise<ModelId | null> {
	const { candidateModelId, config, sourceModelId, sourceProviderModel } =
		params;

	if (candidateModelId.startsWith("provider:")) {
		const parsed = parseCompositeProviderModelId(candidateModelId);
		if (!parsed?.providerModelId) return null;

		const targetProvider = await getProviderWithSecrets(
			parsed.providerId,
		).catch(() => null);
		if (!targetProvider?.enabled) return null;

		if (parsed.providerModelId) {
			const targetRow = await getProviderModel(parsed.providerModelId).catch(
				() => null,
			);
			if (targetRow?.enabled !== true) return null;

			if (sourceProviderModel) {
				const compatibility = canUseProviderModelFallback(
					{
						capabilitiesJson: sourceProviderModel.capabilitiesJson || "{}",
						reasoningEffort: sourceProviderModel.reasoningEffort,
						thinkingType: sourceProviderModel.thinkingType,
					},
					{
						capabilitiesJson: targetRow.capabilitiesJson || "{}",
						reasoningEffort: targetRow.reasoningEffort,
						thinkingType: targetRow.thinkingType,
					},
				);
				if (!compatibility.compatible) return null;
			}

			return `provider:${parsed.providerId}:${targetRow.id}` as ModelId;
		}

		const enabledModels = await listEnabledProviderModels(
			targetProvider.id,
		).catch(() => []);
		if (enabledModels.length === 0) return null;
		return candidateModelId;
	}

	if (candidateModelId === "model2") {
		if (config.model2Enabled === false) return null;
		if (!config.model2?.baseUrl || !config.model2?.modelName) return null;
		return candidateModelId;
	}

	if (candidateModelId === "model1") {
		if (!config.model1?.baseUrl || !config.model1?.modelName) return null;
		return candidateModelId;
	}

	return candidateModelId !== sourceModelId ? candidateModelId : null;
}

function isModelRateLimitErrorInner(
	error: unknown,
	seen: Set<unknown>,
): boolean {
	if (!(error instanceof Error)) return false;
	if (seen.has(error)) return false;
	seen.add(error);

	const maybe = error as ModelRateLimitLikeError;
	if (maybe.statusCode === 429 || maybe.status === 429) {
		return true;
	}

	const code = typeof maybe.code === "string" ? maybe.code.toLowerCase() : "";
	const message = error.message.toLowerCase();
	if (
		code === "rate_limit_exceeded" ||
		message.includes("429") ||
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("too many requests")
	) {
		return true;
	}

	return isModelRateLimitErrorInner(maybe.cause, seen);
}

/**
 * Resolves a rate-limit fallback provider from the new `providers` table.
 *
 * Returns a fully-resolved {@link NormalChatModelRunProvider} ready for model
 * execution, or `null` when the provider has no fallback configured, the
 * fallback fields are incomplete, or the provider itself is disabled.
 */
export async function resolveProviderRateLimitFallback(
	providerId: string,
): Promise<NormalChatModelRunProvider | null> {
	let provider = await getProviderWithSecrets(providerId).catch(() => null);

	if (!provider) {
		const byName = await getProviderByName(providerId).catch(() => null);
		if (!byName?.enabled) return null;
		provider = await getProviderWithSecrets(byName.id).catch(() => null);
	}

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

	return {
		id: provider.id,
		modelId: `provider:${provider.id}:rate-limit-fallback`,
		name: provider.name,
		displayName: `${provider.displayName} (rate-limit fallback)`,
		baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl),
		modelName,
		apiKey,
		requestTimeoutMs: provider.rateLimitFallbackTimeoutMs,
	};
}
