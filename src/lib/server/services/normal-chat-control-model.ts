import {
	generateText,
	jsonSchema,
	type ModelMessage,
	NoObjectGeneratedError,
	Output,
} from "ai";
import type { ModelId, ThinkingMode } from "$lib/types";
import { getConfig } from "../config-store";
import { getSystemPrompt } from "../prompts";

import { buildOutboundSystemPrompt } from "./normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	createOpenAICompatibleProviderForNormalChatModelRun,
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "./normal-chat-model";
import {
	CONTROL_MODEL_DEFAULT_MAX_TOKENS,
	CONTROL_MODEL_MAX_TOKEN_CAP,
	CONTROL_MODEL_TEMPERATURE,
	DEFAULT_MODEL_MAX_RETRIES,
} from "./normal-chat-model-config";

export type JsonControlResponseSchema = {
	name: string;
	schema: Record<string, unknown>;
	strict?: boolean;
};

export type JsonControlMessageUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	// Optional cache breakdown surfaced from cache-aware providers (DeepSeek's
	// prompt_cache_hit_tokens/prompt_cache_miss_tokens, OpenAI's
	// prompt_tokens_details.cached_tokens) so memory-cost pricing is cache-aware.
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
};

export type JsonControlMessageResult = {
	text: string;
	rawResponse: unknown;
	modelId: ModelId;
	modelDisplayName: string;
	usage?: JsonControlMessageUsage;
};

export type JsonControlMessageOptions = {
	systemPrompt: string;
	thinkingMode?: ThinkingMode;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	jsonSchema?: JsonControlResponseSchema;
	allowReasoningFallback?: boolean;
	allowEmptyTextOnLengthFinish?: boolean;
	skipStructuredOutputs?: boolean;
	fetch?: typeof fetch;
};

function createControlModelProvider(params: {
	provider: NormalChatModelRunProvider;
	fetch?: typeof fetch;
	skipStructuredOutputs?: boolean;
}) {
	return createOpenAICompatibleProviderForNormalChatModelRun({
		provider: params.provider,
		fetch: params.fetch,
		includeUsage: true,
		supportsStructuredOutputs: !params.skipStructuredOutputs,
		normalizeStreaming: false,
	});
}

function buildProviderOptions(params: {
	provider: NormalChatModelRunProvider;
	thinkingMode?: ThinkingMode;
	jsonSchema?: JsonControlResponseSchema;
}) {
	const normalChatProviderOptions =
		buildNormalChatModelRunProviderOptions(
			params.provider,
			params.thinkingMode,
		) ?? {};
	const normalChatOptions =
		normalChatProviderOptions[params.provider.name] ?? {};
	const schemaOptions = params.jsonSchema
		? { strictJsonSchema: params.jsonSchema.strict ?? true }
		: {};
	const providerOptions = {
		...normalChatOptions,
		...schemaOptions,
	};

	if (Object.keys(providerOptions).length === 0) return undefined;

	return {
		[params.provider.name]: {
			...providerOptions,
		},
	};
}

function buildOutput(
	options: Pick<
		JsonControlMessageOptions,
		"jsonSchema" | "skipStructuredOutputs"
	>,
) {
	if (!options.jsonSchema || options.skipStructuredOutputs) {
		return Output.json({
			name: options.jsonSchema?.name ?? "json_control_message",
		});
	}

	return Output.object({
		name: options.jsonSchema.name,
		schema: jsonSchema(options.jsonSchema.schema),
	});
}

function buildJsonFallbackOutput(
	options: Pick<JsonControlMessageOptions, "jsonSchema">,
) {
	return Output.json({
		name: options.jsonSchema?.name ?? "json_control_message",
	});
}

function resultText(params: {
	text: string;
	output: () => unknown;
	rawResponse?: unknown;
	reasoningText?: string;
	allowReasoningFallback?: boolean;
	allowEmptyTextOnLengthFinish?: boolean;
}): string {
	const text = params.text.trim();
	if (text) return text;

	if (params.allowReasoningFallback && params.reasoningText?.trim()) {
		return params.reasoningText.trim();
	}

	if (
		params.allowEmptyTextOnLengthFinish &&
		hasLengthFinishReason(params.rawResponse)
	) {
		return "";
	}

	const output = params.output();
	if (output !== undefined) {
		return JSON.stringify(output);
	}

	throw new Error("Could not extract message text from control model response");
}

function extractReasoningFallbackText(rawResponse: unknown): string | null {
	const record =
		rawResponse && typeof rawResponse === "object"
			? (rawResponse as Record<string, unknown>)
			: {};
	const choices = Array.isArray(record.choices) ? record.choices : [];
	const firstChoice = choices[0] as Record<string, unknown> | undefined;
	const message =
		firstChoice?.message && typeof firstChoice.message === "object"
			? (firstChoice.message as Record<string, unknown>)
			: null;
	const reasoning = message?.reasoning ?? message?.reasoning_content;
	if (typeof reasoning === "string" && reasoning.trim()) {
		return reasoning.trim();
	}
	return null;
}

function hasLengthFinishReason(rawResponse: unknown): boolean {
	const record =
		rawResponse && typeof rawResponse === "object"
			? (rawResponse as Record<string, unknown>)
			: null;
	const choices = Array.isArray(record?.choices) ? record.choices : [];
	const firstChoice = choices[0] as Record<string, unknown> | undefined;
	return firstChoice?.finish_reason === "length";
}

const JSON_OBJECT_MODE_GUARD_SENTENCE = "Respond with a single JSON object.";

function withJsonKeywordGuard(params: {
	systemPrompt: string;
	message: string;
}): string {
	const mentionsJson =
		/json/i.test(params.systemPrompt) || /json/i.test(params.message);
	if (mentionsJson) return params.systemPrompt;
	return `${params.systemPrompt}\n\n${JSON_OBJECT_MODE_GUARD_SENTENCE}`;
}

function readFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: undefined;
}

// Surface token usage from a control-model call. The AI SDK v5 exposes usage on
// `result.usage` (inputTokens/outputTokens/totalTokens). When that is absent we
// fall back to the raw OpenAI-shaped usage on the response body
// (prompt_tokens/completion_tokens/total_tokens). Returns undefined when neither
// carries any usage so callers can treat "no usage" distinctly from zero.
// Read the DeepSeek/OpenAI-shaped cache-token breakdown from a raw usage object.
function readCacheBreakdown(source: unknown): {
	cachedInputTokens?: number;
	cacheHitTokens?: number;
	cacheMissTokens?: number;
} {
	const obj =
		source && typeof source === "object"
			? (source as Record<string, unknown>)
			: null;
	if (!obj) return {};
	const details =
		obj.prompt_tokens_details && typeof obj.prompt_tokens_details === "object"
			? (obj.prompt_tokens_details as Record<string, unknown>)
			: null;
	const cacheHitTokens = readFiniteNumber(
		obj.prompt_cache_hit_tokens ??
			obj.promptCacheHitTokens ??
			details?.cached_tokens ??
			details?.cachedTokens,
	);
	const cacheMissTokens = readFiniteNumber(
		obj.prompt_cache_miss_tokens ?? obj.promptCacheMissTokens,
	);
	if (cacheHitTokens === undefined && cacheMissTokens === undefined) return {};
	return {
		...(cacheHitTokens !== undefined
			? { cachedInputTokens: cacheHitTokens, cacheHitTokens }
			: {}),
		...(cacheMissTokens !== undefined ? { cacheMissTokens } : {}),
	};
}

function extractControlModelUsage(params: {
	usage: unknown;
	rawResponse: unknown;
}): JsonControlMessageUsage | undefined {
	const sdkUsage =
		params.usage && typeof params.usage === "object"
			? (params.usage as Record<string, unknown>)
			: null;
	const body =
		params.rawResponse && typeof params.rawResponse === "object"
			? (params.rawResponse as Record<string, unknown>)
			: null;
	const rawUsage =
		body?.usage && typeof body.usage === "object"
			? (body.usage as Record<string, unknown>)
			: null;
	// Cache tokens can live on the SDK usage's `raw` passthrough or on the
	// OpenAI-shaped response-body usage; prefer whichever carries them.
	const cacheBreakdown = {
		...readCacheBreakdown(rawUsage),
		...readCacheBreakdown(sdkUsage?.raw),
	};

	const inputTokens = readFiniteNumber(sdkUsage?.inputTokens);
	const outputTokens = readFiniteNumber(sdkUsage?.outputTokens);
	const sdkTotalTokens = readFiniteNumber(sdkUsage?.totalTokens);
	if (
		inputTokens !== undefined ||
		outputTokens !== undefined ||
		sdkTotalTokens !== undefined
	) {
		const promptTokens = inputTokens ?? 0;
		const completionTokens = outputTokens ?? 0;
		return {
			promptTokens,
			completionTokens,
			totalTokens: sdkTotalTokens ?? promptTokens + completionTokens,
			...cacheBreakdown,
		};
	}

	const promptTokens = readFiniteNumber(rawUsage?.prompt_tokens);
	const completionTokens = readFiniteNumber(rawUsage?.completion_tokens);
	const rawTotalTokens = readFiniteNumber(rawUsage?.total_tokens);
	if (
		promptTokens !== undefined ||
		completionTokens !== undefined ||
		rawTotalTokens !== undefined
	) {
		const prompt = promptTokens ?? 0;
		const completion = completionTokens ?? 0;
		return {
			promptTokens: prompt,
			completionTokens: completion,
			totalTokens: rawTotalTokens ?? prompt + completion,
			...cacheBreakdown,
		};
	}

	return undefined;
}

function extractRawResponseBody(response: unknown): unknown {
	const record =
		response && typeof response === "object"
			? (response as Record<string, unknown>)
			: null;
	return record && "body" in record ? record.body : response;
}

function isUnsupportedStructuredOutputError(error: unknown): boolean {
	const record =
		error && typeof error === "object"
			? (error as Record<string, unknown>)
			: {};
	const message = typeof record.message === "string" ? record.message : "";
	const responseBody =
		typeof record.responseBody === "string" ? record.responseBody : "";
	const detail = `${message}\n${responseBody}`;
	return (
		/response_format/i.test(detail) &&
		/(unavailable|unsupported|not supported|json_schema|invalid_request)/i.test(
			detail,
		)
	);
}

export async function sendJsonControlMessage(
	message: string,
	modelId: ModelId | undefined,
	options: JsonControlMessageOptions,
): Promise<JsonControlMessageResult> {
	const config = getConfig();
	const selectedModelId = modelId ?? "model1";
	const provider = await resolveNormalChatModelRunProvider(
		selectedModelId,
		config,
	);
	if (!provider.baseUrl || !provider.modelName) {
		throw new Error("Selected control model is not configured");
	}

	const systemPrompt = buildOutboundSystemPrompt({
		basePrompt: getSystemPrompt(options.systemPrompt),
		inputValue: message,
		modelDisplayName: provider.displayName,
		modelName: provider.modelName,
		skipDefaultRuntimeGuidance: true,
	});
	const openaiCompatible = createControlModelProvider({
		provider,
		fetch: options.fetch,
		skipStructuredOutputs: options.skipStructuredOutputs,
	});
	const messages: ModelMessage[] = [{ role: "user", content: message }];
	const generate = (params: { useJsonFallbackOutput?: boolean }) =>
		generateText({
			model: openaiCompatible(provider.modelName),
			system: params.useJsonFallbackOutput
				? withJsonKeywordGuard({ systemPrompt, message })
				: systemPrompt,
			messages,
			output: params.useJsonFallbackOutput
				? buildJsonFallbackOutput(options)
				: buildOutput({
						jsonSchema: options.jsonSchema,
						skipStructuredOutputs: options.skipStructuredOutputs,
					}),
			temperature: options.temperature ?? CONTROL_MODEL_TEMPERATURE,
			maxOutputTokens:
				options.maxTokens ??
				(provider.maxOutputTokens != null
					? Math.min(provider.maxOutputTokens, CONTROL_MODEL_MAX_TOKEN_CAP)
					: CONTROL_MODEL_DEFAULT_MAX_TOKENS),
			maxRetries: DEFAULT_MODEL_MAX_RETRIES,
			abortSignal: options.signal,
			timeout: config.requestTimeoutMs,
			providerOptions: buildProviderOptions({
				provider,
				thinkingMode: options.thinkingMode,
				jsonSchema: params.useJsonFallbackOutput
					? undefined
					: options.jsonSchema,
			}),
		});
	try {
		const result = await generate({ useJsonFallbackOutput: false });
		const rawResponse = result.response.body;
		return {
			text: resultText({
				text: result.text,
				output: () => result.output,
				rawResponse,
				reasoningText: result.reasoningText,
				allowReasoningFallback: options.allowReasoningFallback,
				allowEmptyTextOnLengthFinish: options.allowEmptyTextOnLengthFinish,
			}),
			rawResponse,
			modelId: selectedModelId,
			modelDisplayName: provider.displayName,
			usage: extractControlModelUsage({ usage: result.usage, rawResponse }),
		};
	} catch (error) {
		if (options.jsonSchema && isUnsupportedStructuredOutputError(error)) {
			const result = await generate({ useJsonFallbackOutput: true });
			const rawResponse = result.response.body;
			return {
				text: resultText({
					text: result.text,
					output: () => result.output,
					rawResponse,
					reasoningText: result.reasoningText,
					allowReasoningFallback: options.allowReasoningFallback,
					allowEmptyTextOnLengthFinish: options.allowEmptyTextOnLengthFinish,
				}),
				rawResponse,
				modelId: selectedModelId,
				modelDisplayName: provider.displayName,
				usage: extractControlModelUsage({ usage: result.usage, rawResponse }),
			};
		} else if (
			options.allowReasoningFallback &&
			NoObjectGeneratedError.isInstance(error)
		) {
			const rawResponse = extractRawResponseBody(error.response);
			const fallbackText = extractReasoningFallbackText(rawResponse);
			if (fallbackText) {
				return {
					text: fallbackText,
					rawResponse,
					modelId: selectedModelId,
					modelDisplayName: provider.displayName,
					usage: extractControlModelUsage({
						usage: undefined,
						rawResponse,
					}),
				};
			}
			throw error;
		} else {
			throw error;
		}
	}
}
