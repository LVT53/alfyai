import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ThinkingMode } from "$lib/reasoning-depth-types";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { buildReasoningDepthProviderOptions } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import {
	type ActiveDepthEffort,
	createRequestAbortSignal,
	createToolPack,
	estimateTurnPromptTokens,
	isEvidenceReadyToolCall,
	type NormalChatSendModelBaseParams,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveForcedResearchWebFirstStepToolChoice,
	resolveProviderRuntime,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import type { Capability } from "$lib/server/services/connections/registry";
import { resolveActiveCapabilities } from "$lib/server/services/connections/resolve";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import type { AuthenticatedPromptUser } from "$lib/server/services/normal-chat-context";
import { appendTurnGuidance } from "$lib/server/services/normal-chat-context";
import type { NormalChatContextPreparationStageTiming } from "$lib/server/services/normal-chat-context-preparation";
import {
	buildNormalChatModelRunProviderOptions,
	runStreamingNormalChatModelRun,
	type StreamingNormalChatModelRunEvent,
} from "$lib/server/services/normal-chat-model";
import type { TaskState } from "$lib/server/services/task-state/types";
import { logOutboundMessageShape } from "./outbound-debug";

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
	pendingSkillInstructions?: string | null;
	personalityPrompt?: string;
	thinkingMode?: ThinkingMode;
	depthMetadata?: DepthMetadata;
	forceWebSearch?: boolean;
	enabledConnectionCapabilities?: string[];
	createTurnId?: () => string;
	signal?: AbortSignal;
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
	// Full-prompt estimate (system prompt + final packet + tool schemas) for
	// the context usage ring when the provider reports no input tokens.
	estimatedPromptTokens?: number;
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
	// shared helpers read `disableTools`/`forceProduceFileTool` off the
	// params, so we pass them explicitly as `false` here. With both false the
	// shared helpers behave exactly as the old inline streaming code did:
	// memory recall is always resolved, tools are always selected, and
	// produce_file is never force-selected.
	const baseParams: NormalChatSendModelBaseParams = {
		...params,
		disableTools: false,
		forceProduceFileTool: false,
	};

	const runtime = await resolveProviderRuntime(baseParams);
	const activeDepthEffort: ActiveDepthEffort | null = resolveActiveDepthEffort(
		runtime.depthEffort,
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

	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const getNormalChatToolCalls = () => toolPack.getToolCalls();
	const finalInputValue = appendTurnGuidance(
		prepared.inputValue,
		prepared.turnGuidance,
	);
	const outboundMessages: ModelMessage[] = [
		...(prepared.historyMessages ?? []),
		{ role: "user", content: [{ type: "text", text: finalInputValue }] },
		...(prepared.prefetchedToolMessages ?? []),
	];
	logOutboundMessageShape({
		label: "stream",
		systemPrompt: prepared.systemPrompt,
		messages: outboundMessages,
		toolCount: toolPack.tools ? Object.keys(toolPack.tools).length : 0,
	});

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
		firstStepToolChoice: resolveForcedResearchWebFirstStepToolChoice({
			forceWebSearch: params.forceWebSearch,
			tools: toolPack.tools,
		}),
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: outboundMessages,
	});

	return {
		prepared: {
			contextStatus: prepared.contextStatus,
			taskState: prepared.taskState,
			contextDebug: prepared.contextDebug,
			contextTraceSections: prepared.contextTraceSections,
			contextPreparationTimings: prepared.contextPreparationTimings,
			estimatedPromptTokens: estimateTurnPromptTokens({
				prepared,
				inputValue: finalInputValue,
				tools: toolPack.tools,
			}),
		},
		modelId: runtime.modelId,
		modelDisplayName: runtime.provider.displayName,
		providerIconUrl: runtime.provider.iconUrl ?? null,
		resolvedProviderId: runtime.provider.id,
		stream,
		prefetchedToolCalls,
		getNormalChatToolCalls,
		getToolCalls: () => [
			...prefetchedToolCalls,
			...getNormalChatToolCalls().filter(isEvidenceReadyToolCall),
		],
		depthMetadata: activeDepthEffort?.depthMetadata,
	};
}
