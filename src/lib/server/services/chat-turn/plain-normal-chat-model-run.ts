import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
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
	type PreparedModelContext,
	type ProviderRuntime,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveForcedResearchWebFirstStepToolChoice,
	resolveProviderRuntime,
	type ToolPack,
} from "$lib/server/services/chat-turn/shared-normal-chat-model-run-helpers";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import type { Capability } from "$lib/server/services/connections/registry";
import { resolveActiveCapabilities } from "$lib/server/services/connections/resolve";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { ToolCallEntry } from "$lib/server/services/messages-types";
import { appendTurnGuidance } from "$lib/server/services/normal-chat-context";
import type { NormalChatContextPreparationStageTiming } from "$lib/server/services/normal-chat-context-preparation";
import {
	buildNormalChatModelRunProviderOptions,
	mapNormalChatModelRunUsageToProviderSnapshot,
	runPlainNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";
import type { TaskState } from "$lib/server/services/task-state/types";
import { logOutboundMessageShape } from "./outbound-debug";

export type PlainNormalChatSendModelParams = NormalChatSendModelBaseParams & {
	// disableTools / forceProduceFileTool are inherited from the base type;
	// they are plain-only options but typed on the shared base so the shared
	// helpers can read them uniformly.
};

export type PlainNormalChatSendModelResult = {
	text: string;
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
	providerUsage?: ProviderUsageSnapshot | null;
	// Full-prompt estimate (system prompt + final packet + tool schemas) for
	// the context usage ring when the provider reports no input tokens.
	estimatedPromptTokens?: number;
	prefetchedToolCalls?: ToolCallEntry[];
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId: ModelId;
	modelDisplayName: string;
	resolvedProviderId: string;
	depthMetadata?: DepthMetadata;
};

type ModelRunParams = {
	params: PlainNormalChatSendModelParams;
	runtime: ProviderRuntime;
	prepared: PreparedModelContext;
	activeDepthEffort: ActiveDepthEffort | null;
	tools: ToolPack["tools"];
};

type BuildResultInput = {
	params: PlainNormalChatSendModelParams;
	runtime: ProviderRuntime;
	prepared: PreparedModelContext;
	activeDepthEffort: ActiveDepthEffort | null;
	result: Awaited<ReturnType<typeof runPlainNormalChatModelRun>>;
	toolPack: ToolPack;
};

export async function runPlainNormalChatSendModel(
	params: PlainNormalChatSendModelParams,
): Promise<PlainNormalChatSendModelResult> {
	const runtime = await resolveProviderRuntime(params);
	const activeDepthEffort = resolveActiveDepthEffort(runtime.depthEffort);
	// Resolved ONCE, ahead of context prep (Issue 8.1) — it used to only be
	// resolved later, inside createToolPack, which meant
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
		params,
		runtime,
		activeDepthEffort,
		enabledConnectionCapabilities,
	);
	const turnId = params.createTurnId?.() ?? randomUUID();
	const toolPack = await createToolPack(
		params,
		turnId,
		activeDepthEffort,
		runtime.modelId,
		enabledConnectionCapabilities,
	);
	const result = await runPlainModelRun({
		params,
		runtime,
		prepared,
		activeDepthEffort,
		tools: toolPack.tools,
	});

	return buildRunResult({
		params,
		runtime,
		prepared,
		activeDepthEffort,
		result,
		toolPack,
	});
}

async function runPlainModelRun(params: ModelRunParams) {
	const {
		params: modelRunParams,
		runtime,
		prepared,
		activeDepthEffort,
		tools,
	} = params;

	const finalInputValue = appendTurnGuidance(
		prepared.inputValue,
		prepared.turnGuidance,
	);
	const outboundMessages: ModelMessage[] = [
		...(prepared.historyMessages ?? []),
		{ role: "user", content: [{ type: "text", text: finalInputValue }] },
		...(prepared.prefetchedToolMessages ?? []),
		...(modelRunParams.continuationMessages ?? []),
	];
	logOutboundMessageShape({
		label: "plain",
		systemPrompt: prepared.systemPrompt,
		messages: outboundMessages,
		toolCount: tools ? Object.keys(tools).length : 0,
	});

	const toolChoice = modelRunParams.forceProduceFileTool
		? ({ type: "tool", toolName: "produce_file" } as const)
		: undefined;
	// produce_file forcing (above) already pins tool choice for the whole run;
	// a forced-search turn only forces the FIRST step (see
	// resolveForcedResearchWebFirstStepToolChoice), so the two are mutually
	// exclusive rather than combined.
	const firstStepToolChoice = modelRunParams.forceProduceFileTool
		? undefined
		: resolveForcedResearchWebFirstStepToolChoice({
				forceWebSearch: modelRunParams.forceWebSearch,
				tools,
			});

	return runPlainNormalChatModelRun({
		provider: runtime.provider,
		modelId: runtime.modelId,
		runtimeConfig: modelRunParams.runtimeConfig,
		system: prepared.systemPrompt,
		resolveProviderOptions: (attemptProvider) =>
			activeDepthEffort
				? buildReasoningDepthProviderOptions(attemptProvider, activeDepthEffort)
				: buildNormalChatModelRunProviderOptions(
						attemptProvider,
						modelRunParams.thinkingMode,
					),
		abortSignal: createRequestAbortSignal(
			modelRunParams.runtimeConfig.requestTimeoutMs,
			modelRunParams.signal,
		),
		maxOutputTokens: prepared.outputTokenBudget?.effectiveMaxTokens,
		tools,
		toolChoice: tools ? toolChoice : undefined,
		firstStepToolChoice: tools ? firstStepToolChoice : undefined,
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: outboundMessages,
	});
}

function buildRunResult(
	input: BuildResultInput,
): PlainNormalChatSendModelResult {
	const { prepared, activeDepthEffort, result, toolPack } = input;

	const normalChatToolCalls = toolPack.getToolCalls
		? toolPack.getToolCalls()
		: [];
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
		contextTraceSections: prepared.contextTraceSections,
		contextPreparationTimings: prepared.contextPreparationTimings,
		providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(result.usage),
		estimatedPromptTokens: estimateTurnPromptTokens({
			prepared,
			inputValue: appendTurnGuidance(
				prepared.inputValue,
				prepared.turnGuidance,
			),
			tools: toolPack.tools,
		}),
		prefetchedToolCalls: prepared.prefetchedToolCalls,
		normalChatToolCalls,
		toolCalls,
		modelId: result.model.modelId as ModelId,
		modelDisplayName: result.model.displayName,
		resolvedProviderId: result.model.providerId,
		depthMetadata: activeDepthEffort?.depthMetadata,
	};
}
