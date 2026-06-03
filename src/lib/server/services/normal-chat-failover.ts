import type { RuntimeConfig } from "$lib/server/config-store";
import { getConfig } from "$lib/server/config-store";
import type { ModelId } from "$lib/types";
import { getProviderWithSecrets } from "./inference-providers";
import {
	getProviderWithSecrets as getNewProviderWithSecrets,
	decryptApiKey as decryptNewProviderApiKey,
	getProviderByName,
} from "./providers";
import { normalizeOpenAICompatibleBaseUrl } from "./openai-compatible-url";
import type { NormalChatModelRunProvider } from "./normal-chat-model";

type ModelTimeoutLikeError = Error & {
	code?: unknown;
	cause?: unknown;
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
		const provider = await getProviderWithSecrets(
			candidate.slice("provider:".length),
		).catch(() => null);
		if (!provider?.enabled) return null;
	}

	return candidate;
}

function isModelTimeoutErrorInner(error: unknown, seen: Set<unknown>): boolean {
	if (!(error instanceof Error)) return false;
	if (seen.has(error)) return false;
	seen.add(error);

	const code =
		typeof (error as ModelTimeoutLikeError).code === "string"
			? (error as ModelTimeoutLikeError).code.toLowerCase()
			: null;
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
	if (!(error instanceof Error)) return false;

	if (
		"statusCode" in error &&
		(error as { statusCode: unknown }).statusCode === 429
	) {
		return true;
	}

	const message = error.message.toLowerCase();
	return (
		message.includes("429") ||
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("too many requests")
	);
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
	let provider = await getNewProviderWithSecrets(providerId).catch(() => null);

	if (!provider) {
		const byName = await getProviderByName(providerId).catch(() => null);
		if (!byName?.enabled) return null;
		provider = await getNewProviderWithSecrets(byName.id).catch(() => null);
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

	const apiKey = decryptNewProviderApiKey(
		provider.rateLimitFallbackApiKeyEncrypted,
		provider.rateLimitFallbackApiKeyIv,
	);

	return {
		id: provider.id,
		name: provider.name,
		displayName: `${provider.displayName} (rate-limit fallback)`,
		baseUrl: normalizeOpenAICompatibleBaseUrl(baseUrl),
		modelName,
		apiKey,
	};
}
