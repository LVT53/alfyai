import type { ModelConfig } from "$lib/server/env";
import type { ThinkingMode } from "$lib/types";

type NormalChatThinkingType = NonNullable<ModelConfig["thinkingType"]>;
type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };
type NormalChatProviderOptions = { [key: string]: JsonValue };

export type NormalChatModelRunCompatibilityProvider = {
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	reasoningEffort?: NonNullable<ModelConfig["reasoningEffort"]>;
	thinkingType?: NormalChatThinkingType;
};

export type OpenAICompatibleProviderFamily =
	| "openai"
	| "deepseek"
	| "mimo"
	| "kimi"
	| "glm"
	| "qwen"
	| "generic";

export type OpenAICompatibleProviderErrorClassification =
	| "retryable"
	| "non_retryable"
	| "unknown";

export type OpenAICompatibleProviderAdapterProfile = {
	family: OpenAICompatibleProviderFamily;
	usesMaxCompletionTokens: boolean;
	replaysReasoningContentForToolCalls: boolean;
	classifyProviderError: (
		error: unknown,
	) => OpenAICompatibleProviderErrorClassification;
	buildProviderOptions: (
		provider: NormalChatModelRunCompatibilityProvider,
		thinkingMode: ThinkingMode | undefined,
	) => NormalChatProviderOptions;
	transformRequestBody: (
		body: Record<string, unknown>,
		provider: NormalChatModelRunCompatibilityProvider,
	) => Record<string, unknown>;
};

type AdapterBehavior = {
	family: OpenAICompatibleProviderFamily;
	usesMaxCompletionTokens?: boolean;
	replaysReasoningContentForToolCalls?: boolean;
	thinkingOptions?: "kimi" | "qwen";
	suppressesToolChoice?: "when-thinking" | "kimi-unsupported-when-thinking";
};

type ProviderAdapterProfileDefinition =
	OpenAICompatibleProviderAdapterProfile & {
		matches: (
			provider: NormalChatModelRunCompatibilityProvider,
			haystack: string,
		) => boolean;
	};

const RETRYABLE_OPENAI_COMPATIBLE_ERROR_TERMS = new Set([
	"internal_server_error",
	"overloaded_error",
	"rate_limit_error",
	"rate_limit_exceeded",
	"read_timeout",
	"request_timeout",
	"server_error",
	"service_unavailable",
	"temporarily_unavailable",
	"timeout",
]);

const NON_RETRYABLE_OPENAI_COMPATIBLE_ERROR_TERMS = new Set([
	"authentication_error",
	"bad_request",
	"content_policy_violation",
	"context_length_exceeded",
	"forbidden",
	"insufficient_quota",
	"invalid_api_key",
	"invalid_request",
	"invalid_request_error",
	"invalid_schema",
	"model_not_found",
	"not_found_error",
	"permission_error",
	"schema_validation_error",
]);

const ADAPTER_PROFILE_DEFINITIONS: ProviderAdapterProfileDefinition[] = [
	createProviderAdapterProfile(
		{
			family: "openai",
			usesMaxCompletionTokens: true,
		},
		(provider) =>
			provider.baseUrl.toLowerCase().includes("api.openai.com") ||
			provider.name.toLowerCase() === "openai" ||
			provider.displayName.toLowerCase() === "openai",
	),
	createProviderAdapterProfile(
		{
			family: "deepseek",
			suppressesToolChoice: "when-thinking",
		},
		(_provider, haystack) =>
			/\bdeepseek\b|deepseek-|api\.deepseek\./.test(haystack),
	),
	createProviderAdapterProfile(
		{
			family: "mimo",
			usesMaxCompletionTokens: true,
			replaysReasoningContentForToolCalls: true,
		},
		(_provider, haystack) =>
			/\bmimo\b|mimo-|xiaomimimo|api\.xiaomimimo\./.test(haystack),
	),
	createProviderAdapterProfile(
		{
			family: "kimi",
			thinkingOptions: "kimi",
			suppressesToolChoice: "kimi-unsupported-when-thinking",
		},
		(_provider, haystack) => /\bkimi\b|kimi-|moonshot/.test(haystack),
	),
	createProviderAdapterProfile(
		{
			family: "glm",
		},
		(_provider, haystack) =>
			/\bglm\b|glm-|bigmodel|zhipu|open\.bigmodel\.cn|z\.ai/.test(haystack),
	),
	createProviderAdapterProfile(
		{
			family: "qwen",
			thinkingOptions: "qwen",
		},
		(_provider, haystack) =>
			/\bqwen\b|qwen-|dashscope|qwencloud|aliyun|alibaba/.test(haystack),
	),
	createProviderAdapterProfile(
		{
			family: "generic",
		},
		() => true,
	),
];

export function resolveOpenAICompatibleProviderAdapterProfile(
	provider: NormalChatModelRunCompatibilityProvider,
): OpenAICompatibleProviderAdapterProfile {
	const haystack = providerCompatibilityHaystack(provider);
	return (
		ADAPTER_PROFILE_DEFINITIONS.find((profile) =>
			profile.matches(provider, haystack),
		) ?? ADAPTER_PROFILE_DEFINITIONS[ADAPTER_PROFILE_DEFINITIONS.length - 1]
	);
}

export function buildNormalChatModelRunCompatibilityProviderOptions(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
): NormalChatProviderOptions {
	return resolveOpenAICompatibleProviderAdapterProfile(
		provider,
	).buildProviderOptions(provider, thinkingMode);
}

export function transformNormalChatModelRunRequestBody(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): Record<string, unknown> {
	return resolveOpenAICompatibleProviderAdapterProfile(
		provider,
	).transformRequestBody(body, provider);
}

export function isMiMoProvider(
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	return (
		resolveOpenAICompatibleProviderAdapterProfile(provider).family === "mimo"
	);
}

function createProviderAdapterProfile(
	behavior: AdapterBehavior,
	matches: ProviderAdapterProfileDefinition["matches"],
): ProviderAdapterProfileDefinition {
	return {
		family: behavior.family,
		usesMaxCompletionTokens: behavior.usesMaxCompletionTokens === true,
		replaysReasoningContentForToolCalls:
			behavior.replaysReasoningContentForToolCalls === true,
		classifyProviderError: classifyOpenAICompatibleProviderError,
		buildProviderOptions: (provider, thinkingMode) =>
			buildProviderOptionsForProfile(provider, thinkingMode, behavior),
		transformRequestBody: (body, provider) =>
			transformRequestBodyForProfile(body, provider, behavior),
		matches,
	};
}

function buildProviderOptionsForProfile(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): NormalChatProviderOptions {
	const options: NormalChatProviderOptions = {};
	const thinkingType = resolveThinkingType(provider, thinkingMode, behavior);

	if (
		thinkingMode !== "off" &&
		provider.reasoningEffort &&
		behavior.thinkingOptions !== "qwen"
	) {
		options.reasoningEffort = provider.reasoningEffort;
	}

	if (thinkingType && behavior.thinkingOptions === "qwen") {
		options.enable_thinking = thinkingType === "enabled";
		if (thinkingType === "enabled") {
			options.preserve_thinking = true;
		}
	} else if (thinkingType) {
		options.thinking =
			behavior.thinkingOptions === "kimi" && thinkingType === "enabled"
				? { type: thinkingType, keep: "all" }
				: { type: thinkingType };
	}

	return options;
}

function transformRequestBodyForProfile(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): Record<string, unknown> {
	const transformed: Record<string, unknown> = {
		...body,
		messages: normalizeAssistantToolCallContent(body.messages),
	};

	if (shouldSuppressToolChoice(transformed, behavior)) {
		delete transformed.tool_choice;
	}
	if (shouldDisableQwenThinkingForToolChoice(transformed, behavior)) {
		transformed.enable_thinking = false;
		delete transformed.preserve_thinking;
	}

	if (
		behavior.usesMaxCompletionTokens === true &&
		transformed.max_tokens !== undefined
	) {
		transformed.max_completion_tokens = transformed.max_tokens;
		delete transformed.max_tokens;
	}

	if (
		isGpt5ReasoningModel(provider.modelName) &&
		transformed.reasoning_effort !== undefined &&
		Array.isArray(transformed.tools) &&
		transformed.tools.length > 0
	) {
		delete transformed.reasoning_effort;
	}

	return transformed;
}

function classifyOpenAICompatibleProviderError(
	payload: unknown,
): OpenAICompatibleProviderErrorClassification {
	const error = readOpenAICompatibleErrorObject(payload);
	if (!error) return "unknown";

	const type = normalizeErrorText(error.type);
	const code = normalizeErrorText(error.code);
	const message = normalizeErrorText(error.message);
	const exactTerms = [type, code].filter((term): term is string =>
		Boolean(term),
	);

	if (
		exactTerms.some((term) =>
			RETRYABLE_OPENAI_COMPATIBLE_ERROR_TERMS.has(term),
		) ||
		isRetryableOpenAICompatibleErrorMessage(message)
	) {
		return "retryable";
	}

	if (
		exactTerms.some((term) =>
			NON_RETRYABLE_OPENAI_COMPATIBLE_ERROR_TERMS.has(term),
		) ||
		isNonRetryableOpenAICompatibleErrorMessage(message)
	) {
		return "non_retryable";
	}

	return "unknown";
}

function readOpenAICompatibleErrorObject(
	payload: unknown,
): Record<string, unknown> | null {
	if (!isRecord(payload)) return null;
	return isRecord(payload.error) ? payload.error : null;
}

function normalizeErrorText(value: unknown): string | null {
	return typeof value === "string" ? value.toLowerCase().trim() : null;
}

function isRetryableOpenAICompatibleErrorMessage(
	message: string | null,
): boolean {
	if (!message) return false;
	return (
		message.includes("429") ||
		message.includes("rate limit") ||
		message.includes("rate_limit") ||
		message.includes("too many requests") ||
		message.includes("temporarily unavailable") ||
		message.includes("service unavailable") ||
		message.includes("overloaded") ||
		message.includes("overload") ||
		message.includes("timed out") ||
		message.includes("timeout") ||
		message.includes("read timeout") ||
		message.includes("internal server error") ||
		message.includes("server error")
	);
}

function isNonRetryableOpenAICompatibleErrorMessage(
	message: string | null,
): boolean {
	if (!message) return false;
	return (
		message.includes("invalid api key") ||
		message.includes("authentication") ||
		message.includes("unauthorized") ||
		message.includes("forbidden") ||
		message.includes("prompt") ||
		message.includes("schema") ||
		message.includes("response_format") ||
		message.includes("refusal") ||
		message.includes("abort") ||
		message.includes("content policy") ||
		message.includes("context length")
	);
}

function providerCompatibilityHaystack(
	provider: NormalChatModelRunCompatibilityProvider,
): string {
	return [
		provider.name,
		provider.displayName,
		provider.baseUrl,
		provider.modelName,
	]
		.join(" ")
		.toLowerCase();
}

function resolveThinkingType(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): NormalChatThinkingType | undefined {
	if (thinkingMode === "off") {
		return provider.thinkingType === "enabled" || behavior.family !== "generic"
			? "disabled"
			: provider.thinkingType;
	}

	if (provider.thinkingType) return provider.thinkingType;
	if (thinkingMode === "on" && behavior.thinkingOptions === "qwen") {
		return "enabled";
	}
	return undefined;
}

function normalizeAssistantToolCallContent(value: unknown): unknown {
	if (!Array.isArray(value)) return value;

	return value.map((message) => {
		if (!isRecord(message)) return message;
		if (message.role !== "assistant") return message;
		if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
			return message;
		}
		if (message.content !== null && message.content !== undefined) {
			return message;
		}

		return {
			...message,
			content: "",
		};
	});
}

function shouldSuppressToolChoice(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): boolean {
	if (!isThinkingEnabled(body)) return false;
	if (behavior.suppressesToolChoice === "when-thinking") {
		return body.tool_choice !== undefined;
	}
	if (behavior.suppressesToolChoice !== "kimi-unsupported-when-thinking") {
		return false;
	}

	return (
		body.tool_choice !== undefined && !isKimiAllowedToolChoice(body.tool_choice)
	);
}

function shouldDisableQwenThinkingForToolChoice(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): boolean {
	return (
		behavior.thinkingOptions === "qwen" &&
		body.enable_thinking === true &&
		isNamedToolChoice(body.tool_choice)
	);
}

function isThinkingEnabled(body: Record<string, unknown>): boolean {
	if (body.enable_thinking === true) return true;
	const thinking = body.thinking;
	return isRecord(thinking) && thinking.type === "enabled";
}

function isKimiAllowedToolChoice(value: unknown): boolean {
	return value === "auto" || value === "none";
}

function isNamedToolChoice(value: unknown): boolean {
	return isRecord(value) && value.type === "function";
}

function isGpt5ReasoningModel(modelName: string): boolean {
	return modelName.startsWith("gpt-5") && !modelName.startsWith("gpt-5-chat");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
