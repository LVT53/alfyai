import type { RuntimeConfig } from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import {
	runNormalChatDeliberationPasses,
	shouldRunDeliberationPasses,
} from "$lib/server/services/chat-turn/deliberation-runner";
import {
	type DepthClarificationClassifier,
	evaluateDepthClarificationGate,
} from "$lib/server/services/chat-turn/depth-clarification";
import {
	selectNormalChatToolsForRequest,
	shouldExposeFileProductionTools,
} from "$lib/server/services/chat-turn/normal-chat-tool-gating";
import { resolveReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import { detectLanguage } from "$lib/server/services/language";
import { isMemoryActiveForConversation } from "$lib/server/services/memory-controls";
import { inferModelContextWindow } from "$lib/server/services/model-context";
import type { PromptContextLimits } from "$lib/server/services/normal-chat-context";
import {
	type AuthenticatedPromptUser,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import { createNormalChatContextPreparationActivityHandler } from "$lib/server/services/normal-chat-context-preparation";
import {
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import {
	createNormalChatTools,
	createToolCallRecorder,
} from "$lib/server/services/normal-chat-tools";
import type {
	DepthMetadata,
	ModelId,
	ThinkingMode,
	ToolCallEntry,
} from "$lib/types";
import { deriveModelContextBudget } from "./context-budget";

const UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK = 150_000;

export function isEvidenceReadyToolCall(toolCall: ToolCallEntry): boolean {
	return (
		toolCall.status === "done" &&
		toolCall.metadata?.ok !== false &&
		toolCall.metadata?.evidenceReady !== false
	);
}

export function createRequestAbortSignal(
	timeoutMs: number,
	signal?: AbortSignal,
): AbortSignal | undefined {
	const timeoutSignal =
		Number.isFinite(timeoutMs) && timeoutMs > 0
			? AbortSignal.timeout(timeoutMs)
			: undefined;
	const signals = [signal, timeoutSignal].filter(
		(value): value is AbortSignal => Boolean(value),
	);
	if (signals.length === 0) return undefined;
	if (signals.length === 1) return signals[0];
	return AbortSignal.any(signals);
}

export function resolvePromptModelConfig(params: {
	modelId: ModelId;
	provider: {
		baseUrl: string;
		apiKey: string;
		modelName: string;
		displayName: string;
		maxOutputTokens?: number;
		maxModelContext?: number;
		compactionUiThreshold?: number;
		targetConstructedContext?: number;
	};
	runtimeConfig: RuntimeConfig;
}): ModelConfig {
	const baseModelConfig =
		params.modelId === "model2"
			? params.runtimeConfig.model2
			: params.runtimeConfig.model1;

	if (params.modelId === "model2") return baseModelConfig;
	if (params.modelId === "model1") return baseModelConfig;

	return {
		...baseModelConfig,
		systemPrompt:
			params.runtimeConfig.systemPrompt || baseModelConfig.systemPrompt,
		baseUrl: params.provider.baseUrl,
		apiKey: params.provider.apiKey,
		modelName: params.provider.modelName,
		displayName: params.provider.displayName,
		maxTokens: params.provider.maxOutputTokens ?? baseModelConfig.maxTokens,
	};
}

export function resolvePromptContextLimits(params: {
	modelId: ModelId;
	provider: {
		modelName?: string | null;
		maxModelContext?: number;
		compactionUiThreshold?: number;
		targetConstructedContext?: number;
	};
	runtimeConfig: RuntimeConfig;
}): PromptContextLimits {
	if (
		params.modelId !== "model1" &&
		params.modelId !== "model2" &&
		params.modelId !== undefined
	) {
		const providerBudget = deriveModelContextBudget({
			maxModelContext:
				params.provider.maxModelContext ??
				inferModelContextWindow(params.provider.modelName) ??
				UNKNOWN_PROVIDER_MAX_MODEL_CONTEXT_FALLBACK,
			compactionUiThreshold: params.provider.compactionUiThreshold,
			targetConstructedContext: params.provider.targetConstructedContext,
		});
		return {
			maxModelContext: providerBudget.maxModelContext,
			compactionUiThreshold: providerBudget.compactionUiThreshold,
			targetConstructedContext: providerBudget.targetConstructedContext,
		};
	}

	if (params.modelId === "model1") {
		return {
			maxModelContext: params.runtimeConfig.model1MaxModelContext,
			compactionUiThreshold: params.runtimeConfig.model1CompactionUiThreshold,
			targetConstructedContext:
				params.runtimeConfig.model1TargetConstructedContext,
		};
	}

	if (params.modelId === "model2") {
		return {
			maxModelContext: params.runtimeConfig.model2MaxModelContext,
			compactionUiThreshold: params.runtimeConfig.model2CompactionUiThreshold,
			targetConstructedContext:
				params.runtimeConfig.model2TargetConstructedContext,
		};
	}

	return {
		maxModelContext: params.runtimeConfig.model1MaxModelContext,
		compactionUiThreshold: params.runtimeConfig.model1CompactionUiThreshold,
		targetConstructedContext:
			params.runtimeConfig.model1TargetConstructedContext,
	};
}

// --- Shared send-model param type and helpers (plain + streaming) ---
//
// Both the plain and streaming send-model entry points share the same six-step
// orchestration (provider runtime → clarification → depth effort → outbound
// context → tool pack → deliberation). Those steps live here so they exist
// once (AGENTS.md: "Shared behavior should exist once. Do not copy logic
// between send and stream.").
//
// The two param types differ only in that the PLAIN type carries
// `disableTools` and `forceProduceFileTool` (the streaming path never forces
// `produce_file` tool-choice and never disables tools). Both types are
// assignable to the base type below because those two fields are optional.
// The streaming entry point passes a normalized `{ ...params, disableTools:
// false, forceProduceFileTool: false }` object to the shared helpers so the
// shared code can treat `disableTools`/`forceProduceFileTool` uniformly.

export type NormalChatSendModelBaseParams = {
	userId: string;
	runtimeConfig: RuntimeConfig;
	message: string;
	conversationId: string;
	modelId: ModelId | undefined;
	user?: AuthenticatedPromptUser;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	attachmentTraceId?: string;
	systemPromptAppendix?: string;
	personalityPrompt?: string;
	thinkingMode?: ThinkingMode;
	depthMetadata?: DepthMetadata;
	forceWebSearch?: boolean;
	enabledConnectionCapabilities?: string[];
	createTurnId?: () => string;
	signal?: AbortSignal;
	/** Withhold all tools (memory recall, file-production, connections). Plain-only. */
	disableTools?: boolean;
	/** Force the `produce_file` tool-choice. Plain-only; streaming never forces it. */
	forceProduceFileTool?: boolean;
	depthClarificationClassifier?: DepthClarificationClassifier;
	overrideProvider?: NormalChatModelRunProvider;
	onContextPreparationActivity?: Parameters<
		typeof createNormalChatContextPreparationActivityHandler
	>[0]["onContextPreparationActivity"];
	onResponseActivity?: (
		entry: import("$lib/types").ResponseActivityEntry,
	) => void;
};

export type DepthEffort = Awaited<
	ReturnType<typeof resolveReasoningDepthEffort>
> | null;

export type ClarificationDecision = Awaited<
	ReturnType<typeof evaluateDepthClarificationGate>
>;

export type PreparedModelContext = Awaited<
	ReturnType<typeof prepareOutboundChatContext>
>;

type NormalChatModelTools = Partial<
	ReturnType<typeof createNormalChatTools>["tools"]
>;

export type ProviderRuntime = {
	modelId: ModelId;
	provider: NormalChatModelRunProvider;
	modelConfig: ReturnType<typeof resolvePromptModelConfig>;
	baseContextLimits: NonNullable<ReturnType<typeof resolvePromptContextLimits>>;
	depthEffort: DepthEffort;
};

export type ActiveDepthEffort = NonNullable<DepthEffort> & {
	depthMetadata: DepthMetadata;
};

export type ToolPack = {
	tools: NormalChatModelTools | undefined;
	recorder: ReturnType<typeof createToolCallRecorder>;
	getToolCalls: ReturnType<typeof createNormalChatTools>["getToolCalls"];
};

export async function resolveProviderRuntime(
	params: NormalChatSendModelBaseParams,
): Promise<ProviderRuntime> {
	const modelId = params.modelId ?? "model1";
	const provider =
		params.overrideProvider ??
		(await resolveNormalChatModelRunProvider(modelId, params.runtimeConfig));
	const modelConfig = resolvePromptModelConfig({
		modelId,
		provider,
		runtimeConfig: params.runtimeConfig,
	});
	const baseContextLimits = resolvePromptContextLimits({
		modelId,
		provider,
		runtimeConfig: params.runtimeConfig,
	});
	const depthEffort = params.depthMetadata
		? resolveReasoningDepthEffort({
				depthMetadata: params.depthMetadata,
				provider,
				baseContextLimits,
				configuredMaxOutputTokens: modelConfig.maxTokens,
				forceWebSearch: params.forceWebSearch,
			})
		: null;

	return {
		modelId,
		provider,
		modelConfig,
		baseContextLimits,
		depthEffort,
	};
}

export async function evaluateClarification(
	params: NormalChatSendModelBaseParams,
	depthEffort: DepthEffort,
): Promise<ClarificationDecision> {
	return evaluateDepthClarificationGate({
		message: params.message,
		depthMetadata: depthEffort?.depthMetadata ?? params.depthMetadata,
		classifier: params.depthClarificationClassifier,
	});
}

export function resolveActiveDepthEffort(
	depthEffort: DepthEffort,
	clarification: ClarificationDecision,
): ActiveDepthEffort | null {
	return depthEffort
		? {
				...depthEffort,
				depthMetadata: clarification.depthMetadata ?? depthEffort.depthMetadata,
			}
		: null;
}

export async function prepareOutboundContext(
	params: NormalChatSendModelBaseParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ActiveDepthEffort | null,
	enabledConnectionCapabilities: Set<Capability>,
	logLabel = "provider request",
): Promise<PreparedModelContext> {
	return prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: activeDepthEffort
			? {
					...runtime.modelConfig,
					maxTokens: activeDepthEffort.modelMaxOutputTokens,
				}
			: runtime.modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		forceWebSearch: params.forceWebSearch,
		fileProductionToolsAvailable:
			!params.disableTools &&
			shouldExposeFileProductionTools({
				message: params.message,
				forceProduceFileTool: params.forceProduceFileTool,
			}),
		modelId: runtime.modelId,
		contextLimits:
			activeDepthEffort?.contextLimits ?? runtime.baseContextLimits,
		reasoningDepthEffort: activeDepthEffort ?? undefined,
		activeConnectionCapabilities: enabledConnectionCapabilities,
		onContextPreparationActivity:
			createNormalChatContextPreparationActivityHandler(params),
		logLabel,
	});
}

export async function createToolPack(
	params: NormalChatSendModelBaseParams,
	turnId: string,
	activeDepthEffort: ActiveDepthEffort | null,
	modelId: ModelId,
	enabledConnectionCapabilities: Set<Capability>,
): Promise<ToolPack> {
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		language: detectLanguage(params.message),
		enabledConnectionCapabilities,
		modelId,
		...(activeDepthEffort
			? { webSourceBudget: activeDepthEffort.webSourceBudget }
			: {}),
	});

	// Read-side master gate for the recall tool. Single source of truth; fail
	// open (active) so a controls-lookup hiccup never silently drops recall.
	const memoryActive = params.disableTools
		? false
		: await isMemoryActiveForConversation({
				userId: params.userId,
				conversationId: params.conversationId,
			}).catch(() => true);

	return {
		tools: params.disableTools
			? undefined
			: selectNormalChatToolsForRequest(normalChatTools.tools, {
					message: params.message,
					forceProduceFileTool: params.forceProduceFileTool,
					memoryActive,
				}),
		recorder: normalChatTools.recorder ?? createToolCallRecorder(),
		getToolCalls: normalChatTools.getToolCalls,
	};
}

export async function runDeliberationIfNeeded(
	params: NormalChatSendModelBaseParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ActiveDepthEffort | null,
	prepared: PreparedModelContext,
	turnId: string,
	recorder: ReturnType<typeof createToolCallRecorder>,
) {
	if (!activeDepthEffort || params.disableTools) return null;
	if (!shouldRunDeliberationPasses(activeDepthEffort)) return null;

	return runNormalChatDeliberationPasses({
		userId: params.userId,
		conversationId: params.conversationId,
		modelId: runtime.modelId,
		runtimeConfig: params.runtimeConfig,
		provider: runtime.provider,
		depthEffort: activeDepthEffort,
		preparedInputValue: prepared.inputValue,
		preparedSystemPrompt: prepared.systemPrompt,
		user: params.user,
		language: detectLanguage(params.message),
		turnId,
		recorder,
		onStatus: params.onResponseActivity,
		abortSignal: createRequestAbortSignal(
			params.runtimeConfig.requestTimeoutMs,
			params.signal,
		),
	});
}
