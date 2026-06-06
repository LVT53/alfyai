import type { RuntimeConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import { isProduceFileRequest } from "$lib/server/services/normal-chat-tools";
import type {
	HonchoContextInfo,
	HonchoContextSnapshot,
	ModelId,
	ThinkingMode,
	DepthMetadata,
	ToolCallEntry,
	ResponseActivityEntry,
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
	contextStatus?: Record<string, unknown> | null;
	taskState?: Record<string, unknown> | null;
	contextDebug?: Record<string, unknown> | null;
	honchoContext?: HonchoContextInfo | null;
	honchoSnapshot?: HonchoContextSnapshot | null;
	providerUsage?: ProviderUsageSnapshot | null;
	normalChatToolCalls?: ToolCallEntry[];
	toolCalls?: ToolCallEntry[];
	modelId?: ModelId;
	modelDisplayName?: string;
	depthMetadata?: DepthMetadata;
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
		taskState: Record<string, unknown> | null,
	) => Promise<Record<string, unknown> | null>;
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
	onContextStatus: (status: Record<string, unknown> | undefined) => void;
	onTaskState: (state: Record<string, unknown> | null) => void;
	onContextDebug: (debug: Record<string, unknown> | null) => void;
	onHonchoContext: (ctx: HonchoContextInfo | null) => void;
	onHonchoSnapshot: (snap: HonchoContextSnapshot | null) => void;
	onProviderUsage: (usage: ProviderUsageSnapshot | null) => void;
	onResolvedModel?: (modelId: ModelId, displayName: string) => void;
	onDepthMetadata?: (metadata: DepthMetadata) => void;
	onRecoveredToolCalls?: (toolCalls: ToolCallEntry[]) => void;
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

export async function runNonStreamFallback(
	deps: NonStreamFallbackDeps,
): Promise<boolean> {
	try {
		const {
			runPlainNormalChatSendModel,
			sendParams,
			user,
			attachContinuityToTaskState,
			emitResolvedAssistantText,
			flushPendingThinking,
			flushInlineThinkingBuffer,
			flushOutputBuffer,
			hasVisibleAssistantText,
			completeSuccess,
			signal,
			systemPromptAppendix,
			personalityPrompt,
			onContextStatus,
			onTaskState,
			onContextDebug,
			onHonchoContext,
			onHonchoSnapshot,
			onProviderUsage,
			onResolvedModel,
			onDepthMetadata,
			onRecoveredToolCalls,
			onResponseActivity,
		} = deps;
		const completedToolCallContext = deps.completedToolCallContext?.trim();
		const shouldAllowForcedFileTool =
			Boolean(completedToolCallContext) &&
			isProduceFileRequest(sendParams.upstreamMessage);

		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const contextualAppendix = completedToolCallContext
				? appendSystemPromptAppendix(
						systemPromptAppendix,
						[
							shouldAllowForcedFileTool
								? "The previous streaming attempt completed these tool calls before ending without a final answer. Use this compact tool context to create the requested file now; do not call more context/search tools."
								: "The previous streaming attempt completed these tool calls before ending without a final answer. Use this compact tool context to answer now; do not call more tools unless the context is unusable.",
							completedToolCallContext,
						].join("\n\n"),
					)
				: systemPromptAppendix;
			const attemptSystemPromptAppendix =
				attempt === 1
					? contextualAppendix
					: appendSystemPromptAppendix(
							contextualAppendix,
							EMPTY_VISIBLE_OUTPUT_RECOVERY_APPENDIX,
						);
			const shouldDisableTools =
				(Boolean(completedToolCallContext) && !shouldAllowForcedFileTool) ||
				attempt > 1;
			const fallbackResponse = await runPlainNormalChatSendModel({
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
				signal,
				disableTools: shouldDisableTools,
				forceProduceFileTool: shouldAllowForcedFileTool,
				onResponseActivity,
			});
			const fallbackToolCalls =
				fallbackResponse.normalChatToolCalls ??
				fallbackResponse.toolCalls ??
				[];
			if (fallbackToolCalls.length > 0) {
				onRecoveredToolCalls?.(fallbackToolCalls);
			}

			const contextStatus = fallbackResponse.contextStatus;
			onContextStatus(contextStatus);

			const taskState = await attachContinuityToTaskState(
				user.id,
				fallbackResponse.taskState ?? null,
			).catch(() => fallbackResponse.taskState ?? null);
			onTaskState(taskState);

			onContextDebug(fallbackResponse.contextDebug ?? null);
			onHonchoContext(fallbackResponse.honchoContext ?? null);
			onHonchoSnapshot(fallbackResponse.honchoSnapshot ?? null);
			onProviderUsage(fallbackResponse.providerUsage ?? null);
			if (fallbackResponse.modelId && fallbackResponse.modelDisplayName) {
				onResolvedModel?.(
					fallbackResponse.modelId,
					fallbackResponse.modelDisplayName,
				);
			}
			if (fallbackResponse.depthMetadata) {
				onDepthMetadata?.(fallbackResponse.depthMetadata);
			}

			if (!fallbackResponse.text?.trim()) {
				if (attempt < 2) {
					console.warn("[STREAM] Non-stream fallback returned no text", {
						conversationId: sendParams.conversationId,
						modelId: sendParams.modelId,
						attempt,
					});
					continue;
				}
				return false;
			}

			if (!(await emitResolvedAssistantText(fallbackResponse.text))) {
				return false;
			}

			flushPendingThinking();
			if (!flushInlineThinkingBuffer()) {
				return false;
			}
			if (!flushOutputBuffer()) {
				return false;
			}
			if (!hasVisibleAssistantText()) {
				if (attempt < 2) {
					console.warn(
						"[STREAM] Non-stream fallback normalized to no visible text",
						{
							conversationId: sendParams.conversationId,
							modelId: sendParams.modelId,
							attempt,
						},
					);
					continue;
				}
				return false;
			}

			await completeSuccess();
			return true;
		}

		return false;
	} catch (error) {
		console.warn("[STREAM] Non-stream fallback failed", {
			conversationId: deps.sendParams.conversationId,
			modelId: deps.sendParams.modelId,
			errorName: error instanceof Error ? error.name : undefined,
			errorMessage: error instanceof Error ? error.message : String(error),
		});
		return false;
	}
}
