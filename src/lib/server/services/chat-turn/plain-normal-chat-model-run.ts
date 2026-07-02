import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import {
	appendDeliberationBriefsToInput,
	runNormalChatDeliberationPasses,
	shouldRunDeliberationPasses,
	sumUsage,
	verifyAndRepairDeliberatedFinalAnswer,
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
import {
	selectNormalChatToolsForRequest,
	shouldExposeFileProductionTools,
} from "$lib/server/services/chat-turn/normal-chat-tool-gating";
import { NORMAL_CHAT_MAX_TOOL_STEPS } from "$lib/server/services/chat-turn/tool-step-budget";
import { detectLanguage } from "$lib/server/services/language";
import {
	type AuthenticatedPromptUser,
	prepareOutboundChatContext,
} from "$lib/server/services/normal-chat-context";
import {
	createNormalChatContextPreparationActivityHandler,
	type NormalChatContextPreparationActivity,
	type NormalChatContextPreparationStageTiming,
} from "$lib/server/services/normal-chat-context-preparation";
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
	depthClarificationClassifier?: DepthClarificationClassifier;
	overrideProvider?: NormalChatModelRunProvider;
	onContextPreparationActivity?: (
		activity: NormalChatContextPreparationActivity,
	) => void;
	onResponseActivity?: (
		entry: import("$lib/types").ResponseActivityEntry,
	) => void;
};

export type PlainNormalChatSendModelResult = {
	text: string;
	contextStatus?: ConversationContextStatus;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
	providerUsage?: ProviderUsageSnapshot | null;
	prefetchedToolCalls?: ToolCallEntry[];
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId: ModelId;
	modelDisplayName: string;
	resolvedProviderId: string;
	depthMetadata?: DepthMetadata;
};

type PreparedModelContext = Awaited<
	ReturnType<typeof prepareOutboundChatContext>
>;

type DepthEffort = Awaited<
	ReturnType<typeof resolveReasoningDepthEffort>
> | null;
type NormalChatModelTools = Partial<
	ReturnType<typeof createNormalChatTools>["tools"]
>;

type ClarificationDecision = Awaited<
	ReturnType<typeof evaluateDepthClarificationGate>
>;

type ProviderRuntime = {
	modelId: ModelId;
	provider: NormalChatModelRunProvider;
	modelConfig: ReturnType<typeof resolvePromptModelConfig>;
	baseContextLimits: NonNullable<ReturnType<typeof resolvePromptContextLimits>>;
	depthEffort: DepthEffort;
};

type ToolPack = {
	tools: NormalChatModelTools | undefined;
	recorder: ReturnType<typeof createToolCallRecorder>;
	getToolCalls: ReturnType<typeof createNormalChatTools>["getToolCalls"];
};

type ModelRunParams = {
	params: PlainNormalChatSendModelParams;
	runtime: ProviderRuntime;
	prepared: PreparedModelContext;
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>;
	deliberation: Awaited<ReturnType<typeof runDeliberationIfNeeded>>;
	tools: ToolPack["tools"];
};

type BuildResultInput = {
	params: PlainNormalChatSendModelParams;
	clarification: ClarificationDecision;
	runtime: ProviderRuntime;
	prepared: PreparedModelContext;
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>;
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
	const prepared = await prepareOutboundContext(
		params,
		runtime,
		activeDepthEffort,
	);
	const turnId = params.createTurnId?.() ?? randomUUID();
	const toolPack = createToolPack(params, turnId, activeDepthEffort);
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

async function resolveProviderRuntime(
	params: PlainNormalChatSendModelParams,
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

async function evaluateClarification(
	params: PlainNormalChatSendModelParams,
	depthEffort: DepthEffort,
): Promise<ClarificationDecision> {
	return evaluateDepthClarificationGate({
		message: params.message,
		depthMetadata: depthEffort?.depthMetadata ?? params.depthMetadata,
		classifier: params.depthClarificationClassifier,
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
	| "honchoContext"
	| "honchoSnapshot"
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
		honchoContext: null,
		honchoSnapshot: null,
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

function resolveActiveDepthEffort(
	depthEffort: DepthEffort,
	clarification: ClarificationDecision,
) {
	return depthEffort
		? {
				...depthEffort,
				depthMetadata: clarification.depthMetadata ?? depthEffort.depthMetadata,
			}
		: null;
}

async function prepareOutboundContext(
	params: PlainNormalChatSendModelParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>,
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
		onContextPreparationActivity:
			createNormalChatContextPreparationActivityHandler(params),
		logLabel: "provider request",
	});
}

function createToolPack(
	params: PlainNormalChatSendModelParams,
	turnId: string,
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>,
): ToolPack {
	const normalChatTools = createNormalChatTools({
		userId: params.userId,
		conversationId: params.conversationId,
		turnId,
		language: detectLanguage(params.message),
		...(activeDepthEffort
			? { webSourceBudget: activeDepthEffort.webSourceBudget }
			: {}),
	});

	return {
		tools: params.disableTools
			? undefined
			: selectNormalChatToolsForRequest(normalChatTools.tools, {
					message: params.message,
					forceProduceFileTool: params.forceProduceFileTool,
				}),
		recorder: normalChatTools.recorder ?? createToolCallRecorder(),
		getToolCalls: normalChatTools.getToolCalls,
	};
}

async function runDeliberationIfNeeded(
	params: PlainNormalChatSendModelParams,
	runtime: ProviderRuntime,
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>,
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

async function runPlainModelRun(params: ModelRunParams) {
	const {
		params: modelRunParams,
		runtime,
		prepared,
		activeDepthEffort,
		deliberation,
		tools,
	} = params;

	const finalInputValue = appendDeliberationBriefsToInput(
		prepared.inputValue,
		deliberation?.briefs ?? [],
	);
	const toolChoice = modelRunParams.forceProduceFileTool
		? ({ type: "tool", toolName: "produce_file" } as const)
		: undefined;

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
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: finalInputValue }],
			},
		],
	});
}

async function maybeRepairFinalAnswer(
	result: Awaited<ReturnType<typeof runPlainNormalChatModelRun>>,
	params: PlainNormalChatSendModelParams,
	prepared: PreparedModelContext,
	runtimeProvider: NormalChatModelRunProvider,
	activeDepthEffort: ReturnType<typeof resolveActiveDepthEffort>,
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
		honchoContext: prepared.honchoContext,
		honchoSnapshot: prepared.honchoSnapshot,
		contextTraceSections: prepared.contextTraceSections,
		contextPreparationTimings: prepared.contextPreparationTimings,
		providerUsage: mapNormalChatModelRunUsageToProviderSnapshot(
			sumUsage(
				sumUsage(deliberationUsage, result.usage),
				finalAnswerRepair?.usage ?? {
					inputTokens: undefined,
					outputTokens: undefined,
					totalTokens: undefined,
				},
			),
		),
		prefetchedToolCalls: prepared.prefetchedToolCalls,
		normalChatToolCalls,
		toolCalls,
		modelId: result.model.modelId as ModelId,
		modelDisplayName: result.model.displayName,
		resolvedProviderId: result.model.providerId,
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
