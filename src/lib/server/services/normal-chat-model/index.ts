import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
	APICallError,
	type FinishReason,
	generateText,
	hasToolCall,
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
	createModelCapabilitySet,
	isModelCapabilitySupported,
	isModelCapabilityUnsupported,
	MODEL_CAPABILITY_KEYS,
	type ModelCapabilityKey,
	type ModelCapabilitySet,
} from "$lib/model-capabilities";
import type { ModelConfig } from "$lib/server/env";
import type { ThinkingMode } from "$lib/types";
import type { ProviderUsageSnapshot } from "../analytics";
import {
	getProviderByName,
	decryptApiKey,
	getProviderWithSecrets,
} from "../providers";
import { listEnabledProviderModels } from "../provider-models";
import { repairMalformedToolCallJson } from "$lib/server/utils/tool-json-repair";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import { createOpenAICompatibleStreamNormalizingFetch } from "./openai-compatible-stream-normalizer";
import { DEFAULT_MODEL_MAX_RETRIES } from "../normal-chat-model-config";
import {
	buildNormalChatModelRunCompatibilityProviderOptions,
	transformNormalChatModelRunRequestBody,
} from "./provider-compatibility";

const DEFAULT_MAX_TOOL_STEPS = 20;

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

function stagnantProgress(): StopCondition<ToolSet> {
	return ({ steps }) => {
		if (steps.length < 4) return false;

		const withToolResults = steps.filter(
			(s) => (s.toolResults?.length ?? 0) > 0,
		);
		if (withToolResults.length < 3) return false;

		const recent = withToolResults.slice(-3);

		const allToolNames = new Set(
			recent.flatMap((s) => s.toolCalls?.map((tc) => tc.toolName) ?? []),
		);
		if (allToolNames.size === 1 && withToolResults.length >= 5) {
			return true;
		}

		const resultSizes = recent
			.flatMap(
				(s) =>
					s.toolResults?.map((tr) =>
						typeof tr.output === "string" ? tr.output.length : 0,
					) ?? [],
			)
			.filter((n) => n > 0);

		if (resultSizes.length >= 3) {
			const last3 = resultSizes.slice(-3);
			if (
				last3[0] > 0 &&
				last3.every(
					(v, i) => i === 0 || v <= last3[i - 1] * 0.5,
				)
			) {
				return true;
			}
		}

		return false;
	};
}

function buildToolStopWhen(
	maxToolSteps: number,
): StopCondition<ToolSet>[] {
	return [
		hasToolCall("done"),
		stagnantProgress(),
		stepCountIs(maxToolSteps),
	];
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
		const newProvider = await resolveBuiltinFromNewProvidersTable(modelId);
		if (newProvider) return newProvider;

		if (!runtimeConfig) {
			throw new Error(
				`Normal Chat Model Run runtime config is required for ${modelId}`,
			);
		}
		return builtinModelRunProvider(modelId, runtimeConfig[modelId]);
	}

	try {
		const newProvider = await resolveBuiltinFromNewProvidersTable(modelId);
		if (newProvider) return newProvider;
	} catch {
	}

	throw new Error(
		`Normal Chat Model Run provider not found: ${modelId}`,
	);
}

async function resolveBuiltinFromNewProvidersTable(
	name: string,
): Promise<NormalChatModelRunProvider | null> {
	try {
		// Handle composite ID format: provider:<provider-uuid>:<model-uuid>
		let provider: Awaited<ReturnType<typeof getProviderWithSecrets>> | null = null;
		let modelNameFilter: string | null = null;

		if (name.startsWith("provider:") && name.split(":").length >= 3) {
			const parts = name.split(":");
			const providerId = parts[1];
			const modelId = parts[2];
			provider = await getProviderWithSecrets(providerId).catch(() => null);
			if (provider && provider.enabled) {
				const models = await listEnabledProviderModels(provider.id);
				const model = models.find((m) => m.id === modelId);
				if (!model) return null;
				return buildProviderModelRunConfig(provider, model);
			}
			return null;
		}

		// Legacy format: provider:<provider-name> or bare name
		provider = await getProviderByName(name).catch(() => null);
		if (!provider || !provider.enabled) return null;

		const models = await listEnabledProviderModels(provider.id);
		const model = models[0];
		if (!model) return null;

		const providerWithSecrets = await getProviderWithSecrets(provider.id);
		if (!providerWithSecrets) return null;

		return buildProviderModelRunConfig(providerWithSecrets, model);
	} catch {
		return null;
	}
}

function buildProviderModelRunConfig(
	providerWithSecrets: Awaited<ReturnType<typeof getProviderWithSecrets>>,
	model: Awaited<ReturnType<typeof listEnabledProviderModels>>[number],
): NormalChatModelRunProvider {
		const hasExplicitTarget =
			typeof model.targetConstructedContext === "number";
		const hasExplicitCompaction =
			typeof model.compactionUiThreshold === "number";
		const hasMaxModelContext = typeof model.maxModelContext === "number";
		const derivedTargetConstructedContext = hasMaxModelContext
			? Math.floor(model.maxModelContext * 0.9)
			: undefined;
		const derivedCompactionUiThreshold = hasMaxModelContext
			? Math.floor(model.maxModelContext * 0.8)
			: undefined;

		return {
			id: providerWithSecrets.id,
			name: providerWithSecrets.name,
			displayName: providerWithSecrets.displayName,
			baseUrl: normalizeOpenAICompatibleBaseUrl(providerWithSecrets.baseUrl),
			modelName: model.name,
			apiKey: decryptApiKey(
				providerWithSecrets.apiKeyEncrypted,
				providerWithSecrets.apiKeyIv,
			),
			maxOutputTokens:
				typeof model.maxTokens === "number"
					? model.maxTokens
					: undefined,
			reasoningEffort:
				model.reasoningEffort === "low" ||
				model.reasoningEffort === "medium" ||
				model.reasoningEffort === "high" ||
				model.reasoningEffort === "max" ||
				model.reasoningEffort === "xhigh"
					? model.reasoningEffort
					: undefined,
			thinkingType:
				model.thinkingType === "enabled" || model.thinkingType === "disabled"
					? model.thinkingType
					: undefined,
			...(hasMaxModelContext
				? { maxModelContext: model.maxModelContext }
				: {}),
			...(hasExplicitCompaction
				? { compactionUiThreshold: model.compactionUiThreshold }
				: derivedCompactionUiThreshold !== undefined
					? { compactionUiThreshold: derivedCompactionUiThreshold }
					: {}),
			...(hasExplicitTarget
				? { targetConstructedContext: model.targetConstructedContext }
				: derivedTargetConstructedContext !== undefined
					? { targetConstructedContext: derivedTargetConstructedContext }
					: {}),
			...(function () {
				const caps = parseProviderModelCapabilities(
					model.capabilitiesJson,
				);
				return caps ? { capabilities: caps } : {};
			})(),
		};
}

function parseProviderModelCapabilities(json: string): ModelCapabilitySet | undefined {
	if (!json || json === "{}") return undefined;
	try {
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return undefined;

		const entries = MODEL_CAPABILITY_KEYS.filter(
			(key) => key in (parsed as Record<string, unknown>),
		);
		if (entries.length === 0) return undefined;

		return createModelCapabilitySet(
			Object.fromEntries(
				entries.map((key) => [
					key,
					(parsed as Record<string, unknown>)[key],
				]),
			),
		);
	} catch {
		return undefined;
	}
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
		(params.tools
			? buildToolStopWhen(params.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS)
			: undefined);

	const request = {
		model: provider(params.provider.modelName),
		messages: params.messages,
		system: params.system,
		tools: params.tools,
		toolChoice: params.toolChoice,
		stopWhen,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
		maxRetries: params.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES,
		abortSignal: params.abortSignal,
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
		onStepFinish: ({ stepNumber, finishReason, usage }) => {
			console.warn("[NORMAL_CHAT_MODEL] plain step finish", {
				providerId: params.provider.id,
				stepNumber,
				finishReason,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
			});
		},
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
		(params.tools
			? buildToolStopWhen(params.maxToolSteps ?? DEFAULT_MAX_TOOL_STEPS)
			: undefined);
	const buildStreamConfig = (tools?: ToolSet, toolStopWhen?: StopCondition) => ({
		model: provider(params.provider.modelName),
		messages: params.messages,
		system: params.system,
		tools,
		toolChoice: params.toolChoice,
		stopWhen: toolStopWhen,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
		maxRetries: params.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES,
		abortSignal: params.abortSignal,
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
		onError: () => undefined,
		onStepFinish: ({ stepNumber, finishReason, usage }) => {
			console.warn("[NORMAL_CHAT_MODEL] stream step finish", {
				providerId: params.provider.id,
				stepNumber,
				finishReason,
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
			});
		},
	});

	let responseModelName = params.provider.modelName;

	let eventCounts: Record<string, number> = {
		"text-delta": 0,
		"reasoning-delta": 0,
		"tool-call": 0,
		"tool-result": 0,
		"tool-error": 0,
		"finish-step": 0,
		finish: 0,
		usage: 0,
		error: 0,
		other: 0,
	};
	let lastEventType = "";

	const yieldStreamEvents = async function* (
		fullStream: AsyncIterable<unknown>,
	): AsyncGenerator<StreamingNormalChatModelRunEvent, void, undefined> {
		for await (const part of fullStream as AsyncIterable<{
			type: string;
			text?: string;
			toolCallId?: string;
			toolName?: string;
			input?: unknown;
			output?: unknown;
			error?: unknown;
			response?: { modelId: string };
			finishReason?: string;
			rawFinishReason?: string;
			totalUsage?: LanguageModelUsage;
		}>) {
			switch (part.type) {
				case "text-delta":
					eventCounts["text-delta"]++;
					lastEventType = part.type;
					yield { type: "text_delta", text: part.text! };
					break;
				case "reasoning-delta":
					eventCounts["reasoning-delta"]++;
					lastEventType = part.type;
					yield { type: "reasoning_delta", text: part.text! };
					break;
				case "tool-call":
					eventCounts["tool-call"]++;
					lastEventType = part.type;
					yield {
						type: "tool_call",
						callId: part.toolCallId!,
						toolName: part.toolName!,
						input: part.input,
					};
					break;
				case "tool-result":
					eventCounts["tool-result"]++;
					lastEventType = part.type;
					yield {
						type: "tool_result",
						callId: part.toolCallId!,
						toolName: part.toolName!,
						output: part.output,
					};
					break;
				case "tool-error":
					eventCounts["tool-error"]++;
					lastEventType = part.type;
					yield {
						type: "tool_error",
						callId: part.toolCallId!,
						toolName: part.toolName!,
						error: errorMessage(part.error),
					};
					break;
				case "finish-step":
					eventCounts["finish-step"]++;
					lastEventType = part.type;
					responseModelName = part.response.modelId;
					break;
				case "finish":
					eventCounts["finish"]++;
					lastEventType = part.type;
					yield {
						type: "usage",
						usage: mapUsage(part.totalUsage),
					};
					eventCounts["usage"]++;
					console.warn(
						"[DEBUG-diagnose-stream] normal-chat-model finish event",
						{
							providerId: params.provider.id,
							modelName: params.provider.modelName,
							finishReason: part.finishReason,
							rawFinishReason: part.rawFinishReason,
							responseModelName,
							totalUsage: part.totalUsage
								? {
										inputTokens: part.totalUsage.inputTokens,
										outputTokens: part.totalUsage.outputTokens,
										totalTokens: part.totalUsage.totalTokens,
									}
								: null,
							lastEventType,
							eventCounts,
						},
					);
					yield {
						type: "finish",
						finishReason: part.finishReason,
						rawFinishReason: part.rawFinishReason,
						model: modelMetadata(params.provider, responseModelName),
					};
					break;
				case "error":
					eventCounts["error"]++;
					lastEventType = part.type;
					console.warn(
						"[DEBUG-diagnose-stream] normal-chat-model error event",
						{
							providerId: params.provider.id,
							errorMessage: errorMessage(part.error),
							eventCounts,
						},
					);
					yield { type: "error", error: errorMessage(part.error) };
					break;
				default:
					eventCounts["other"]++;
					lastEventType = part.type;
					break;
			}
		}
	};

	try {
		try {
			yield* yieldStreamEvents(
				streamText(buildStreamConfig(params.tools, stopWhen)).fullStream,
			);
		} catch (innerError) {
			if (
				!params.tools ||
				params.toolChoice ||
				!isUnsupportedToolsRequestError(innerError)
			) {
				throw innerError;
			}
			if (isCapabilitySupported(params.provider, "tools")) {
				throw innerError;
			}

			// Reset stream state before retry without tools
			responseModelName = params.provider.modelName;
			eventCounts = {
				"text-delta": 0,
				"reasoning-delta": 0,
				"tool-call": 0,
				"tool-result": 0,
				"tool-error": 0,
				"finish-step": 0,
				finish: 0,
				usage: 0,
				error: 0,
				other: 0,
			};
			lastEventType = "";

			yield* yieldStreamEvents(
				streamText(buildStreamConfig(undefined, undefined)).fullStream,
			);
		}
	} catch (error) {
		console.warn(
			"[DEBUG-diagnose-stream] normal-chat-model stream catch",
			{
				providerId: params.provider.id,
				errorName: error instanceof Error ? error.name : undefined,
				errorMessage: error instanceof Error ? error.message : String(error),
				eventCounts,
				lastEventType,
			},
		);
		yield { type: "error", error: errorMessage(error) };
	}
}
