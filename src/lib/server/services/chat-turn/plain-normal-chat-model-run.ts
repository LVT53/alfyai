import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import {
	type AuthenticatedPromptUser,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	resolveNormalChatModelRunProvider,
	runPlainNormalChatModelRun,
	type NormalChatModelRunProvider,
} from "$lib/server/services/normal-chat-model";
import {
	createNormalChatTools,
} from "$lib/server/services/normal-chat-tools";
import { detectLanguage } from "$lib/server/services/language";
import {
	createRequestAbortSignal,
	isEvidenceReadyToolCall,
	resolvePromptContextLimits,
	resolvePromptModelConfig,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
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
	forceWebSearch?: boolean;
	createTurnId?: () => string;
	signal?: AbortSignal;
	disableTools?: boolean;
	forceProduceFileTool?: boolean;
	overrideProvider?: NormalChatModelRunProvider;
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
};

export async function runPlainNormalChatSendModel(
	params: PlainNormalChatSendModelParams,
): Promise<PlainNormalChatSendModelResult> {
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
		logLabel: "provider request",
	});
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId: params.createTurnId?.() ?? randomUUID(),
		language: detectLanguage(params.message),
	});
	const toolChoice = params.forceProduceFileTool
		? ({ type: "tool", toolName: "produce_file" } as const)
		: undefined;
	const tools = params.disableTools ? undefined : normalChatTools.tools;
	const result = await runPlainNormalChatModelRun({
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
		tools,
		toolChoice: tools ? toolChoice : undefined,
		maxToolSteps: NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: prepared.inputValue }],
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
		providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(result.usage),
		prefetchedToolCalls: prepared.prefetchedToolCalls,
		normalChatToolCalls,
		toolCalls,
		modelId,
		modelDisplayName: result.model.displayName,
		resolvedProviderId: provider.id,
	};
}
