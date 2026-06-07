import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import {
	appendDeliberationBriefsToInput,
	runNormalChatDeliberationPasses,
	shouldRunDeliberationPasses,
	sumUsage,
} from "$lib/server/services/chat-turn/deliberation-runner";
import {
	type DepthClarificationClassifier,
	evaluateDepthClarificationGate,
} from "$lib/server/services/chat-turn/depth-clarification";
import {
	buildReasoningDepthProviderOptions,
	resolveReasoningDepthEffort,
	withReasoningDepthPreparedBudget,
} from "$lib/server/services/chat-turn/reasoning-depth-effort";
import {
	createRequestAbortSignal,
	isEvidenceReadyToolCall,
	resolvePromptContextLimits,
	resolvePromptModelConfig,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import { detectLanguage } from "$lib/server/services/language";
import {
	type AuthenticatedPromptUser,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
	runStreamingNormalChatModelRun,
	type StreamingNormalChatModelRunEvent,
} from "$lib/server/services/normal-chat-model";
import {
	createNormalChatTools,
	createToolCallRecorder,
} from "$lib/server/services/normal-chat-tools";
import type {
	ContextDebugState,
	ConversationContextStatus,
	DepthMetadata,
	HonchoContextInfo,
	HonchoContextSnapshot,
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
	createTurnId?: () => string;
	signal?: AbortSignal;
	depthClarificationClassifier?: DepthClarificationClassifier;
	overrideProvider?: NormalChatModelRunProvider;
	onResponseActivity?: (entry: ResponseActivityEntry) => void;
};

export type StreamingNormalChatPreparedContext = {
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
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
	const clarificationGate = await evaluateDepthClarificationGate({
		message: params.message,
		depthMetadata: depthEffort?.depthMetadata ?? params.depthMetadata,
		classifier: params.depthClarificationClassifier,
	});
	if (clarificationGate.action === "ask") {
		return {
			prepared: {},
			modelId,
			modelDisplayName: provider.displayName,
			providerIconUrl: provider.iconUrl ?? null,
			resolvedProviderId: provider.id,
			stream: createSyntheticTextStream(clarificationGate.text),
			prefetchedToolCalls: [],
			getNormalChatToolCalls: () => [],
			getToolCalls: () => [],
			depthMetadata: clarificationGate.depthMetadata,
		};
	}
	const activeDepthEffort = depthEffort
		? {
				...depthEffort,
				depthMetadata:
					clarificationGate.depthMetadata ?? depthEffort.depthMetadata,
			}
		: null;
	const prepared = await prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: activeDepthEffort
			? { ...modelConfig, maxTokens: activeDepthEffort.modelMaxOutputTokens }
			: modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		forceWebSearch: params.forceWebSearch,
		modelId,
		contextLimits: activeDepthEffort?.contextLimits ?? baseContextLimits,
		reasoningDepthEffort: activeDepthEffort ?? undefined,
		logLabel: "provider streaming request",
	});
	const turnId = params.createTurnId?.() ?? randomUUID();
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		language: detectLanguage(params.message),
		...(activeDepthEffort
			? { webSourceBudget: activeDepthEffort.webSourceBudget }
			: {}),
	});
	const recorder = normalChatTools.recorder ?? createToolCallRecorder();
	const deliberation =
		activeDepthEffort && shouldRunDeliberationPasses(activeDepthEffort)
			? await runNormalChatDeliberationPasses({
					userId: params.userId,
					conversationId: params.conversationId,
					modelId,
					runtimeConfig: params.runtimeConfig,
					provider,
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
				})
			: null;
	const toolChoice = undefined;
	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const getNormalChatToolCalls = () => normalChatTools.getToolCalls();
	const finalInputValue = appendDeliberationBriefsToInput(
		prepared.inputValue,
		deliberation?.briefs ?? [],
	);
	const stream = runStreamingNormalChatModelRun({
		provider,
		modelId,
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
		tools: normalChatTools.tools,
		toolChoice,
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: finalInputValue }],
			},
		],
	});

	return {
		prepared: {
			contextStatus: prepared.contextStatus,
			taskState: prepared.taskState,
			contextDebug: prepared.contextDebug,
			honchoContext: prepared.honchoContext,
			honchoSnapshot: prepared.honchoSnapshot,
			contextTraceSections: prepared.contextTraceSections,
		},
		modelId,
		modelDisplayName: provider.displayName,
		providerIconUrl: provider.iconUrl ?? null,
		resolvedProviderId: provider.id,
		stream: withOptionalAssumptionPrefix(
			deliberation ? withDeliberationUsage(stream, deliberation.usage) : stream,
			clarificationGate.assumptionPrefix,
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
			: clarificationGate.depthMetadata,
	};
}

async function* createSyntheticTextStream(
	text: string,
): AsyncIterable<StreamingNormalChatModelRunEvent> {
	yield { type: "text_delta", text };
	yield { type: "finish", finishReason: "stop" };
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
		inputTokens?: number;
		outputTokens?: number;
		totalTokens?: number;
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
