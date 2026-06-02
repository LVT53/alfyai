import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	APICallError,
	type FinishReason,
	generateText,
	InvalidToolInputError,
	type LanguageModelUsage,
	type ModelMessage,
	NoSuchToolError,
	type StopCondition,
	stepCountIs,
	streamText,
	type ToolChoice,
	type ToolSet,
} from "ai";
import {
	isModelCapabilitySupported,
	isModelCapabilityUnsupported,
	type ModelCapabilityKey,
	type ModelCapabilitySet,
} from "$lib/model-capabilities";
import type { ModelConfig } from "$lib/server/env";
import type { ThinkingMode } from "$lib/types";
import type { ProviderUsageSnapshot } from "../analytics";
import { decryptApiKey, getProviderWithSecrets } from "../inference-providers";
import { repairMalformedToolCallJson } from "$lib/server/utils/tool-json-repair";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import { createOpenAICompatibleStreamNormalizingFetch } from "./openai-compatible-stream-normalizer";
import {
	buildNormalChatModelRunCompatibilityProviderOptions,
	transformNormalChatModelRunRequestBody,
} from "./provider-compatibility";

function toolCallRepairFunction({
	error,
	toolCall,
}: {
	error: InvalidToolInputError | NoSuchToolError;
	toolCall: { toolCallId: string; toolName: string; input: string };
}): { toolCallId: string; toolName: string; input: string } | null {
	if (NoSuchToolError.isInstance(error)) return null;
	const repaired = repairMalformedToolCallJson(toolCall.input);
	if (!repaired) return null;
	return { ...toolCall, input: repaired };
}

type NormalChatReasoningEffort = NonNullable<ModelConfig["reasoningEffort"]>;
type NormalChatThinkingType = NonNullable<ModelConfig["thinkingType"]>;

export type NormalChatModelRunProvider = {
	id: string;
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	apiKey: string;
	maxOutputTokens?: number;
	maxModelContext?: number;
	compactionUiThreshold?: number;
	targetConstructedContext?: number;
	reasoningEffort?: NormalChatReasoningEffort;
	thinkingType?: NormalChatThinkingType;
	capabilities?: ModelCapabilitySet;
};

type BuiltinNormalChatModelConfig = Pick<
	ModelConfig,
	| "baseUrl"
	| "apiKey"
	| "modelName"
	| "displayName"
	| "maxTokens"
	| "reasoningEffort"
>;

type NormalChatModelRunRuntimeConfig = {
	model1: BuiltinNormalChatModelConfig;
	model2: BuiltinNormalChatModelConfig;
};

export type NormalChatModelRunBaseParams = {
	provider: NormalChatModelRunProvider;
	messages: ModelMessage[];
	system?: string;
	headers?: Record<string, string | undefined>;
	providerOptions?: Record<string, Record<string, unknown>>;
	abortSignal?: AbortSignal;
	fetch?: typeof fetch;
	maxRetries?: number;
	maxOutputTokens?: number | null;
};

export type PlainNormalChatModelRunParams = NormalChatModelRunBaseParams & {
	tools?: ToolSet;
	toolChoice?: ToolChoice<ToolSet>;
	maxToolSteps?: number;
	stopWhen?: StopCondition<ToolSet>;
};

export type StreamingNormalChatModelRunParams = NormalChatModelRunBaseParams & {
	tools?: ToolSet;
	toolChoice?: ToolChoice<ToolSet>;
	maxToolSteps?: number;
	stopWhen?: StopCondition<ToolSet>;
};

export type PlainNormalChatModelRunResult = {
	text: string;
	finishReason: FinishReason;
	usage: {
		inputTokens: number | undefined;
		outputTokens: number | undefined;
		totalTokens: number | undefined;
	};
	model: {
		providerId: string;
		providerName: string;
		displayName: string;
		requestedModelName: string;
		responseModelName: string;
	};
};

export type NormalChatModelRunUsage = {
	inputTokens: number | undefined;
	outputTokens: number | undefined;
	totalTokens: number | undefined;
};

export type NormalChatModelRunModelMetadata = {
	providerId: string;
	providerName: string;
	displayName: string;
	requestedModelName: string;
	responseModelName: string;
};

export type StreamingNormalChatModelRunEvent =
	| {
			type: "text_delta";
			text: string;
	  }
	| {
			type: "reasoning_delta";
			text: string;
	  }
	| {
			type: "tool_call";
			callId: string;
			toolName: string;
			input: unknown;
	  }
	| {
			type: "tool_result";
			callId: string;
			toolName: string;
			output: unknown;
	  }
	| {
			type: "tool_error";
			callId: string;
			toolName: string;
			error: string;
	  }
	| {
			type: "usage";
			usage: NormalChatModelRunUsage;
	  }
	| {
			type: "finish";
			finishReason: FinishReason;
			rawFinishReason: string | undefined;
			model: NormalChatModelRunModelMetadata;
	  }
	| {
			type: "error";
			error: string;
	  };

export async function resolveNormalChatModelRunProvider(
	modelId: string,
	runtimeConfig?: NormalChatModelRunRuntimeConfig,
): Promise<NormalChatModelRunProvider> {
	if (modelId === "model1" || modelId === "model2") {
		if (!runtimeConfig) {
			throw new Error(
				`Normal Chat Model Run runtime config is required for ${modelId}`,
			);
		}
		return builtinModelRunProvider(modelId, runtimeConfig[modelId]);
	}

	const providerId = modelId.startsWith("provider:")
		? modelId.slice("provider:".length)
		: modelId;
	const provider = await getProviderWithSecrets(providerId);
	if (!provider) {
		throw new Error(`Normal Chat Model Run provider not found: ${providerId}`);
	}
	if (!provider.enabled) {
		throw new Error(
			`Normal Chat Model Run provider is disabled: ${providerId}`,
		);
	}

	// Derive targetConstructedContext and compactionUiThreshold from maxModelContext
	// when they are not explicitly set, so the chat pipeline uses provider-specific
	// limits instead of falling back to global defaults.
	const hasExplicitTarget =
		typeof provider.targetConstructedContext === "number";
	const hasExplicitCompaction =
		typeof provider.compactionUiThreshold === "number";
	const hasMaxModelContext = typeof provider.maxModelContext === "number";
	const derivedTargetConstructedContext = hasMaxModelContext
		? Math.floor(provider.maxModelContext * 0.9)
		: undefined;
	const derivedCompactionUiThreshold = hasMaxModelContext
		? Math.floor(provider.maxModelContext * 0.8)
		: undefined;

	return {
		id: provider.id,
		name: provider.name,
		displayName: provider.displayName,
		baseUrl: normalizeOpenAICompatibleBaseUrl(provider.baseUrl),
		modelName: provider.modelName,
		apiKey: decryptApiKey(provider.apiKeyEncrypted, provider.apiKeyIv),
		maxOutputTokens:
			typeof provider.maxTokens === "number" ? provider.maxTokens : undefined,
		reasoningEffort: provider.reasoningEffort ?? undefined,
		thinkingType: provider.thinkingType ?? undefined,
		...(provider.capabilities ? { capabilities: provider.capabilities } : {}),
		...(hasMaxModelContext
			? { maxModelContext: provider.maxModelContext }
			: {}),
		...(hasExplicitCompaction
			? { compactionUiThreshold: provider.compactionUiThreshold }
			: derivedCompactionUiThreshold !== undefined
				? { compactionUiThreshold: derivedCompactionUiThreshold }
				: {}),
		...(hasExplicitTarget
			? { targetConstructedContext: provider.targetConstructedContext }
			: derivedTargetConstructedContext !== undefined
				? { targetConstructedContext: derivedTargetConstructedContext }
				: {}),
	};
}

function builtinModelRunProvider(
	modelId: "model1" | "model2",
	modelConfig: BuiltinNormalChatModelConfig,
): NormalChatModelRunProvider {
	if (!modelConfig.baseUrl || !modelConfig.modelName) {
		throw new Error(`Normal Chat Model Run ${modelId} is not configured`);
	}
	return {
		id: modelId,
		name: modelId,
		displayName: modelConfig.displayName,
		baseUrl: normalizeOpenAICompatibleBaseUrl(modelConfig.baseUrl),
		modelName: modelConfig.modelName,
		apiKey: modelConfig.apiKey,
		maxOutputTokens:
			typeof modelConfig.maxTokens === "number"
				? modelConfig.maxTokens
				: undefined,
		reasoningEffort: modelConfig.reasoningEffort ?? undefined,
		thinkingType: modelConfig.thinkingType ?? undefined,
	};
}

export function buildNormalChatModelRunProviderOptions(
	provider: NormalChatModelRunProvider,
	thinkingMode: ThinkingMode | undefined,
): Record<string, Record<string, unknown>> | undefined {
	if (isCapabilityUnsupported(provider, "reasoningControls")) return undefined;

	const options = buildNormalChatModelRunCompatibilityProviderOptions(
		provider,
		thinkingMode,
	);
	if (Object.keys(options).length === 0) return undefined;

	return { [provider.name]: options };
}

function isCapabilityUnsupported(
	provider: NormalChatModelRunProvider,
	capability: ModelCapabilityKey,
): boolean {
	return isModelCapabilityUnsupported(provider.capabilities, capability);
}

function isCapabilitySupported(
	provider: NormalChatModelRunProvider,
	capability: ModelCapabilityKey,
): boolean {
	return isModelCapabilitySupported(provider.capabilities, capability);
}

function assertCapabilitySupported(params: {
	provider: NormalChatModelRunProvider;
	capability: ModelCapabilityKey;
	requirement: string;
}): void {
	if (!isCapabilityUnsupported(params.provider, params.capability)) return;

	throw new Error(
		`Normal Chat Model Run provider does not support required ${params.requirement}: ${params.provider.displayName}`,
	);
}

function assertNormalChatModelRunCapabilities(params: {
	provider: NormalChatModelRunProvider;
	streaming: boolean;
	tools?: ToolSet;
}): void {
	assertCapabilitySupported({
		provider: params.provider,
		capability: "chat",
		requirement: "chat",
	});

	if (params.streaming) {
		assertCapabilitySupported({
			provider: params.provider,
			capability: "streaming",
			requirement: "streaming",
		});
	}

	if (params.tools && Object.keys(params.tools).length > 0) {
		assertCapabilitySupported({
			provider: params.provider,
			capability: "tools",
			requirement: "tools",
		});
	}
}

function createNormalChatOpenAICompatibleProvider(params: {
	provider: NormalChatModelRunProvider;
	fetch?: typeof fetch;
}) {
	const normalizedFetch = createOpenAICompatibleStreamNormalizingFetch(
		params.fetch,
	);

	return createOpenAICompatible({
		name: params.provider.name,
		apiKey: params.provider.apiKey,
		baseURL: normalizeOpenAICompatibleBaseUrl(params.provider.baseUrl),
		includeUsage: !isCapabilityUnsupported(params.provider, "usageReporting"),
		transformRequestBody: (body) =>
			transformNormalChatModelRunRequestBody(body, params.provider),
		fetch: normalizedFetch,
	});
}

function mapUsage(usage: LanguageModelUsage): NormalChatModelRunUsage {
	return {
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		totalTokens: usage.totalTokens,
	};
}

export function mapNormalChatModelRunUsageToProviderSnapshot(
	usage: NormalChatModelRunUsage,
): ProviderUsageSnapshot | null {
	const hasUsage =
		typeof usage.inputTokens === "number" ||
		typeof usage.outputTokens === "number" ||
		typeof usage.totalTokens === "number";
	if (!hasUsage) return null;

	return {
		promptTokens: usage.inputTokens,
		completionTokens: usage.outputTokens,
		totalTokens: usage.totalTokens,
		source: "provider",
	};
}

function modelMetadata(
	provider: NormalChatModelRunProvider,
	responseModelName: string,
): NormalChatModelRunModelMetadata {
	return {
		providerId: provider.id,
		providerName: provider.name,
		displayName: provider.displayName,
		requestedModelName: provider.modelName,
		responseModelName,
	};
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Unknown Normal Chat Model Run stream error";
}

function serializedErrorText(error: unknown): string {
	const parts = [];
	if (error instanceof Error) parts.push(error.message);
	if (typeof error === "string") parts.push(error);
	if (APICallError.isInstance(error)) {
		if (error.responseBody) parts.push(error.responseBody);
		if (error.data) parts.push(JSON.stringify(error.data));
	}
	return parts.join("\n").toLowerCase();
}

function requestContainsToolResult(error: unknown): boolean {
	if (!APICallError.isInstance(error)) return false;
	return (JSON.stringify(error.requestBodyValues) ?? "").includes(
		'"role":"tool"',
	);
}

function isUnsupportedToolsRequestError(error: unknown): boolean {
	if (!APICallError.isInstance(error)) return false;
	if (error.statusCode !== 400 && error.statusCode !== 422) return false;
	if (requestContainsToolResult(error)) return false;

	const text = serializedErrorText(error);
	const referencesTools =
		/\btools?\b/.test(text) ||
		/\btool_choice\b/.test(text) ||
		/\btool calls?\b/.test(text) ||
		/\bfunctions?\b/.test(text);
	const rejectsRequestShape =
		/unsupported/.test(text) ||
		/not supported/.test(text) ||
		/unknown field/.test(text) ||
		/unrecognized field/.test(text) ||
		/unexpected field/.test(text) ||
		/invalid field/.test(text) ||
		/schema/.test(text) ||
		/property/.test(text);

	return referencesTools && rejectsRequestShape;
}

export async function runPlainNormalChatModelRun(
	params: PlainNormalChatModelRunParams,
): Promise<PlainNormalChatModelRunResult> {
	assertNormalChatModelRunCapabilities({
		provider: params.provider,
		streaming: false,
		tools: params.tools,
	});
	const provider = createNormalChatOpenAICompatibleProvider({
		provider: params.provider,
		fetch: params.fetch,
	});
	const stopWhen =
		params.stopWhen ??
		(params.tools ? stepCountIs(params.maxToolSteps ?? 5) : undefined);

	const request = {
		model: provider(params.provider.modelName),
		messages: params.messages,
		system: params.system,
		tools: params.tools,
		toolChoice: params.toolChoice,
		stopWhen,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
		maxRetries: params.maxRetries ?? 0,
		abortSignal: params.abortSignal,
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
	};

	let result: Awaited<ReturnType<typeof generateText>>;
	try {
		result = await generateText(request);
	} catch (error) {
		if (
			!params.tools ||
			params.toolChoice ||
			!isUnsupportedToolsRequestError(error)
		) {
			throw error;
		}
		if (isCapabilitySupported(params.provider, "tools")) {
			throw error;
		}

		result = await generateText({
			...request,
			tools: undefined,
			stopWhen: undefined,
		});
	}

	return {
		text: result.text,
		finishReason: result.finishReason,
		usage: mapUsage(result.usage),
		model: modelMetadata(params.provider, result.response.modelId),
	};
}

export function runStreamingNormalChatModelRun(
	params: StreamingNormalChatModelRunParams,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	assertNormalChatModelRunCapabilities({
		provider: params.provider,
		streaming: true,
		tools: params.tools,
	});

	return streamStreamingNormalChatModelRun(params);
}

async function* streamStreamingNormalChatModelRun(
	params: StreamingNormalChatModelRunParams,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	const provider = createNormalChatOpenAICompatibleProvider({
		provider: params.provider,
		fetch: params.fetch,
	});
	const stopWhen =
		params.stopWhen ??
		(params.tools ? stepCountIs(params.maxToolSteps ?? 5) : undefined);
	const result = streamText({
		model: provider(params.provider.modelName),
		messages: params.messages,
		system: params.system,
		tools: params.tools,
		toolChoice: params.toolChoice,
		stopWhen,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
		maxRetries: params.maxRetries ?? 0,
		abortSignal: params.abortSignal,
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
		onError: () => undefined,
	});

	let responseModelName = params.provider.modelName;

	try {
		for await (const part of result.fullStream) {
			switch (part.type) {
				case "text-delta":
					yield { type: "text_delta", text: part.text };
					break;
				case "reasoning-delta":
					yield { type: "reasoning_delta", text: part.text };
					break;
				case "tool-call":
					yield {
						type: "tool_call",
						callId: part.toolCallId,
						toolName: part.toolName,
						input: part.input,
					};
					break;
				case "tool-result":
					yield {
						type: "tool_result",
						callId: part.toolCallId,
						toolName: part.toolName,
						output: part.output,
					};
					break;
				case "tool-error":
					yield {
						type: "tool_error",
						callId: part.toolCallId,
						toolName: part.toolName,
						error: errorMessage(part.error),
					};
					break;
				case "finish-step":
					responseModelName = part.response.modelId;
					break;
				case "finish":
					yield {
						type: "usage",
						usage: mapUsage(part.totalUsage),
					};
					yield {
						type: "finish",
						finishReason: part.finishReason,
						rawFinishReason: part.rawFinishReason,
						model: modelMetadata(params.provider, responseModelName),
					};
					break;
				case "error":
					yield { type: "error", error: errorMessage(part.error) };
					break;
			}
		}
	} catch (error) {
		yield { type: "error", error: errorMessage(error) };
	}
}
