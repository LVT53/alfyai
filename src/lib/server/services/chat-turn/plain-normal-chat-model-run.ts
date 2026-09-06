import { randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import type { ModelId } from "$lib/model-types";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import {
	appendDeliberationBriefsToInput,
	sumUsage,
	verifyAndRepairDeliberatedFinalAnswer,
} from "$lib/server/services/chat-turn/deliberation-runner";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { buildReasoningDepthProviderOptions } from "$lib/server/services/chat-turn/reasoning-depth-effort";
import {
	type ActiveDepthEffort,
	type ClarificationDecision,
	createRequestAbortSignal,
	createToolPack,
	estimateTurnPromptTokens,
	evaluateClarification,
	isEvidenceReadyToolCall,
	type NormalChatSendModelBaseParams,
	type PreparedModelContext,
	type ProviderRuntime,
	prepareOutboundContext,
	resolveActiveDepthEffort,
	resolveForcedResearchWebFirstStepToolChoice,
	resolveProviderRuntime,
	runDeliberationIfNeeded,
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
	type NormalChatModelRunProvider,
	runPlainNormalChatModelRun,
} from "$lib/server/services/normal-chat-model";
import type { TaskState } from "$lib/server/services/task-state/types";
import { logOutboundMessageShape } from "./outbound-debug";

export type PlainNormalChatSendModelParams = NormalChatSendModelBaseParams & {
	// disableTools / forceProduceFileTool are inherited from the base type;
	// they are plain-only options but typed on the shared base so the shared
	// six-step helpers can read them uniformly.
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
	deliberation: Awaited<ReturnType<typeof runDeliberationIfNeeded>>;
	tools: ToolPack["tools"];
};

type BuildResultInput = {
	params: PlainNormalChatSendModelParams;
	clarification: ClarificationDecision;
	runtime: ProviderRuntime;
	prepared: PreparedModelContext;
	activeDepthEffort: ActiveDepthEffort | null;
	result: Awaited<ReturnType<typeof runPlainNormalChatModelRun>>;
	deliberation: Awaited<ReturnType<typeof runDeliberationIfNeeded>>;
	finalAnswerRepair: Awaited<ReturnType<typeof maybeRepairFinalAnswer>>;
	toolPack: ToolPack;
};

export async function runPlainNormalChatSendModel(
	params: PlainNormalChatSendModelParams,
): Promise<PlainNormalChatSendModelResult> {
	const runtime = await resolveProviderRuntime(params);
	const clarification = await evaluateClarification(
		params,
		runtime.depthEffort,
	);

	if (clarification.action === "ask") {
		return buildClarificationResult(runtime, clarification);
	}

	const activeDepthEffort = resolveActiveDepthEffort(
		runtime.depthEffort,
		clarification,
	);
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
	const deliberation = await runDeliberationIfNeeded(
		params,
		runtime,
		activeDepthEffort,
		prepared,
		turnId,
		toolPack.recorder,
	);
	const result = await runPlainModelRun({
		params,
		runtime,
		prepared,
		activeDepthEffort,
		deliberation,
		tools: toolPack.tools,
	});
	const finalAnswerRepair = await maybeRepairFinalAnswer(
		result,
		params,
		prepared,
		runtime.provider,
		activeDepthEffort,
		deliberation,
	);

	return buildRunResult({
		params,
		clarification,
		runtime,
		prepared,
		activeDepthEffort,
		result,
		deliberation,
		finalAnswerRepair,
		toolPack,
	});
}

function buildClarificationResult(
	runtime: ProviderRuntime,
	clarification: ClarificationDecision,
): Pick<
	PlainNormalChatSendModelResult,
	| "text"
	| "contextStatus"
	| "taskState"
	| "contextDebug"
	| "contextTraceSections"
	| "providerUsage"
	| "prefetchedToolCalls"
	| "normalChatToolCalls"
	| "toolCalls"
	| "modelId"
	| "modelDisplayName"
	| "resolvedProviderId"
	| "depthMetadata"
> {
	return {
		text: clarification.action === "ask" ? clarification.text : "",
		contextStatus: undefined,
		taskState: null,
		contextDebug: null,
		contextTraceSections: [],
		providerUsage: null,
		prefetchedToolCalls: [],
		normalChatToolCalls: [],
		toolCalls: [],
		modelId: runtime.modelId,
		modelDisplayName: runtime.provider.displayName,
		resolvedProviderId: runtime.provider.id,
		depthMetadata: clarification.depthMetadata,
	};
}

async function runPlainModelRun(params: ModelRunParams) {
	const {
		params: modelRunParams,
		runtime,
		prepared,
		activeDepthEffort,
		deliberation,
		tools,
	} = params;

	const finalInputValue = appendTurnGuidance(
		appendDeliberationBriefsToInput(
			prepared.inputValue,
			deliberation?.briefs ?? [],
		),
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

async function maybeRepairFinalAnswer(
	result: Awaited<ReturnType<typeof runPlainNormalChatModelRun>>,
	params: PlainNormalChatSendModelParams,
	prepared: PreparedModelContext,
	runtimeProvider: NormalChatModelRunProvider,
	activeDepthEffort: ActiveDepthEffort | null,
	deliberation: Awaited<ReturnType<typeof runDeliberationIfNeeded>>,
) {
	if (!deliberation || !activeDepthEffort) return null;

	return verifyAndRepairDeliberatedFinalAnswer({
		text: result.text,
		originalUserMessage: params.message,
		systemPrompt: prepared.systemPrompt,
		briefs: deliberation.briefs,
		provider: runtimeProvider,
		modelId: params.modelId ?? "model1",
		runtimeConfig: params.runtimeConfig,
		depthEffort: activeDepthEffort,
		abortSignal: createRequestAbortSignal(
			params.runtimeConfig.requestTimeoutMs,
			params.signal,
		),
	});
}

function buildRunResult(
	input: BuildResultInput,
): PlainNormalChatSendModelResult {
	const {
		clarification,
		prepared,
		activeDepthEffort,
		result,
		deliberation,
		finalAnswerRepair,
		toolPack,
	} = input;

	const deliberationUsage = deliberation?.usage ?? {
		inputTokens: undefined,
		outputTokens: undefined,
		totalTokens: undefined,
	};
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
	const assumptionPrefix =
		clarification.action === "proceed"
			? clarification.assumptionPrefix
			: undefined;

	return {
		text: assumptionPrefix
			? `${assumptionPrefix}\n\n${finalAnswerRepair?.text ?? result.text}`
			: (finalAnswerRepair?.text ?? result.text),
		contextStatus: prepared.contextStatus,
		taskState: prepared.taskState,
		contextDebug: prepared.contextDebug,
		contextTraceSections: prepared.contextTraceSections,
		contextPreparationTimings: prepared.contextPreparationTimings,
		providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(
			sumUsage(
				sumUsage(deliberationUsage, result.usage),
				// The final-answer repair is a separate, smaller request; the
				// main run's last prompt is the conversation prompt the ring
				// reports, so its last-step count is pinned after the sum.
				{
					...(finalAnswerRepair?.usage ?? {
						inputTokens: undefined,
						outputTokens: undefined,
						totalTokens: undefined,
					}),
					lastStepInputTokens: result.usage.lastStepInputTokens,
				},
			),
		),
		estimatedPromptTokens: estimateTurnPromptTokens({
			prepared,
			inputValue: appendTurnGuidance(
				appendDeliberationBriefsToInput(
					prepared.inputValue,
					deliberation?.briefs ?? [],
				),
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
		depthMetadata: activeDepthEffort
			? (deliberation?.depthMetadata ?? activeDepthEffort.depthMetadata)
			: clarification.depthMetadata,
	};
}
