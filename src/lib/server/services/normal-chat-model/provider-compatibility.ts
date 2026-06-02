import type { ModelConfig } from "$lib/server/env";
import type { ThinkingMode } from "$lib/types";

type NormalChatThinkingType = NonNullable<ModelConfig["thinkingType"]>;

export type NormalChatModelRunCompatibilityProvider = {
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	reasoningEffort?: NonNullable<ModelConfig["reasoningEffort"]>;
	thinkingType?: NormalChatThinkingType;
};

export function buildNormalChatModelRunCompatibilityProviderOptions(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
): Record<string, unknown> {
	const options: Record<string, unknown> = {};
	const family = identifyProviderFamily(provider);
	const thinkingType = resolveThinkingType(provider, thinkingMode, family);

	if (thinkingMode !== "off" && provider.reasoningEffort && family !== "qwen") {
		options.reasoningEffort = provider.reasoningEffort;
	}

	if (thinkingType && family === "qwen") {
		options.enable_thinking = thinkingType === "enabled";
		if (thinkingType === "enabled") {
			options.preserve_thinking = true;
		}
	} else if (thinkingType) {
		options.thinking =
			family === "kimi" && thinkingType === "enabled"
				? { type: thinkingType, keep: "all" }
				: { type: thinkingType };
	}

	return options;
}

export function transformNormalChatModelRunRequestBody(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): Record<string, unknown> {
	const transformed: Record<string, unknown> = {
		...body,
		messages: normalizeAssistantToolCallContent(body.messages),
	};

	if (shouldSuppressToolChoice(transformed, provider)) {
		delete transformed.tool_choice;
	}
	if (shouldDisableQwenThinkingForToolChoice(transformed, provider)) {
		transformed.enable_thinking = false;
		delete transformed.preserve_thinking;
	}

	return transformed;
}

type ProviderFamily = "deepseek" | "kimi" | "qwen" | "generic";

function identifyProviderFamily(
	provider: NormalChatModelRunCompatibilityProvider,
): ProviderFamily {
	const haystack = [
		provider.name,
		provider.displayName,
		provider.baseUrl,
		provider.modelName,
	]
		.join(" ")
		.toLowerCase();

	if (/\bdeepseek\b|deepseek-|api\.deepseek\./.test(haystack)) {
		return "deepseek";
	}
	if (/\bkimi\b|kimi-|moonshot/.test(haystack)) {
		return "kimi";
	}
	if (/\bqwen\b|qwen-|dashscope|qwencloud|aliyun|alibaba/.test(haystack)) {
		return "qwen";
	}
	return "generic";
}

function resolveThinkingType(
	provider: NormalChatModelRunCompatibilityProvider,
	thinkingMode: ThinkingMode | undefined,
	family: ProviderFamily,
): NormalChatThinkingType | undefined {
	if (thinkingMode === "off") {
		return provider.thinkingType === "enabled" || family !== "generic"
			? "disabled"
			: provider.thinkingType;
	}

	if (provider.thinkingType) return provider.thinkingType;
	if (thinkingMode === "on" && family === "qwen") return "enabled";
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
		if (message.content !== null && message.content !== undefined)
			return message;

		return {
			...message,
			content: "",
		};
	});
}

function shouldSuppressToolChoice(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	if (!isThinkingEnabled(body)) return false;

	const family = identifyProviderFamily(provider);
	if (family === "deepseek") return body.tool_choice !== undefined;
	if (family !== "kimi") return false;

	return (
		body.tool_choice !== undefined && !isKimiAllowedToolChoice(body.tool_choice)
	);
}

function shouldDisableQwenThinkingForToolChoice(
	body: Record<string, unknown>,
	provider: NormalChatModelRunCompatibilityProvider,
): boolean {
	return (
		identifyProviderFamily(provider) === "qwen" &&
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
