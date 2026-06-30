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
	modelAliases?: string[];
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
	| "mistral"
	| "nvidia_nemotron"
	| "minimax"
	| "gemma"
	| "gpt_oss"
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
	thinkingOptions?: "kimi" | "qwen" | "none" | "minimax";
	toolChoicePolicy?:
		| "auto-only"
		| "deepseek-legacy-reasoner-when-thinking"
		| "kimi-unsupported-when-thinking";
	addsGlmToolStream?: boolean;
	addsReasoningSplit?: boolean;
	usesChatTemplateThinking?: boolean;
};

type ProviderAdapterProfileDefinition =
	OpenAICompatibleProviderAdapterProfile & {
		matchesStrong: (signals: ProviderCompatibilitySignals) => boolean;
		matchesWeak: (signals: ProviderCompatibilitySignals) => boolean;
	};

type ProviderFamilyRegistryEntry = {
	behavior: AdapterBehavior;
	modelPatterns?: RegExp[];
	weakPatterns?: RegExp[];
};

type ProviderCompatibilitySignals = {
	modelIds: string[];
	weakHaystack: string;
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

const RETRYABLE_OPENAI_COMPATIBLE_ERROR_MESSAGE_TERMS = [
	"429",
	"rate limit",
	"rate_limit",
	"too many requests",
	"temporarily unavailable",
	"service unavailable",
	"overloaded",
	"overload",
	"timed out",
	"timeout",
	"read timeout",
	"internal server error",
	"server error",
];

const NON_RETRYABLE_OPENAI_COMPATIBLE_ERROR_MESSAGE_TERMS = [
	"invalid api key",
	"authentication",
	"unauthorized",
	"forbidden",
	"prompt",
	"schema",
	"response_format",
	"refusal",
	"abort",
	"content policy",
	"context length",
];

const PROVIDER_FAMILY_REGISTRY: ProviderFamilyRegistryEntry[] = [
	{
		behavior: {
			family: "openai",
			usesMaxCompletionTokens: true,
		},
		weakPatterns: [/(?:^|\s)openai(?:\s|$)/, /api\.openai\.com/],
	},
	{
		behavior: {
			family: "deepseek",
			toolChoicePolicy: "deepseek-legacy-reasoner-when-thinking",
		},
		modelPatterns: [
			/^deepseek-v4-(?:flash|pro)$/,
			/^deepseek[-_]/,
			/\bdeepseek\b/,
		],
		weakPatterns: [/\bdeepseek\b/, /api\.deepseek\./],
	},
	{
		behavior: {
			family: "mimo",
			usesMaxCompletionTokens: true,
			replaysReasoningContentForToolCalls: true,
			toolChoicePolicy: "auto-only",
		},
		modelPatterns: [/^mimo-v2(?:\.5)?(?:-[a-z0-9]+)*$/],
		weakPatterns: [/\bmimo\b/, /xiaomimimo/, /api\.xiaomimimo\./],
	},
	{
		behavior: {
			family: "kimi",
			usesMaxCompletionTokens: true,
			thinkingOptions: "kimi",
			toolChoicePolicy: "kimi-unsupported-when-thinking",
		},
		modelPatterns: [/^kimi(?:\/|[-_])/, /\bkimi-k2/],
		weakPatterns: [/\bkimi\b/, /moonshot/],
	},
	{
		behavior: {
			family: "glm",
			addsGlmToolStream: true,
			toolChoicePolicy: "auto-only",
		},
		modelPatterns: [/^glm[-_]?5(?:\.2(?:\[1m\])?|\.1|-turbo)?(?:[-_].*)?$/],
		weakPatterns: [
			/\bglm\b/,
			/bigmodel/,
			/zhipu/,
			/open\.bigmodel\.cn/,
			/z\.ai/,
		],
	},
	{
		behavior: {
			family: "qwen",
			thinkingOptions: "qwen",
		},
		modelPatterns: [
			/^qwen(?:3(?:\.[67])?|[-_])/,
			/^qwen-(?:plus|max|turbo|flash)$/,
		],
		weakPatterns: [/\bqwen\b/, /dashscope/, /qwencloud/, /aliyun/, /alibaba/],
	},
	{
		behavior: {
			family: "mistral",
			thinkingOptions: "none",
		},
		modelPatterns: [/^mistral-/, /^ministral-/],
		weakPatterns: [/\bmistral\b/, /api\.mistral\.ai/],
	},
	{
		behavior: {
			family: "nvidia_nemotron",
			usesChatTemplateThinking: true,
		},
		modelPatterns: [/^nvidia\/nemotron-3-/],
		weakPatterns: [/\bnemotron\b/],
	},
	{
		behavior: {
			family: "minimax",
			usesMaxCompletionTokens: true,
			replaysReasoningContentForToolCalls: true,
			thinkingOptions: "minimax",
			addsReasoningSplit: true,
		},
		modelPatterns: [/^minimax-m(?:2(?:\.\d)?|3)(?:[-_][a-z0-9]+)*$/],
		weakPatterns: [/\bminimax\b/, /api\.minimax\.io/],
	},
	{
		behavior: {
			family: "gemma",
			usesChatTemplateThinking: true,
		},
		modelPatterns: [/^(?:google\/)?gemma-4-/],
		weakPatterns: [/\bgemma\b/],
	},
	{
		behavior: {
			family: "gpt_oss",
		},
		modelPatterns: [/^(?:openai\/)?gpt-oss[-:](?:20b|120b)$/],
		weakPatterns: [/\bgpt-oss\b/],
	},
];

const ADAPTER_PROFILE_DEFINITIONS: ProviderAdapterProfileDefinition[] = [
	...PROVIDER_FAMILY_REGISTRY.map((entry) =>
		createProviderAdapterProfile(entry),
	),
	createProviderAdapterProfile({
		behavior: {
			family: "generic",
		},
	}),
];

export function resolveOpenAICompatibleProviderAdapterProfile(
	provider: NormalChatModelRunCompatibilityProvider,
): OpenAICompatibleProviderAdapterProfile {
	const signals = providerCompatibilitySignals(provider);
	return (
		ADAPTER_PROFILE_DEFINITIONS.find((profile) =>
			profile.matchesStrong(signals),
		) ??
		ADAPTER_PROFILE_DEFINITIONS.find((profile) =>
			profile.matchesWeak(signals),
		) ??
		ADAPTER_PROFILE_DEFINITIONS[ADAPTER_PROFILE_DEFINITIONS.length - 1]
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
	entry: ProviderFamilyRegistryEntry,
): ProviderAdapterProfileDefinition {
	const behavior = entry.behavior;
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
		matchesStrong: (signals) =>
			matchesAnyPattern(signals.modelIds, entry.modelPatterns),
		matchesWeak: (signals) =>
			behavior.family === "generic" ||
			matchesAnyPattern([signals.weakHaystack], entry.weakPatterns),
	};
}

function buildProviderOptionsForProfile(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): NormalChatProviderOptions {
	const options: NormalChatProviderOptions = {};
	const reasoningEffort = resolveForwardedReasoningEffort(
		provider,
		thinkingMode,
		behavior,
	);
	if (reasoningEffort) {
		options.reasoningEffort = reasoningEffort;
	}

	return {
		...options,
		...buildThinkingProviderOptions(
			resolveThinkingType(provider, thinkingMode, behavior),
			behavior,
		),
	};
}

function resolveForwardedReasoningEffort(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): NormalChatModelRunCompatibilityProvider["reasoningEffort"] {
	if (thinkingMode === "off") return undefined;
	if (behavior.thinkingOptions === "qwen") return undefined;
	return provider.reasoningEffort;
}

function buildThinkingProviderOptions(
	thinkingType: NormalChatThinkingType | undefined,
	behavior: AdapterBehavior,
): NormalChatProviderOptions {
	if (!thinkingType || behavior.thinkingOptions === "none") return {};
	if (behavior.thinkingOptions === "qwen") {
		return thinkingType === "enabled"
			? { enable_thinking: true, preserve_thinking: true }
			: { enable_thinking: false };
	}
	if (behavior.thinkingOptions === "minimax") {
		return {
			thinking: {
				type: thinkingType === "enabled" ? "adaptive" : "disabled",
			},
		};
	}
	if (behavior.thinkingOptions === "kimi" && thinkingType === "enabled") {
		return { thinking: { type: thinkingType, keep: "all" } };
	}
	return { thinking: { type: thinkingType } };
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
	normalizeKimiK27CodeThinking(transformed, provider, behavior);
	normalizeToolChoiceForProfile(transformed, behavior);
	applyToolChoiceCompatibility(transformed, provider, behavior);
	applyStreamingToolCompatibility(transformed, behavior);
	applyTokenFieldCompatibility(transformed, behavior);
	applyFamilyRequestAdditions(transformed, behavior);
	applyFireworksPromptCacheCompatibility(transformed, provider);
	removeUnsupportedGpt5ToolReasoning(transformed, provider);
	return transformed;
}

function applyToolChoiceCompatibility(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): void {
	if (shouldSuppressToolChoice(body, provider, behavior)) {
		delete body.tool_choice;
	}
	if (shouldDisableQwenThinkingForToolChoice(body, behavior)) {
		body.enable_thinking = false;
		delete body.preserve_thinking;
	}
}

function applyStreamingToolCompatibility(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): void {
	if (behavior.addsGlmToolStream === true && shouldEnableGlmToolStream(body)) {
		body.tool_stream = true;
	}
}

function applyTokenFieldCompatibility(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): void {
	if (
		behavior.usesMaxCompletionTokens !== true ||
		body.max_tokens === undefined
	) {
		return;
	}
	body.max_completion_tokens = body.max_tokens;
	delete body.max_tokens;
}

function applyFamilyRequestAdditions(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): void {
	if (behavior.addsReasoningSplit === true) {
		body.reasoning_split = true;
	}
	if (behavior.usesChatTemplateThinking === true) {
		translateThinkingToChatTemplateKwargs(body);
	}
	if (behavior.family === "deepseek") {
		normalizeDeepSeekReasoningEffort(body);
	}
}

function applyFireworksPromptCacheCompatibility(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): void {
	if (!isFireworksProvider(provider)) return;

	translateBodyField(body, "promptCacheKey", "prompt_cache_key");
	translateBodyField(
		body,
		"promptCacheIsolationKey",
		"prompt_cache_isolation_key",
	);
}

function translateBodyField(
	body: Record<string, unknown>,
	camelKey: string,
	snakeKey: string,
): void {
	if (body[snakeKey] !== undefined) {
		delete body[camelKey];
		return;
	}
	const value = body[camelKey];
	if (value === undefined) return;
	body[snakeKey] = value;
	delete body[camelKey];
}

function isFireworksProvider(
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	const signals = [
		provider.name,
		provider.displayName,
		provider.baseUrl,
		provider.modelName,
		...(provider.modelAliases ?? []),
	]
		.join(" ")
		.toLowerCase();
	return (
		signals.includes("api.fireworks.ai") ||
		signals.includes(".fireworks.ai") ||
		signals.includes("accounts/fireworks/") ||
		/\bfireworks\b/.test(signals)
	);
}

function removeUnsupportedGpt5ToolReasoning(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): void {
	if (!isGpt5ReasoningModel(provider.modelName)) return;
	if (body.reasoning_effort === undefined) return;
	if (!Array.isArray(body.tools) || body.tools.length === 0) return;
	delete body.reasoning_effort;
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
	return messageIncludesAny(
		message,
		RETRYABLE_OPENAI_COMPATIBLE_ERROR_MESSAGE_TERMS,
	);
}

function isNonRetryableOpenAICompatibleErrorMessage(
	message: string | null,
): boolean {
	if (!message) return false;
	return messageIncludesAny(
		message,
		NON_RETRYABLE_OPENAI_COMPATIBLE_ERROR_MESSAGE_TERMS,
	);
}

function messageIncludesAny(message: string, terms: string[]): boolean {
	return terms.some((term) => message.includes(term));
}

function providerCompatibilitySignals(
	provider: NormalChatModelRunCompatibilityProvider,
): ProviderCompatibilitySignals {
	return {
		modelIds: [provider.modelName, ...(provider.modelAliases ?? [])]
			.map(normalizeProviderSignal)
			.filter(Boolean),
		weakHaystack: [provider.name, provider.displayName, provider.baseUrl]
			.map(normalizeProviderSignal)
			.filter(Boolean)
			.join(" "),
	};
}

function matchesAnyPattern(values: string[], patterns: RegExp[] = []): boolean {
	return values.some((value) =>
		patterns.some((pattern) => pattern.test(value)),
	);
}

function normalizeProviderSignal(value: string): string {
	return value.normalize("NFKC").trim().toLowerCase();
}

function resolveThinkingType(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): NormalChatThinkingType | undefined {
	if (shouldForceKimiK27CodeThinking(provider, behavior)) {
		return "enabled";
	}
	if (shouldOmitMiniMaxOffThinking(provider, thinkingMode, behavior)) {
		return undefined;
	}
	if (thinkingMode === "off") {
		return resolveOffThinkingType(provider, behavior);
	}

	if (provider.thinkingType) return provider.thinkingType;
	return shouldEnableQwenThinking(thinkingMode, behavior)
		? "enabled"
		: undefined;
}

function shouldOmitMiniMaxOffThinking(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): boolean {
	return (
		behavior.family === "minimax" &&
		thinkingMode === "off" &&
		!isMiniMaxM3Model(provider)
	);
}

function resolveOffThinkingType(
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): NormalChatThinkingType | undefined {
	if (provider.thinkingType === "enabled") return "disabled";
	return behavior.family === "generic" ? provider.thinkingType : "disabled";
}

function shouldEnableQwenThinking(
	thinkingMode: ThinkingMode | undefined,
	behavior: AdapterBehavior,
): boolean {
	return thinkingMode === "on" && behavior.thinkingOptions === "qwen";
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

function normalizeKimiK27CodeThinking(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): void {
	if (!shouldForceKimiK27CodeThinking(provider, behavior)) return;
	const thinking = body.thinking;
	if (!isRecord(thinking)) return;
	if (thinking.type !== "disabled" && thinking.type !== "enabled") return;
	body.thinking = { type: "enabled", keep: "all" };
}

function normalizeToolChoiceForProfile(
	body: Record<string, unknown>,
	behavior: AdapterBehavior,
): void {
	if (behavior.toolChoicePolicy !== "auto-only") return;
	if (body.tool_choice === undefined || body.tool_choice === "auto") return;
	if (body.tool_choice === "none" && behavior.family === "mimo") return;

	body.tool_choice = "auto";
}

function shouldSuppressToolChoice(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): boolean {
	if (!isThinkingEnabled(body)) return false;
	if (behavior.toolChoicePolicy === "deepseek-legacy-reasoner-when-thinking") {
		return (
			body.tool_choice !== undefined && isLegacyDeepSeekReasonerModel(provider)
		);
	}
	if (behavior.toolChoicePolicy !== "kimi-unsupported-when-thinking") {
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

function shouldEnableGlmToolStream(body: Record<string, unknown>): boolean {
	return (
		body.stream === true && Array.isArray(body.tools) && body.tools.length > 0
	);
}

function translateThinkingToChatTemplateKwargs(
	body: Record<string, unknown>,
): void {
	const thinking = body.thinking;
	if (!isRecord(thinking)) return;
	if (thinking.type !== "enabled" && thinking.type !== "disabled") return;

	const current = isRecord(body.chat_template_kwargs)
		? body.chat_template_kwargs
		: {};
	body.chat_template_kwargs = {
		...current,
		enable_thinking: thinking.type === "enabled",
	};
	delete body.thinking;
}

function normalizeDeepSeekReasoningEffort(body: Record<string, unknown>): void {
	if (typeof body.reasoning_effort !== "string") return;
	if (body.reasoning_effort === "high" || body.reasoning_effort === "max") {
		return;
	}
	body.reasoning_effort = body.reasoning_effort === "xhigh" ? "max" : "high";
}

function shouldForceKimiK27CodeThinking(
	provider: NormalChatModelRunCompatibilityProvider,
	behavior: AdapterBehavior,
): boolean {
	return behavior.family === "kimi" && isKimiK27CodeModel(provider);
}

function isKimiK27CodeModel(
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	return providerModelIdentifiers(provider).some((modelId) =>
		/^kimi-k2\.7-code(?:-|$)/.test(modelId),
	);
}

function isMiniMaxM3Model(
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	return providerModelIdentifiers(provider).some(
		(modelId) => modelId === "minimax-m3",
	);
}

function isLegacyDeepSeekReasonerModel(
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	return providerModelIdentifiers(provider).some(
		(modelId) =>
			modelId === "deepseek-reasoner" || modelId.includes("reasoner"),
	);
}

function providerModelIdentifiers(
	provider: NormalChatModelRunCompatibilityProvider,
): string[] {
	return [provider.modelName, ...(provider.modelAliases ?? [])]
		.map(normalizeProviderSignal)
		.filter(Boolean);
}

function isGpt5ReasoningModel(modelName: string): boolean {
	return modelName.startsWith("gpt-5") && !modelName.startsWith("gpt-5-chat");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
