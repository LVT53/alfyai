import type { RuntimeConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { NormalChatContextPreparationStageTiming } from "$lib/server/services/normal-chat-context-preparation";
import { isProduceFileRequest } from "$lib/server/services/normal-chat-tools";
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

export interface NonStreamFallbackSendParams {
	runtimeConfig: RuntimeConfig;
	upstreamMessage: string;
	conversationId: string;
	modelId: ModelId | undefined;
	attachmentIds: string[];
	activeDocumentArtifactId: string | undefined;
	attachmentTraceId: string | undefined;
	thinkingMode: ThinkingMode;
	depthMetadata?: DepthMetadata;
	forceWebSearch: boolean;
}

export interface NonStreamFallbackResponse {
	text: string | null;
	contextStatus?: ConversationContextStatus | null;
	taskState?: TaskState | null;
	contextDebug?: ContextDebugState | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	providerUsage?: ProviderUsageSnapshot | null;
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId?: ModelId;
	modelDisplayName?: string;
	depthMetadata?: DepthMetadata;
	contextPreparationTimings?: NormalChatContextPreparationStageTiming[];
}

export interface NonStreamFallbackDeps {
	runPlainNormalChatSendModel: (params: {
		userId: string;
		runtimeConfig: RuntimeConfig;
		message: string;
		conversationId: string;
		modelId: ModelId | undefined;
		user?: { id: string; displayName: string | null; email: string | null };
		attachmentIds?: string[];
		activeDocumentArtifactId?: string;
		attachmentTraceId?: string;
		systemPromptAppendix?: string;
		personalityPrompt?: string;
		thinkingMode?: ThinkingMode;
		depthMetadata?: DepthMetadata;
		forceWebSearch?: boolean;
		signal?: AbortSignal;
		disableTools?: boolean;
		forceProduceFileTool?: boolean;
		onResponseActivity?: (entry: ResponseActivityEntry) => void;
	}) => Promise<NonStreamFallbackResponse>;
	sendParams: NonStreamFallbackSendParams;
	user: { id: string; displayName: string | null; email: string | null };
	attachContinuityToTaskState: (
		userId: string,
		taskState: TaskState | null,
	) => Promise<TaskState | null>;
	emitResolvedAssistantText: (text: string | null) => Promise<boolean>;
	flushPendingThinking: () => void;
	flushInlineThinkingBuffer: () => boolean;
	flushOutputBuffer: () => boolean;
	hasVisibleAssistantText: () => boolean;
	completeSuccess: () => Promise<void> | void;
	signal: AbortSignal;
	systemPromptAppendix: string | undefined;
	personalityPrompt: string | undefined;
	skipHonchoContext: boolean | undefined;
	onContextStatus: (status: ConversationContextStatus | undefined) => void;
	onTaskState: (state: TaskState | null) => void;
	onContextDebug: (debug: ContextDebugState | null) => void;
	onHonchoContext: (ctx: HonchoContextInfo | null) => void;
	onHonchoSnapshot: (snap: HonchoContextSnapshot | null) => void;
	onProviderUsage: (usage: ProviderUsageSnapshot | null) => void;
	onResolvedModel?: (modelId: ModelId, displayName: string) => void;
	onDepthMetadata?: (metadata: DepthMetadata) => void;
	onRecoveredToolCalls?: (toolCalls: ToolCallEntry[]) => void;
	onContextPreparationTimings?: (
		timings: NormalChatContextPreparationStageTiming[],
		attempt: number,
	) => void;
	completedToolCallContext?: string | null;
	onResponseActivity?: (entry: ResponseActivityEntry) => void;
}

const EMPTY_VISIBLE_OUTPUT_RECOVERY_APPENDIX =
	"The previous attempt produced no visible final answer. Produce the concise final answer requested by the user now. Do not output hidden reasoning, tool arguments, raw tool output, raw JSON, logs, or diagnostics.";

function appendSystemPromptAppendix(
	base: string | undefined,
	appendix: string,
): string {
	return [base, appendix]
		.filter((value): value is string => Boolean(value?.trim()))
		.join("\n\n");
}

interface FallbackAttemptContext {
	attempt: number;
	user: NonStreamFallbackDeps["user"];
	sendParams: NonStreamFallbackSendParams;
	systemPromptAppendix: string | undefined;
	personalityPrompt: string | undefined;
	sendSignal: AbortSignal;
	completedToolCallContext: string | null;
	shouldAllowForcedFileTool: boolean;
	onResponseActivity?: (entry: ResponseActivityEntry) => void;
}

function parseSendTurnFailureMetadata(error: unknown) {
	return {
		errorName: error instanceof Error ? error.name : undefined,
		errorMessage: error instanceof Error ? error.message : String(error),
	};
}

function selectFallbackToolCalls(response: NonStreamFallbackResponse) {
	return response.normalChatToolCalls ?? response.toolCalls ?? [];
}

function buildFallbackAttemptSystemPrompt(
	context: FallbackAttemptContext,
): string {
	const { attempt, systemPromptAppendix, completedToolCallContext } = context;
	const contextualAppendix = completedToolCallContext
		? appendSystemPromptAppendix(
				systemPromptAppendix ?? "",
				[
					context.shouldAllowForcedFileTool
						? "The previous streaming attempt completed these tool calls before ending without a final answer. Use this compact tool context to create the requested file now; do not call more context/search tools."
						: "The previous streaming attempt completed these tool calls before ending without a final answer. Use this compact tool context to answer now; do not call more tools unless the context is unusable.",
					completedToolCallContext,
				].join("\n\n"),
			)
		: (systemPromptAppendix ?? "");
	return attempt === 1
		? contextualAppendix
		: appendSystemPromptAppendix(
				contextualAppendix,
				EMPTY_VISIBLE_OUTPUT_RECOVERY_APPENDIX,
			);
}

function buildFallbackAttemptParams(
	context: FallbackAttemptContext,
): Parameters<NonStreamFallbackDeps["runPlainNormalChatSendModel"]>[0] {
	const {
		user,
		sendParams,
		sendSignal,
		personalityPrompt,
		onResponseActivity,
	} = context;
	const attemptSystemPromptAppendix = buildFallbackAttemptSystemPrompt(context);
	const shouldDisableTools =
		(Boolean(context.completedToolCallContext) &&
			!context.shouldAllowForcedFileTool) ||
		context.attempt > 1;

	return {
		userId: user.id,
		runtimeConfig: sendParams.runtimeConfig,
		message: sendParams.upstreamMessage,
		conversationId: sendParams.conversationId,
		user,
		modelId: sendParams.modelId,
		attachmentIds: sendParams.attachmentIds,
		activeDocumentArtifactId: sendParams.activeDocumentArtifactId,
		attachmentTraceId: sendParams.attachmentTraceId,
		systemPromptAppendix: attemptSystemPromptAppendix,
		personalityPrompt,
		thinkingMode: sendParams.thinkingMode,
		depthMetadata: sendParams.depthMetadata,
		forceWebSearch: sendParams.forceWebSearch,
		signal: sendSignal,
		disableTools: shouldDisableTools,
		forceProduceFileTool: context.shouldAllowForcedFileTool,
		onResponseActivity,
	};
}

function applyFallbackModelSideEffects(
	deps: NonStreamFallbackDeps,
	response: NonStreamFallbackResponse,
): Promise<TaskState | null> {
	const {
		attachContinuityToTaskState,
		onContextStatus,
		onTaskState,
		onContextDebug,
		onHonchoContext,
		onHonchoSnapshot,
		onProviderUsage,
		onResolvedModel,
		onDepthMetadata,
		onRecoveredToolCalls,
	} = deps;

	const fallbackToolCalls = selectFallbackToolCalls(response);
	if (fallbackToolCalls.length > 0) {
		onRecoveredToolCalls?.(fallbackToolCalls);
	}

	const contextStatus = response.contextStatus ?? undefined;
	onContextStatus(contextStatus);

	return attachContinuityToTaskState(deps.user.id, response.taskState ?? null)
		.catch(() => response.taskState ?? null)
		.then((taskState) => {
			onTaskState(taskState);
			onContextDebug(response.contextDebug ?? null);
			onHonchoContext(response.honchoContext ?? null);
			onHonchoSnapshot(response.honchoSnapshot ?? null);
			onProviderUsage(response.providerUsage ?? null);
			if (response.modelId && response.modelDisplayName) {
				onResolvedModel?.(response.modelId, response.modelDisplayName);
			}
			if (response.depthMetadata) {
				onDepthMetadata?.(response.depthMetadata);
			}
			return taskState;
		});
}

async function runFallbackAttempt(
	deps: NonStreamFallbackDeps,
	context: FallbackAttemptContext,
): Promise<NonStreamFallbackResponse> {
	const params = buildFallbackAttemptParams(context);
	return deps.runPlainNormalChatSendModel(params);
}

function shouldContinueFallbackAfterMissingVisibleText(
	attemptContext: FallbackAttemptContext,
): boolean {
	return attemptContext.attempt < 2;
}

async function handleFallbackTextEmission(
	deps: NonStreamFallbackDeps,
	fallbackResponse: NonStreamFallbackResponse,
): Promise<boolean> {
	if (!(await deps.emitResolvedAssistantText(fallbackResponse.text))) {
		return false;
	}

	deps.flushPendingThinking();
	if (!deps.flushInlineThinkingBuffer()) {
		return false;
	}
	if (!deps.flushOutputBuffer()) {
		return false;
	}
	return true;
}

export async function runNonStreamFallback(
	deps: NonStreamFallbackDeps,
): Promise<boolean> {
	try {
		const attemptContext = {
			sendParams: deps.sendParams,
			user: deps.user,
			systemPromptAppendix: deps.systemPromptAppendix,
			personalityPrompt: deps.personalityPrompt,
			sendSignal: deps.signal,
			completedToolCallContext: deps.completedToolCallContext?.trim() ?? null,
			shouldAllowForcedFileTool:
				Boolean(deps.completedToolCallContext?.trim()) &&
				isProduceFileRequest(deps.sendParams.upstreamMessage),
			onResponseActivity: deps.onResponseActivity,
			attempt: 1,
		};

		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const iterationContext = {
				...attemptContext,
				attempt,
			};
			const fallbackResponse = await runFallbackAttempt(deps, iterationContext);
			if (fallbackResponse.contextPreparationTimings?.length) {
				deps.onContextPreparationTimings?.(
					fallbackResponse.contextPreparationTimings,
					attempt,
				);
			}
			await applyFallbackModelSideEffects(deps, fallbackResponse);

			if (!fallbackResponse.text?.trim()) {
				if (attempt < 2) {
					console.warn("[STREAM] Non-stream fallback returned no text", {
						conversationId: deps.sendParams.conversationId,
						modelId: deps.sendParams.modelId,
						attempt,
					});
					continue;
				}
				return false;
			}
			if (!(await handleFallbackTextEmission(deps, fallbackResponse))) {
				return false;
			}
			if (!deps.hasVisibleAssistantText()) {
				console.warn(
					"[STREAM] Non-stream fallback normalized to no visible text",
					{
						conversationId: deps.sendParams.conversationId,
						modelId: deps.sendParams.modelId,
						attempt,
					},
				);
				if (!shouldContinueFallbackAfterMissingVisibleText(iterationContext)) {
					return false;
				}
				continue;
			}

			await deps.completeSuccess();
			return true;
		}

		return false;
	} catch (error) {
		console.warn("[STREAM] Non-stream fallback failed", {
			...parseSendTurnFailureMetadata(error),
			conversationId: deps.sendParams.conversationId,
			modelId: deps.sendParams.modelId,
		});
		return false;
	}
}
