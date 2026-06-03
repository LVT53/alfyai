import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ModelConfig } from "$lib/server/env";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import {
	type AuthenticatedPromptUser,
	type PromptContextLimits,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	resolveNormalChatModelRunProvider,
	runStreamingNormalChatModelRun,
	type NormalChatModelRunProvider,
	type StreamingNormalChatModelRunEvent,
} from "$lib/server/services/normal-chat-model";
import {
	createNormalChatTools,
} from "$lib/server/services/normal-chat-tools";
import type {
	ContextDebugState,
	ConversationContextStatus,
	HonchoContextInfo,
	HonchoContextSnapshot,
	ModelId,
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
	forceWebSearch?: boolean;
	createTurnId?: () => string;
	signal?: AbortSignal;
	overrideProvider?: NormalChatModelRunProvider;
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
	resolvedProviderId: string;
	stream: AsyncIterable<StreamingNormalChatModelRunEvent>;
	prefetchedToolCalls: ToolCallEntry[];
	getNormalChatToolCalls: () => ToolCallEntry[];
	getToolCalls: () => ToolCallEntry[];
};

export async function runStreamingNormalChatSendModel(
	params: StreamingNormalChatSendModelParams,
): Promise<StreamingNormalChatSendModelResult> {
	const modelId = params.modelId ?? "model1";
	const provider =
		params.overrideProvider ??
		(await resolveNormalChatModelRunProvider(
			modelId,
			params.runtimeConfig,
		));
	const modelConfig = resolvePromptModelConfig({
		modelId,
		provider,
		runtimeConfig: params.runtimeConfig,
	});
	const prepared = await prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		forceWebSearch: params.forceWebSearch,
		modelId,
		contextLimits: resolvePromptContextLimits({
			modelId,
			provider,
			runtimeConfig: params.runtimeConfig,
		}),
		logLabel: "provider streaming request",
	});
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId: params.createTurnId?.() ?? randomUUID(),
	});
	const toolChoice = undefined;
	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const getNormalChatToolCalls = () => normalChatTools.getToolCalls();
	const stream = runStreamingNormalChatModelRun({
		provider,
		system: prepared.systemPrompt,
		providerOptions: buildNormalChatModelRunProviderOptions(
			provider,
			params.thinkingMode,
		),
		abortSignal: createRequestAbortSignal(
			params.runtimeConfig.requestTimeoutMs,
			params.signal,
		),
		maxOutputTokens: prepared.outputTokenBudget?.effectiveMaxTokens,
		tools: normalChatTools.tools,
		toolChoice,
		maxToolSteps: NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: prepared.inputValue }],
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
		resolvedProviderId: provider.id,
		stream,
		prefetchedToolCalls,
		getNormalChatToolCalls,
		getToolCalls: () => [
			...prefetchedToolCalls,
			...getNormalChatToolCalls().filter(isEvidenceReadyToolCall),
		],
	};
}

function isEvidenceReadyToolCall(toolCall: ToolCallEntry): boolean {
	return (
		toolCall.status === "done" &&
		toolCall.metadata?.ok !== false &&
		toolCall.metadata?.evidenceReady !== false
	);
}

function createRequestAbortSignal(
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

function resolvePromptModelConfig(params: {
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
		systemPrompt: params.runtimeConfig.systemPrompt || baseModelConfig.systemPrompt,
		baseUrl: params.provider.baseUrl,
		apiKey: params.provider.apiKey,
		modelName: params.provider.modelName,
		displayName: params.provider.displayName,
		maxTokens:
			params.provider.maxOutputTokens ?? baseModelConfig.maxTokens,
	};
}

function resolvePromptContextLimits(params: {
	modelId: ModelId;
	provider: {
		maxModelContext?: number;
		compactionUiThreshold?: number;
		targetConstructedContext?: number;
	};
	runtimeConfig: RuntimeConfig;
}): PromptContextLimits | undefined {
	if (
		typeof params.provider.maxModelContext === "number" &&
		typeof params.provider.compactionUiThreshold === "number" &&
		typeof params.provider.targetConstructedContext === "number"
	) {
		return {
			maxModelContext: params.provider.maxModelContext,
			compactionUiThreshold: params.provider.compactionUiThreshold,
			targetConstructedContext: params.provider.targetConstructedContext,
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

	return undefined;
}
