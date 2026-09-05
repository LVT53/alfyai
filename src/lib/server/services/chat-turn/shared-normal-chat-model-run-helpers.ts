import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import { getConfig, type RuntimeConfig } from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import {
	runNormalChatDeliberationPasses,
	shouldRunDeliberationPasses,
} from "$lib/server/services/chat-turn/deliberation-runner";
import {
	type DepthClarificationClassifier,
	evaluateDepthClarificationGate,
} from "$lib/server/services/chat-turn/depth-clarification";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	selectNormalChatToolsForRequest,
	shouldExposeFileProductionTools,
} from "$lib/server/services/chat-turn/normal-chat-tool-gating";
import { resolveReasoningDepthEffort } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import type { Capability } from "$lib/server/services/connections/registry";
import { detectLanguage } from "$lib/server/services/language";
import { isMemoryActiveForConversation } from "$lib/server/services/memory-controls";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import {
	type AuthenticatedPromptUser,
	estimateOutboundPromptTokenTotal,
	type PromptContextLimits,
	prepareOutboundChatContext,
	resolvePromptContextLimits,
} from "$lib/server/services/normal-chat-context";
import { createNormalChatContextPreparationActivityHandler } from "$lib/server/services/normal-chat-context-preparation";
import {
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import { resolveHistoryToolMessagesMode } from "$lib/server/services/normal-chat-model/provider-compatibility";
import {
	createNormalChatTools,
	createToolCallRecorder,
} from "$lib/server/services/normal-chat-tools";
import { estimateTokenCount } from "$lib/utils/tokens";
import {
	estimateHistoryMessagesTokens,
	renderHistoryAsText,
} from "./conversation-history";

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

/**
 * Count of tool schemas that will ride the provider request. Feeds the
 * fallback prompt-size estimate used by the context usage ring when the
 * provider reports no input tokens.
 */
export function countToolPackTools(tools: ToolPack["tools"]): number {
	return tools ? Object.keys(tools).length : 0;
}

/**
 * Full-prompt estimate for a turn (system prompt + final outbound packet +
 * tool schemas). Computed once the outbound context and tool pack are final,
 * so it reflects everything the provider actually receives that we can see.
 */
export function estimateTurnPromptTokens(params: {
	prepared: PreparedModelContext;
	inputValue: string;
	tools: ToolPack["tools"];
}): number {
	return (
		estimateOutboundPromptTokenTotal({
			systemPrompt: params.prepared.systemPrompt,
			inputValue: params.inputValue,
			toolCount: countToolPackTools(params.tools),
		}) +
		estimateHistoryMessagesTokens(
			params.prepared.historyMessages ?? [],
			estimateTokenCount,
		)
	);
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
	// Messages appended after the current user turn (a non-streaming
	// continuation replays the interrupted attempt's tool calls/results here).
	continuationMessages?: ModelMessage[];
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
		entry: import("$lib/response-activity-types").ResponseActivityEntry,
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
	baseContextLimits: PromptContextLimits;
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
	// The model's configured max output tokens and context limits are passed
	// through untouched: reasoning depth never shrinks the output reserve or
	// the constructed-context target (those are fixed per model). Depth only
	// reaches context prep via `reasoningDepthEffort` (guidance + tool budget).
	return prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: runtime.modelConfig,
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
		contextLimits: runtime.baseContextLimits,
		reasoningDepthEffort: activeDepthEffort ?? undefined,
		activeConnectionCapabilities: enabledConnectionCapabilities,
		historyToolMessages: resolveHistoryToolMessagesMode(runtime.provider),
		onContextPreparationActivity:
			createNormalChatContextPreparationActivityHandler(params),
		logLabel,
	});
}

// Deliberation passes are JSON control calls that take a single string; give
// them the native history as flat text so their briefs see the conversation.
function withHistoryForControlCalls(prepared: PreparedModelContext): string {
	const history = prepared.historyMessages ?? [];
	if (history.length === 0) return prepared.inputValue;
	return [
		"## Conversation so far",
		renderHistoryAsText(history),
		prepared.inputValue,
	].join("\n\n");
}

// Ready on-demand routing regions, for the map_route description. Fails open
// (no label) so a region-manager hiccup never blocks a turn.
async function resolveRoutingCoverageLabel(): Promise<string | null> {
	if (!getConfig().routingOnDemandEnabled) return null;
	try {
		const { getRoutingRegionManager } = await import(
			"$lib/server/services/routing/region-runtime"
		);
		const ready = await getRoutingRegionManager().listReadyRegions();
		return ready.length > 0
			? ready.map((row) => row.name).join(", ")
			: "none yet";
	} catch {
		return null;
	}
}

export async function createToolPack(
	params: NormalChatSendModelBaseParams,
	turnId: string,
	activeDepthEffort: ActiveDepthEffort | null,
	modelId: ModelId,
	enabledConnectionCapabilities: Set<Capability>,
): Promise<ToolPack> {
	const routingCoverageLabel = await resolveRoutingCoverageLabel();
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		language: detectLanguage(params.message),
		enabledConnectionCapabilities,
		modelId,
		...(routingCoverageLabel ? { routingCoverageLabel } : {}),
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
		preparedInputValue: withHistoryForControlCalls(prepared),
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
