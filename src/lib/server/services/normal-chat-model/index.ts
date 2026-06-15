import {
	APICallError,
	type FinishReason,
	generateText,
	hasToolCall,
	type InvalidToolInputError,
	type LanguageModelUsage,
	type ModelMessage,
	NoSuchToolError,
	type OnStepFinishEvent,
	type StopCondition,
	stepCountIs,
	streamText,
	type TextStreamPart,
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
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import { repairMalformedToolCallJson } from "$lib/server/utils/tool-json-repair";
import type { ModelId, ThinkingMode } from "$lib/types";
import type { ProviderUsageSnapshot } from "../analytics";
import { DEFAULT_MODEL_MAX_RETRIES } from "../normal-chat-model-config";
import { normalizeOpenAICompatibleBaseUrl } from "../openai-compatible-url";
import { resolveProviderModelRuntimeDefaults } from "../provider-model-runtime-defaults";
import { listEnabledProviderModels } from "../provider-models";
import {
	decryptApiKey,
	getProviderByName,
	getProviderWithSecrets,
} from "../providers";
import {
	isRetryableNormalChatFallbackError,
	resolveNormalChatFallbackTargetModelId,
} from "./failover";
import { createOpenAICompatibleProviderForNormalChatModelRun } from "./openai-compatible-provider";
import { buildNormalChatModelRunCompatibilityProviderOptions } from "./provider-compatibility";

export {
	createOpenAICompatibleProviderForNormalChatModelRun,
	type NormalChatOpenAICompatibleProviderConfig,
} from "./openai-compatible-provider";

const DEFAULT_MAX_TOOL_STEPS = 20;
const DONE_TOOL_NAME = "done";
type NormalChatModelRunProviderOptions = NonNullable<
	Parameters<typeof generateText>[0]["providerOptions"]
>;

function toolCallRepairFunction({
	error,
	toolCall,
}: {
	error: InvalidToolInputError | NoSuchToolError;
	toolCall: { toolCallId: string; toolName: string; input: string };
}): Promise<{
	type: "tool-call";
	toolCallId: string;
	toolName: string;
	input: string;
} | null> {
	if (NoSuchToolError.isInstance(error)) return Promise.resolve(null);
	const repaired = repairMalformedToolCallJson(toolCall.input);
	if (!repaired) return Promise.resolve(null);
	return Promise.resolve({ type: "tool-call", ...toolCall, input: repaired });
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
			const recentToolCalls = recent.flatMap((s) => s.toolCalls ?? []);
			const uniqueArgs = new Set(
				recentToolCalls.map((tc) => JSON.stringify(tc.input ?? {})),
			);
			if (uniqueArgs.size === 1) {
				return true;
			}
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
				last3.every((v, i) => i === 0 || v <= last3[i - 1] * 0.5)
			) {
				return true;
			}
		}

		return false;
	};
}

function buildToolStopWhen(maxToolSteps: number): StopCondition<ToolSet>[] {
	return [
		hasToolCall(DONE_TOOL_NAME),
		stagnantProgress(),
		stepCountIs(maxToolSteps),
	];
}

function readDoneToolSummary(input: unknown): string | null {
	if (!input || typeof input !== "object" || Array.isArray(input)) return null;
	const summary = (input as Record<string, unknown>).summary;
	if (typeof summary !== "string") return null;
	const trimmed = summary.trim();
	return trimmed ? trimmed : null;
}

function extractDoneToolSummaryFromCalls(toolCalls: unknown): string | null {
	if (!Array.isArray(toolCalls)) return null;
	for (const toolCall of toolCalls) {
		if (!toolCall || typeof toolCall !== "object" || Array.isArray(toolCall)) {
			continue;
		}
		const record = toolCall as Record<string, unknown>;
		if (record.toolName !== DONE_TOOL_NAME) continue;
		const summary = readDoneToolSummary(record.input);
		if (summary) return summary;
	}
	return null;
}

function extractDoneToolSummary(result: unknown): string | null {
	if (!result || typeof result !== "object" || Array.isArray(result))
		return null;
	const record = result as Record<string, unknown>;

	const topLevelSummary = extractDoneToolSummaryFromCalls(record.toolCalls);
	if (topLevelSummary) return topLevelSummary;

	if (!Array.isArray(record.steps)) return null;
	for (const step of record.steps) {
		if (!step || typeof step !== "object" || Array.isArray(step)) continue;
		const summary = extractDoneToolSummaryFromCalls(
			(step as Record<string, unknown>).toolCalls,
		);
		if (summary) return summary;
	}
	return null;
}

type NormalChatReasoningEffort = NonNullable<ModelConfig["reasoningEffort"]>;
type NormalChatThinkingType = NonNullable<ModelConfig["thinkingType"]>;

export type NormalChatModelRunProvider = {
	id: string;
	modelId?: ModelId;
	name: string;
	displayName: string;
	baseUrl: string;
	modelName: string;
	apiKey: string;
	requestTimeoutMs?: number;
	maxOutputTokens?: number;
	maxModelContext?: number;
	compactionUiThreshold?: number;
	targetConstructedContext?: number;
	reasoningEffort?: NormalChatReasoningEffort;
	thinkingType?: NormalChatThinkingType;
	capabilities?: ModelCapabilitySet;
	iconUrl?: string | null;
};

type BuiltinNormalChatModelConfig = Pick<
	ModelConfig,
	| "baseUrl"
	| "apiKey"
	| "modelName"
	| "displayName"
	| "maxTokens"
	| "reasoningEffort"
	| "thinkingType"
>;

type NormalChatModelRunRuntimeConfig = {
	model1: BuiltinNormalChatModelConfig;
	model2: BuiltinNormalChatModelConfig;
};

export type NormalChatModelRunBaseParams = {
	provider: NormalChatModelRunProvider;
	modelId?: ModelId;
	runtimeConfig?: RuntimeConfig;
	messages: ModelMessage[];
	system?: string;
	headers?: Record<string, string | undefined>;
	providerOptions?: NormalChatModelRunProviderOptions;
	resolveProviderOptions?: (
		provider: NormalChatModelRunProvider,
	) => NormalChatModelRunProviderOptions | undefined;
	abortSignal?: AbortSignal;
	fetch?: typeof fetch;
	maxRetries?: number;
	maxOutputTokens?: number | null;
};

export type PlainNormalChatModelRunParams = NormalChatModelRunBaseParams & {
	tools?: ToolSet;
	toolChoice?: ToolChoice<ToolSet>;
	maxToolSteps?: number;
	stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
};

export type StreamingNormalChatModelRunParams = NormalChatModelRunBaseParams & {
	tools?: ToolSet;
	toolChoice?: ToolChoice<ToolSet>;
	maxToolSteps?: number;
	stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
	firstOutputTimeoutMs?: number | null;
	deliberationElapsedMs?: number;
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
		modelId: string;
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
	modelId: string;
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

	const newProvider = await resolveBuiltinFromNewProvidersTable(modelId);
	if (newProvider) return newProvider;

	throw new Error(`Normal Chat Model Run provider not found: ${modelId}`);
}

async function resolveBuiltinFromNewProvidersTable(
	name: string,
): Promise<NormalChatModelRunProvider | null> {
	// Handle composite ID format: provider:<provider-uuid>:<model-uuid>
	const providerModelIdParts = name.startsWith("provider:")
		? name.split(":")
		: null;
	if (providerModelIdParts && providerModelIdParts.length >= 3) {
		const providerId = providerModelIdParts[1];
		const modelId = providerModelIdParts[2];
		const provider = await getProviderWithSecrets(providerId);
		if (provider?.enabled) {
			const models = await listEnabledProviderModels(provider.id);
			const model = models.find((m) => m.id === modelId);
			if (!model) return null;
			return buildProviderModelRunConfig(
				provider,
				model,
				providerModelRunId(provider.id, model),
			);
		}
		return null;
	}

	if (providerModelIdParts && providerModelIdParts.length === 2) {
		const providerId = providerModelIdParts[1];
		const provider = await getProviderWithSecrets(providerId);
		if (provider?.enabled) {
			const models = await listEnabledProviderModels(provider.id);
			const model = models[0];
			if (!model) return null;

			return buildProviderModelRunConfig(provider, model, name as ModelId);
		}
	}

	// Legacy format: provider:<provider-name> or bare name
	const provider = await getProviderByName(name);
	if (!provider?.enabled) return null;

	const models = await listEnabledProviderModels(provider.id);
	const model = models[0];
	if (!model) return null;

	const providerWithSecrets = await getProviderWithSecrets(provider.id);
	if (!providerWithSecrets) return null;

	return buildProviderModelRunConfig(
		providerWithSecrets,
		model,
		providerModelRunId(providerWithSecrets.id, model),
	);
}

function providerModelRunId(
	providerId: string,
	model: Awaited<ReturnType<typeof listEnabledProviderModels>>[number],
): ModelId {
	return model.id
		? (`provider:${providerId}:${model.id}` as ModelId)
		: (`provider:${providerId}` as ModelId);
}

function buildProviderModelRunConfig(
	providerWithSecrets: NonNullable<
		Awaited<ReturnType<typeof getProviderWithSecrets>>
	>,
	model: Awaited<ReturnType<typeof listEnabledProviderModels>>[number],
	modelId?: ModelId,
): NormalChatModelRunProvider {
	const runtimeDefaults = resolveProviderModelRuntimeDefaults(model);

	return {
		id: providerWithSecrets.id,
		...(modelId ? { modelId } : {}),
		name: providerWithSecrets.name,
		displayName: model.displayName ?? providerWithSecrets.displayName,
		iconUrl: providerWithSecrets.iconAssetId
			? `/api/campaign-assets/${encodeURIComponent(
					providerWithSecrets.iconAssetId,
				)}/content`
			: null,
		baseUrl: normalizeOpenAICompatibleBaseUrl(providerWithSecrets.baseUrl),
		modelName: model.name,
		apiKey: decryptApiKey(
			providerWithSecrets.apiKeyEncrypted,
			providerWithSecrets.apiKeyIv,
		),
		...runtimeDefaults,
		...(() => {
			const caps = parseProviderModelCapabilities(model.capabilitiesJson);
			return caps ? { capabilities: caps } : {};
		})(),
	};
}

function parseProviderModelCapabilities(
	json: string,
): ModelCapabilitySet | undefined {
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
				entries.map((key) => [key, (parsed as Record<string, unknown>)[key]]),
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
		modelId,
		name: modelId,
		displayName: modelConfig.displayName,
		baseUrl: normalizeOpenAICompatibleBaseUrl(modelConfig.baseUrl),
		modelName: modelConfig.modelName,
		apiKey: modelConfig.apiKey,
		maxOutputTokens:
			typeof modelConfig.maxTokens === "number"
				? modelConfig.maxTokens
				: undefined,
		...(modelConfig.reasoningEffort
			? { reasoningEffort: modelConfig.reasoningEffort }
			: {}),
		...(modelConfig.thinkingType
			? { thinkingType: modelConfig.thinkingType }
			: {}),
	};
}

export function buildNormalChatModelRunProviderOptions(
	provider: NormalChatModelRunProvider,
	thinkingMode: ThinkingMode | undefined,
): NormalChatModelRunProviderOptions | undefined {
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
	return createOpenAICompatibleProviderForNormalChatModelRun({
		provider: params.provider,
		fetch: params.fetch,
		includeUsage: !isCapabilityUnsupported(params.provider, "usageReporting"),
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
	modelId = provider.modelId ?? provider.id,
): NormalChatModelRunModelMetadata {
	return {
		modelId,
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

function combineAbortSignals(
	...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined {
	const activeSignals = signals.filter((signal): signal is AbortSignal =>
		Boolean(signal),
	);
	if (activeSignals.length === 0) return undefined;
	if (activeSignals.length === 1) return activeSignals[0];
	return AbortSignal.any(activeSignals);
}

function createProviderAttemptAbortSignal(params: {
	abortSignal?: AbortSignal;
	provider: NormalChatModelRunProvider;
}): AbortSignal | undefined {
	const timeoutSignal =
		typeof params.provider.requestTimeoutMs === "number" &&
		Number.isFinite(params.provider.requestTimeoutMs) &&
		params.provider.requestTimeoutMs > 0
			? AbortSignal.timeout(params.provider.requestTimeoutMs)
			: undefined;
	return combineAbortSignals(params.abortSignal, timeoutSignal);
}

function createFirstOutputTimeoutError(): Error {
	return new Error("Timed out waiting for first visible upstream output");
}

function createModelAttemptTimeoutError(): Error {
	return new Error(
		"Provider request timed out before configured failover threshold",
	);
}

async function resolveFirstOutputTimeoutMs(
	params: StreamingNormalChatModelRunParams,
	currentModelId: string,
	allowFallbackAttempt: boolean,
): Promise<number | null> {
	if (!allowFallbackAttempt) return null;

	const extraMs = Math.max(0, params.deliberationElapsedMs ?? 0);
	if (params.firstOutputTimeoutMs !== undefined) {
		if (params.firstOutputTimeoutMs === null) return null;
		const effective = params.firstOutputTimeoutMs + extraMs;
		if (!params.runtimeConfig || effective <= 0) return effective;
		const resolved = Math.min(params.runtimeConfig.requestTimeoutMs, effective);
		console.warn("[NORMAL_CHAT_MODEL] first-output timeout adjusted", {
			baseMs: params.firstOutputTimeoutMs,
			extraMs,
			resolvedMs: resolved,
			modelId: currentModelId,
		});
		return resolved;
	}
	if (!params.runtimeConfig) return null;
	const fallbackTarget = await resolveNormalChatFallbackTargetModelId(
		currentModelId as ModelId,
		params.runtimeConfig,
	);
	if (!fallbackTarget) return null;
	const effective = Math.max(1000, params.runtimeConfig.modelTimeoutFailoverTimeoutMs) + extraMs;
	const resolved = Math.min(params.runtimeConfig.requestTimeoutMs, effective);
	console.warn("[NORMAL_CHAT_MODEL] first-output timeout adjusted", {
		baseMs: Math.max(1000, params.runtimeConfig.modelTimeoutFailoverTimeoutMs),
		extraMs,
		resolvedMs: resolved,
		modelId: currentModelId,
	});
	return resolved;
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
	let currentProvider = params.provider;
	const originalModelId =
		params.modelId ?? params.provider.modelId ?? params.provider.id;
	let currentModelId = originalModelId;
	let attemptedFallback = false;

	for (;;) {
		const runtimeConfig = params.runtimeConfig;
		const fallbackTarget =
			runtimeConfig && !attemptedFallback
				? await resolveNormalChatFallbackTargetModelId(
						currentModelId as ModelId,
						runtimeConfig,
					)
				: null;
		const shouldArmAttemptTimeout =
			Boolean(runtimeConfig) &&
			currentModelId === originalModelId &&
			!attemptedFallback &&
			fallbackTarget !== null;
		const attemptTimeoutMs = runtimeConfig
			? Math.min(
					runtimeConfig.requestTimeoutMs,
					Math.max(1000, runtimeConfig.modelTimeoutFailoverTimeoutMs),
				)
			: 0;
		const attemptTimeoutController = shouldArmAttemptTimeout
			? new AbortController()
			: null;
		let attemptTimedOut = false;
		const attemptTimeoutId = attemptTimeoutController
			? setTimeout(() => {
					attemptTimedOut = true;
					attemptTimeoutController.abort(createModelAttemptTimeoutError());
				}, attemptTimeoutMs)
			: null;
		attemptTimeoutId?.unref?.();
		const attemptParams = {
			...params,
			provider: currentProvider,
			modelId: currentModelId as ModelId,
			abortSignal: combineAbortSignals(
				params.abortSignal,
				attemptTimeoutController?.signal,
			),
			providerOptions: resolveProviderOptionsForAttempt(
				params,
				currentProvider,
			),
		};

		try {
			return await runPlainNormalChatModelRunAttempt(attemptParams);
		} catch (error) {
			const retryableError = attemptTimedOut
				? createModelAttemptTimeoutError()
				: error;
			if (params.abortSignal?.aborted && !attemptTimedOut) {
				throw error;
			}

			if (
				currentModelId === originalModelId &&
				!attemptedFallback &&
				params.runtimeConfig &&
				isRetryableNormalChatFallbackError(retryableError)
			) {
				const fallbackModelId = await resolveNormalChatFallbackTargetModelId(
					currentModelId as ModelId,
					params.runtimeConfig,
				);
				if (fallbackModelId) {
					currentProvider = await resolveNormalChatModelRunProvider(
						fallbackModelId,
						params.runtimeConfig,
					);
					currentModelId = fallbackModelId;
					attemptedFallback = true;
					continue;
				}
			}

			throw error;
		} finally {
			if (attemptTimeoutId) clearTimeout(attemptTimeoutId);
		}
	}
}

function resolveProviderOptionsForAttempt(
	params: Pick<
		NormalChatModelRunBaseParams,
		"provider" | "providerOptions" | "resolveProviderOptions"
	>,
	provider: NormalChatModelRunProvider,
): NormalChatModelRunProviderOptions | undefined {
	const resolved = params.resolveProviderOptions?.(provider);
	if (resolved !== undefined) return resolved;
	return provider === params.provider ? params.providerOptions : undefined;
}

async function runPlainNormalChatModelRunAttempt(
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
		abortSignal: createProviderAttemptAbortSignal(params),
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
		onStepFinish: ({
			stepNumber,
			finishReason,
			usage,
		}: OnStepFinishEvent<ToolSet>) => {
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
		text: result.text || extractDoneToolSummary(result) || "",
		finishReason: result.finishReason,
		usage: mapUsage(result.usage),
		model: modelMetadata(
			params.provider,
			result.response.modelId,
			params.modelId ?? params.provider.modelId ?? params.provider.id,
		),
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

	return streamStreamingNormalChatModelRunWithFailover(params);
}

function hasEmittedRetryBoundaryEvent(
	event: StreamingNormalChatModelRunEvent,
): boolean {
	return (
		event.type === "text_delta" ||
		event.type === "reasoning_delta" ||
		event.type === "tool_call" ||
		event.type === "tool_result" ||
		event.type === "tool_error"
	);
}

async function* streamStreamingNormalChatModelRunWithFailover(
	params: StreamingNormalChatModelRunParams,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	let currentProvider = params.provider;
	const originalModelId =
		params.modelId ?? params.provider.modelId ?? params.provider.id;
	let currentModelId = originalModelId;
	let attemptedFallback = false;

	attemptLoop: for (;;) {
		const firstOutputTimeoutMs = await resolveFirstOutputTimeoutMs(
			params,
			currentModelId,
			currentModelId === originalModelId && !attemptedFallback,
		);
		const timeoutMs = firstOutputTimeoutMs ?? 0;
		const attemptAbortController = timeoutMs > 0 ? new AbortController() : null;
		let firstOutputTimedOut = false;
		const firstOutputTimeoutId = attemptAbortController
			? setTimeout(() => {
					firstOutputTimedOut = true;
					attemptAbortController.abort(createFirstOutputTimeoutError());
				}, timeoutMs)
			: null;
		firstOutputTimeoutId?.unref?.();
		const clearFirstOutputTimeout = () => {
			if (!firstOutputTimeoutId) return;
			clearTimeout(firstOutputTimeoutId);
		};
		const attemptParams = {
			...params,
			provider: currentProvider,
			modelId: currentModelId as ModelId,
			abortSignal: combineAbortSignals(
				params.abortSignal,
				attemptAbortController?.signal,
			),
			providerOptions: resolveProviderOptionsForAttempt(
				params,
				currentProvider,
			),
		};
		let hasEmittedRetryBoundary = false;

		try {
			assertNormalChatModelRunCapabilities({
				provider: currentProvider,
				streaming: true,
				tools: params.tools,
			});

			for await (const event of streamStreamingNormalChatModelRunAttempt(
				attemptParams,
			)) {
				if (event.type === "error") {
					if (params.abortSignal?.aborted || hasEmittedRetryBoundary) {
						yield event;
						return;
					}

					const upstreamError = firstOutputTimedOut
						? createFirstOutputTimeoutError()
						: new Error(event.error);
					const retry = await resolveNormalChatFallbackProvider({
						error: upstreamError,
						currentModelId,
						runtimeConfig: params.runtimeConfig,
						allowFallbackAttempt:
							currentModelId === originalModelId && !attemptedFallback,
					});
					if (retry) {
						currentProvider = retry.provider;
						currentModelId = retry.modelId;
						attemptedFallback = true;
						continue attemptLoop;
					}

					yield event;
					return;
				}

				if (hasEmittedRetryBoundaryEvent(event)) {
					hasEmittedRetryBoundary = true;
					clearFirstOutputTimeout();
				}
				yield event;
			}
			if (firstOutputTimedOut) {
				const upstreamError = createFirstOutputTimeoutError();
				const retry = await resolveNormalChatFallbackProvider({
					error: upstreamError,
					currentModelId,
					runtimeConfig: params.runtimeConfig,
					allowFallbackAttempt:
						currentModelId === originalModelId && !attemptedFallback,
				});
				if (retry) {
					currentProvider = retry.provider;
					currentModelId = retry.modelId;
					attemptedFallback = true;
					continue;
				}
				yield { type: "error", error: upstreamError.message };
			}
			return;
		} catch (error) {
			const terminalError = firstOutputTimedOut
				? createFirstOutputTimeoutError()
				: error;
			if (params.abortSignal?.aborted || hasEmittedRetryBoundary) {
				yield { type: "error", error: errorMessage(terminalError) };
				return;
			}

			const retry = await resolveNormalChatFallbackProvider({
				error: terminalError,
				currentModelId,
				runtimeConfig: params.runtimeConfig,
				allowFallbackAttempt:
					currentModelId === originalModelId && !attemptedFallback,
			});
			if (retry) {
				currentProvider = retry.provider;
				currentModelId = retry.modelId;
				attemptedFallback = true;
				continue;
			}

			yield { type: "error", error: errorMessage(terminalError) };
			return;
		} finally {
			clearFirstOutputTimeout();
		}
	}
}

async function resolveNormalChatFallbackProvider(params: {
	error: unknown;
	currentModelId: string;
	runtimeConfig?: RuntimeConfig;
	allowFallbackAttempt: boolean;
}): Promise<{
	provider: NormalChatModelRunProvider;
	modelId: string;
} | null> {
	if (!params.allowFallbackAttempt || !params.runtimeConfig) return null;
	if (!isRetryableNormalChatFallbackError(params.error)) return null;

	const fallbackModelId = await resolveNormalChatFallbackTargetModelId(
		params.currentModelId as ModelId,
		params.runtimeConfig,
	);
	if (!fallbackModelId || fallbackModelId === params.currentModelId) return null;

	const provider = await resolveNormalChatModelRunProvider(
		fallbackModelId,
		params.runtimeConfig,
	);

	return {
		provider,
		modelId: fallbackModelId,
	};
}

async function* streamStreamingNormalChatModelRunAttempt(
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
	const buildStreamConfig = (
		tools?: ToolSet,
		toolStopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>,
	) => ({
		model: provider(params.provider.modelName),
		messages: params.messages,
		system: params.system,
		tools,
		toolChoice: params.toolChoice,
		stopWhen: toolStopWhen,
		maxOutputTokens: params.maxOutputTokens ?? params.provider.maxOutputTokens,
		maxRetries: params.maxRetries ?? DEFAULT_MODEL_MAX_RETRIES,
		abortSignal: createProviderAttemptAbortSignal(params),
		headers: params.headers,
		providerOptions: params.providerOptions,
		experimental_repairToolCall: toolCallRepairFunction,
		onError: () => undefined,
		onStepFinish: ({
			stepNumber,
			finishReason,
			usage,
		}: OnStepFinishEvent<ToolSet>) => {
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

	const yieldStreamEvents = async function* (
		fullStream: AsyncIterable<TextStreamPart<ToolSet>>,
	): AsyncGenerator<StreamingNormalChatModelRunEvent, void, undefined> {
		for await (const part of fullStream) {
			switch (part.type) {
				case "text-delta":
					if (typeof part.text === "string") {
						yield { type: "text_delta", text: part.text };
					}
					break;
				case "reasoning-delta":
					if (typeof part.text === "string") {
						yield { type: "reasoning_delta", text: part.text };
					}
					break;
				case "tool-call":
					if (part.toolName === DONE_TOOL_NAME) {
						const summary = readDoneToolSummary(part.input);
						if (summary) {
							yield { type: "text_delta", text: summary };
						}
						break;
					}
					if (
						typeof part.toolCallId !== "string" ||
						typeof part.toolName !== "string"
					) {
						break;
					}
					yield {
						type: "tool_call",
						callId: part.toolCallId,
						toolName: part.toolName,
						input: part.input,
					};
					break;
				case "tool-result":
					if (part.toolName === DONE_TOOL_NAME) break;
					if (
						typeof part.toolCallId !== "string" ||
						typeof part.toolName !== "string"
					) {
						break;
					}
					yield {
						type: "tool_result",
						callId: part.toolCallId,
						toolName: part.toolName,
						output: part.output,
					};
					break;
				case "tool-error":
					if (part.toolName === DONE_TOOL_NAME) break;
					if (
						typeof part.toolCallId !== "string" ||
						typeof part.toolName !== "string"
					) {
						break;
					}
					yield {
						type: "tool_error",
						callId: part.toolCallId,
						toolName: part.toolName,
						error: errorMessage(part.error),
					};
					break;
				case "finish-step":
					if (
						part.response &&
						typeof part.response === "object" &&
						"modelId" in part.response &&
						typeof part.response.modelId === "string"
					) {
						responseModelName = part.response.modelId;
					}
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
						model: modelMetadata(
							params.provider,
							responseModelName,
							params.modelId ?? params.provider.modelId ?? params.provider.id,
						),
					};
					break;
				case "error":
					yield { type: "error", error: errorMessage(part.error) };
					break;
				default:
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

			yield* yieldStreamEvents(
				streamText(buildStreamConfig(undefined, undefined)).fullStream,
			);
		}
	} catch (error) {
		yield { type: "error", error: errorMessage(error) };
	}
}
