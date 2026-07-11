import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import {
	appendDeliberationBriefsToInput,
	sumUsage,
} from "$lib/server/services/chat-turn/deliberation-runner";
import {
	buildReasoningDepthProviderOptions,
	withReasoningDepthPreparedBudget,
} from "$lib/server/services/chat-turn/reasoning-depth-effort";
import {
	type ActiveDepthEffort,
	createRequestAbortSignal,
	createToolPack,
	evaluateClarification,
	isEvidenceReadyToolCall,
	type NormalChatSendModelBaseParams,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveProviderRuntime,
	runDeliberationIfNeeded,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import type { Capability } from "$lib/server/services/connections/registry";
import { resolveActiveCapabilities } from "$lib/server/services/connections/resolve";
import type { AuthenticatedPromptUser } from "$lib/server/services/normal-chat-context";
import type { NormalChatContextPreparationStageTiming } from "$lib/server/services/normal-chat-context-preparation";
import {
	buildNormalChatModelRunProviderOptions,
	runStreamingNormalChatModelRun,
	type StreamingNormalChatModelRunEvent,
} from "$lib/server/services/normal-chat-model";
import type {
	ContextDebugState,
	ConversationContextStatus,
	DepthMetadata,
	ModelId,
	ResponseActivityEntry,
	TaskState,
	ThinkingMode,
	ToolCallEntry,
} from "$lib/types";

export type StreamingNormalChatSendModelParams = {
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
	depthClarificationClassifier?: Parameters<
		typeof evaluateClarification
	>[0]["depthClarificationClassifier"];
	overrideProvider?: Parameters<
		typeof resolveProviderRuntime
	>[0]["overrideProvider"];
	onContextPreparationActivity?: Parameters<
		typeof prepareOutboundContext
	>[0]["onContextPreparationActivity"];
	onResponseActivity?: (entry: ResponseActivityEntry) => void;
};

export type StreamingNormalChatPreparedContext = {
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
};

export type StreamingNormalChatSendModelResult = {
	prepared: StreamingNormalChatPreparedContext;
	modelId: ModelId;
	modelDisplayName: string;
	providerIconUrl?: string | null;
	resolvedProviderId: string;
	stream: AsyncIterable<StreamingNormalChatModelRunEvent>;
	prefetchedToolCalls: ToolCallEntry[];
	getNormalChatToolCalls: () => ToolCallEntry[];
	getToolCalls: () => ToolCallEntry[];
	depthMetadata?: DepthMetadata;
};

export async function runStreamingNormalChatSendModel(
	params: StreamingNormalChatSendModelParams,
): Promise<StreamingNormalChatSendModelResult> {
	// The streaming path never disables tools and never auto-forces the
	// `produce_file` tool-choice (it leaves tool choice automatic — see the
	// "leaves tool choice automatic for explicit file requests" test). The
	// shared six-step helpers read `disableTools`/`forceProduceFileTool` off
	// the params, so we pass them explicitly as `false` here. With both false
	// the shared helpers behave exactly as the old inline streaming code did:
	// memory recall is always resolved, tools are always selected, and
	// produce_file is never force-selected.
	const baseParams: NormalChatSendModelBaseParams = {
		...params,
		disableTools: false,
		forceProduceFileTool: false,
	};

	const runtime = await resolveProviderRuntime(baseParams);
	const clarification = await evaluateClarification(
		baseParams,
		runtime.depthEffort,
	);

	if (clarification.action === "ask") {
		const emptyPrepared: StreamingNormalChatPreparedContext = {};
		return {
			prepared: emptyPrepared,
			modelId: runtime.modelId,
			modelDisplayName: runtime.provider.displayName,
			providerIconUrl: runtime.provider.iconUrl ?? null,
			resolvedProviderId: runtime.provider.id,
			stream: createSyntheticTextStream(clarification.text),
			prefetchedToolCalls: [],
			getNormalChatToolCalls: () => [],
			getToolCalls: () => [],
			depthMetadata: clarification.depthMetadata,
		};
	}

	const activeDepthEffort: ActiveDepthEffort | null = resolveActiveDepthEffort(
		runtime.depthEffort,
		clarification,
	);
	// Resolved ONCE, ahead of context prep (Issue 8.1) — it used to only be
	// resolved later, right before createNormalChatTools, which meant
	// prepareOutboundChatContext had no way to know the turn's active
	// capabilities and the proactive_connector_context stage could never gate
	// on them. Fail closed on error, same posture as the try/catch this
	// replaced: a connections-lookup hiccup should never block the turn, just
	// mean no connection-backed tools/context this turn.
	const enabledConnectionCapabilities = await resolveActiveCapabilities(
		params.userId,
		params.enabledConnectionCapabilities,
	).catch(() => new Set<Capability>());
	const prepared = await prepareOutboundContext(
		baseParams,
		runtime,
		activeDepthEffort,
		enabledConnectionCapabilities,
		"provider streaming request",
	);
	const turnId = params.createTurnId?.() ?? randomUUID();
	const toolPack = await createToolPack(
		baseParams,
		turnId,
		activeDepthEffort,
		runtime.modelId,
		enabledConnectionCapabilities,
	);
	// Streaming surfaces how long the deliberation pass took (plain does not).
	// The shared helper does not time itself, so capture the elapsed ms here.
	const deliberationStartMs = Date.now();
	const deliberation = await runDeliberationIfNeeded(
		baseParams,
		runtime,
		activeDepthEffort,
		prepared,
		turnId,
		toolPack.recorder,
	);
	const deliberationElapsedMs =
		deliberation !== null ? Date.now() - deliberationStartMs : 0;

	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const getNormalChatToolCalls = () => toolPack.getToolCalls();
	const assumptionPrefix =
		clarification.action === "proceed"
			? clarification.assumptionPrefix
			: undefined;
	const deliberationUsage = deliberation?.usage ?? {
		inputTokens: undefined,
		outputTokens: undefined,
		totalTokens: undefined,
	};
	const finalInputValue = appendDeliberationBriefsToInput(
		prepared.inputValue,
		deliberation?.briefs ?? [],
	);
	const stream = runStreamingNormalChatModelRun({
		provider: runtime.provider,
		modelId: runtime.modelId,
		runtimeConfig: params.runtimeConfig,
		system: prepared.systemPrompt,
		resolveProviderOptions: (attemptProvider) =>
			activeDepthEffort
				? buildReasoningDepthProviderOptions(attemptProvider, activeDepthEffort)
				: buildNormalChatModelRunProviderOptions(
						attemptProvider,
						params.thinkingMode,
					),
		abortSignal: createRequestAbortSignal(
			params.runtimeConfig.requestTimeoutMs,
			params.signal,
		),
		maxOutputTokens: prepared.outputTokenBudget?.effectiveMaxTokens,
		tools: toolPack.tools,
		toolChoice: undefined,
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: finalInputValue }],
			},
		],
		deliberationElapsedMs,
	});

	return {
		prepared: {
			contextStatus: prepared.contextStatus,
			taskState: prepared.taskState,
			contextDebug: prepared.contextDebug,
			contextTraceSections: prepared.contextTraceSections,
			contextPreparationTimings: prepared.contextPreparationTimings,
		},
		modelId: runtime.modelId,
		modelDisplayName: runtime.provider.displayName,
		providerIconUrl: runtime.provider.iconUrl ?? null,
		resolvedProviderId: runtime.provider.id,
		stream: withOptionalAssumptionPrefix(
			deliberation ? withDeliberationUsage(stream, deliberationUsage) : stream,
			assumptionPrefix,
		),
		prefetchedToolCalls,
		getNormalChatToolCalls,
		getToolCalls: () => [
			...prefetchedToolCalls,
			...getNormalChatToolCalls().filter(isEvidenceReadyToolCall),
		],
		depthMetadata: activeDepthEffort
			? withReasoningDepthPreparedBudget(
					{
						...activeDepthEffort,
						depthMetadata:
							deliberation?.depthMetadata ?? activeDepthEffort.depthMetadata,
					},
					prepared.outputTokenBudget,
				)
			: clarification.depthMetadata,
	};
}

async function* createSyntheticTextStream(
	text: string,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	yield { type: "text_delta", text };
	yield {
		type: "finish",
		finishReason: "stop",
		rawFinishReason: undefined,
		model: {
			modelId: "clarification",
			providerId: "clarification",
			providerName: "clarification",
			displayName: "Clarification",
			requestedModelName: "clarification",
			responseModelName: "clarification",
		},
	};
}

async function* withOptionalAssumptionPrefix(
	stream: AsyncIterable<StreamingNormalChatModelRunEvent>,
	assumptionPrefix?: string,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	if (assumptionPrefix) {
		yield { type: "text_delta", text: `${assumptionPrefix}\n\n` };
	}
	yield* stream;
}

async function* withDeliberationUsage(
	stream: AsyncIterable<StreamingNormalChatModelRunEvent>,
	deliberationUsage: {
		inputTokens: number | undefined;
		outputTokens: number | undefined;
		totalTokens: number | undefined;
	},
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	for await (const event of stream) {
		if (event.type === "usage") {
			yield {
				...event,
				usage: sumUsage(deliberationUsage, event.usage),
			};
			continue;
		}
		yield event;
	}
}
