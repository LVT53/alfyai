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

export type JsonControlMessageResult = {
	text: string;
	rawResponse: unknown;
	modelId: ModelId;
	modelDisplayName: string;
};

export type JsonControlMessageOptions = {
	systemPrompt: string;
	thinkingMode?: ThinkingMode;
	maxTokens?: number;
	temperature?: number;
	signal?: AbortSignal;
	jsonSchema?: JsonControlResponseSchema;
	allowReasoningFallback?: boolean;
	fetch?: typeof fetch;
};

function createControlModelProvider(params: {
	provider: NormalChatModelRunProvider;
	fetch?: typeof fetch;
}) {
	return createOpenAICompatibleProviderForNormalChatModelRun({
		provider: params.provider,
		fetch: params.fetch,
		includeUsage: true,
		supportsStructuredOutputs: true,
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

function buildOutput(options: Pick<JsonControlMessageOptions, "jsonSchema">) {
	if (!options.jsonSchema) {
		return Output.json({ name: "json_control_message" });
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
	output: unknown;
	reasoningText?: string;
	allowReasoningFallback?: boolean;
}): string {
	const text = params.text.trim();
	if (text) return text;

	if (params.allowReasoningFallback && params.reasoningText?.trim()) {
		return params.reasoningText.trim();
	}

	if (params.output !== undefined) {
		return JSON.stringify(params.output);
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

function extractRawResponseBody(response: unknown): unknown {
	const record =
		response && typeof response === "object"
			? (response as Record<string, unknown>)
			: null;
	return record && "body" in record ? record.body : response;
}

function isUnsupportedStructuredOutputError(error: unknown): boolean {
	const record =
		error && typeof error === "object" ? (error as Record<string, unknown>) : {};
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
	});
	const messages: ModelMessage[] = [{ role: "user", content: message }];
	const generate = (params: { useJsonFallbackOutput?: boolean }) =>
		generateText({
			model: openaiCompatible(provider.modelName),
			system: systemPrompt,
			messages,
			output: params.useJsonFallbackOutput
				? buildJsonFallbackOutput(options)
				: buildOutput(options),
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
				jsonSchema: params.useJsonFallbackOutput ? undefined : options.jsonSchema,
			}),
		});
	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await generate({ useJsonFallbackOutput: false });
	} catch (error) {
		if (options.jsonSchema && isUnsupportedStructuredOutputError(error)) {
			result = await generate({ useJsonFallbackOutput: true });
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
				};
			}
		} else {
			throw error;
		}
	}

	return {
		text: resultText({
			text: result.text,
			output: result.output,
			reasoningText: result.reasoningText,
			allowReasoningFallback: options.allowReasoningFallback,
		}),
		rawResponse: result.response.body,
		modelId: selectedModelId,
		modelDisplayName: provider.displayName,
	};
}
