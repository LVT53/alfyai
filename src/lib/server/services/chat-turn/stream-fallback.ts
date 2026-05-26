import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type {
	HonchoContextInfo,
	HonchoContextSnapshot,
	ModelId,
	ThinkingMode,
} from "$lib/types";

export interface NonStreamFallbackSendParams {
	upstreamMessage: string;
	conversationId: string;
	modelId: string | null;
	attachmentIds: string[];
	activeDocumentArtifactId: string | null;
	attachmentTraceId: string | null;
	thinkingMode: ThinkingMode;
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
	modelId?: ModelId;
	modelDisplayName?: string;
}

export interface NonStreamFallbackDeps {
	sendMessage: (
		upstreamMessage: string,
		conversationId: string,
		modelId: string | null,
		user: { id: string; displayName: string | null; email: string | null },
		options: {
			signal?: AbortSignal;
			attachmentIds: string[];
			activeDocumentArtifactId: string | null;
			attachmentTraceId: string | null;
			systemPromptAppendix?: string;
			personalityPrompt?: string;
			skipHonchoContext?: boolean;
			thinkingMode?: ThinkingMode;
			forceWebSearch?: boolean;
		},
	) => Promise<NonStreamFallbackResponse>;
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
	completeSuccess: () => void;
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
			sendMessage,
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
			skipHonchoContext,
			onContextStatus,
			onTaskState,
			onContextDebug,
			onHonchoContext,
			onHonchoSnapshot,
			onProviderUsage,
			onResolvedModel,
		} = deps;

		let fallbackResponse: NonStreamFallbackResponse | null = null;
		for (let attempt = 1; attempt <= 2; attempt += 1) {
			const attemptSystemPromptAppendix =
				attempt === 1
					? systemPromptAppendix
					: appendSystemPromptAppendix(
							systemPromptAppendix,
							EMPTY_VISIBLE_OUTPUT_RECOVERY_APPENDIX,
						);
			fallbackResponse = await sendMessage(
				sendParams.upstreamMessage,
				sendParams.conversationId,
				sendParams.modelId,
				user,
				{
					signal,
					attachmentIds: sendParams.attachmentIds,
					activeDocumentArtifactId: sendParams.activeDocumentArtifactId,
					attachmentTraceId: sendParams.attachmentTraceId,
					systemPromptAppendix: attemptSystemPromptAppendix,
					personalityPrompt,
					skipHonchoContext,
					thinkingMode: sendParams.thinkingMode,
					forceWebSearch: sendParams.forceWebSearch,
				},
			);

			if (fallbackResponse.text?.trim() || attempt === 2) {
				break;
			}
			console.warn("[STREAM] Non-stream fallback returned no visible text", {
				conversationId: sendParams.conversationId,
				modelId: sendParams.modelId,
				attempt,
			});
		}

		if (!fallbackResponse) {
			return false;
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

		if (!fallbackResponse.text?.trim()) {
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
			return false;
		}

		completeSuccess();
		return true;
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
