import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import {
	createRequestAbortSignal,
	isEvidenceReadyToolCall,
	resolvePromptContextLimits,
	resolvePromptModelConfig,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import {
	appendDeliberationBriefsToInput,
	runNormalChatDeliberationPasses,
	shouldRunDeliberationPasses,
	sumUsage,
} from "$lib/server/services/chat-turn/deliberation-runner";
import {
	buildReasoningDepthProviderOptions,
	resolveReasoningDepthEffort,
	withReasoningDepthPreparedBudget,
} from "$lib/server/services/chat-turn/reasoning-depth-effort";
import { detectLanguage } from "$lib/server/services/language";
import {
	type AuthenticatedPromptUser,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	type NormalChatModelRunProvider,
	resolveNormalChatModelRunProvider,
	runPlainNormalChatModelRun,
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
	TaskState,
	ThinkingMode,
	ToolCallEntry,
} from "$lib/types";

export type PlainNormalChatSendModelParams = {
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
	disableTools?: boolean;
	forceProduceFileTool?: boolean;
	overrideProvider?: NormalChatModelRunProvider;
	onResponseActivity?: (entry: import("$lib/types").ResponseActivityEntry) => void;
};

export type PlainNormalChatSendModelResult = {
	text: string;
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	providerUsage?: ProviderUsageSnapshot | null;
	prefetchedToolCalls?: ToolCallEntry[];
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId: ModelId;
	modelDisplayName: string;
	resolvedProviderId: string;
	depthMetadata?: DepthMetadata;
};

export async function runPlainNormalChatSendModel(
	params: PlainNormalChatSendModelParams,
): Promise<PlainNormalChatSendModelResult> {
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
	const prepared = await prepareOutboundChatContext({
		message: params.message,
		sessionId: params.conversationId,
		modelConfig: depthEffort
			? { ...modelConfig, maxTokens: depthEffort.modelMaxOutputTokens }
			: modelConfig,
		user: params.user,
		attachmentIds: params.attachmentIds,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		attachmentTraceId: params.attachmentTraceId,
		systemPromptAppendix: params.systemPromptAppendix,
		personalityPrompt: params.personalityPrompt,
		forceWebSearch: params.forceWebSearch,
		modelId,
		contextLimits: depthEffort?.contextLimits ?? baseContextLimits,
		reasoningDepthEffort: depthEffort ?? undefined,
		logLabel: "provider request",
	});
	const turnId = params.createTurnId?.() ?? randomUUID();
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		language: detectLanguage(params.message),
		...(depthEffort ? { webSourceBudget: depthEffort.webSourceBudget } : {}),
	});
	const recorder = normalChatTools.recorder ?? createToolCallRecorder();
	const deliberation =
		depthEffort && !params.disableTools && shouldRunDeliberationPasses(depthEffort)
				? await runNormalChatDeliberationPasses({
						userId: params.userId,
						conversationId: params.conversationId,
						modelId,
						runtimeConfig: params.runtimeConfig,
						provider,
						depthEffort,
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
	const toolChoice = params.forceProduceFileTool
		? ({ type: "tool", toolName: "produce_file" } as const)
		: undefined;
	const tools = params.disableTools ? undefined : normalChatTools.tools;
	const finalInputValue = appendDeliberationBriefsToInput(
		prepared.inputValue,
		deliberation?.briefs ?? [],
	);
	const result = await runPlainNormalChatModelRun({
		provider,
		modelId,
		runtimeConfig: params.runtimeConfig,
		system: prepared.systemPrompt,
		resolveProviderOptions: (attemptProvider) =>
			depthEffort
				? buildReasoningDepthProviderOptions(attemptProvider, depthEffort)
				: buildNormalChatModelRunProviderOptions(
						attemptProvider,
						params.thinkingMode,
					),
		abortSignal: createRequestAbortSignal(
			params.runtimeConfig.requestTimeoutMs,
			params.signal,
		),
		maxOutputTokens: prepared.outputTokenBudget?.effectiveMaxTokens,
		tools,
		toolChoice: tools ? toolChoice : undefined,
		maxToolSteps: depthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: finalInputValue }],
			},
		],
	});
	const normalChatToolCalls = normalChatTools.getToolCalls();
	const evidenceReadyNormalChatToolCalls = normalChatToolCalls.filter(
		isEvidenceReadyToolCall,
	);
	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const toolCalls = [
		...prefetchedToolCalls,
		...evidenceReadyNormalChatToolCalls,
	];

	return {
		text: result.text,
		contextStatus: prepared.contextStatus,
		taskState: prepared.taskState,
		contextDebug: prepared.contextDebug,
		honchoContext: prepared.honchoContext,
		honchoSnapshot: prepared.honchoSnapshot,
		contextTraceSections: prepared.contextTraceSections,
		providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(
			sumUsage(deliberation?.usage ?? {}, result.usage),
		),
		prefetchedToolCalls: prepared.prefetchedToolCalls,
		normalChatToolCalls,
		toolCalls,
		modelId: result.model.modelId as ModelId,
		modelDisplayName: result.model.displayName,
		resolvedProviderId: result.model.providerId,
		depthMetadata: depthEffort
			? withReasoningDepthPreparedBudget(
					{
						...depthEffort,
						depthMetadata: deliberation?.depthMetadata ?? depthEffort.depthMetadata,
					},
					prepared.outputTokenBudget,
				)
			: params.depthMetadata,
	};
}
