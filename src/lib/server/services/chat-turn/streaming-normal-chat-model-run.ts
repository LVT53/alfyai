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
	type ResumeRunParams,
	resolveActiveDepthEffort,
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
import { resolveHistoryToolMessagesMode } from "$lib/server/services/normal-chat-model/provider-compatibility";
import type { TurnAsk } from "$lib/server/services/normal-chat-tools/ask-user";
import type { TaskState } from "$lib/server/services/task-state/types";
import { buildCurrentUserMessage } from "$lib/server/services/vision/turn-images";
import { RESPONSE_ACTIVITY_IDS } from "$lib/services/stream-timeline";
import type {
	ImageMarksRequest,
	PictureRef,
	UserPicturesMetadata,
} from "$lib/shared/artifacts/image-body";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import { renderAskContinuationAsText } from "./ask-capture";
import { logOutboundMessageShape } from "./outbound-debug";

export type StreamingNormalChatSendModelParams = ResumeRunParams & {
	userId: string;
	runtimeConfig: RuntimeConfig;
	message: string;
	conversationId: string;
	modelId: ModelId | undefined;
	user?: AuthenticatedPromptUser;
	attachmentIds?: string[];
	activeDocumentArtifactId?: string;
	pictureRefs?: PictureRef[];
	imageMarks?: ImageMarksRequest | null;
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
	onToolActivity?: () => void;
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
	// Which instruction scopes the prepared system prompt carried. It rides
	// this snapshot rather than being re-derived at completion: the record has
	// to describe the prompt the model got, and the orchestrator's completion
	// step runs long after context preparation.
	instructionsApplied?: InstructionScopeApplication;
	// What the user message keeps of the pictures beside its uploads.
	userPictures?: UserPicturesMetadata;
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
	/** What this turn asked the person with `ask_user`, once the tool recorded it; null until then. */
	getTurnAsk: () => TurnAsk | null;
	/**
	 * Everything the run has said and read, as of the last step that finished
	 * (the SDK's cumulative `response.messages`, tool results whole). Read it when
	 * the stream sends `finish`: the SDK has finished that step's callback by then.
	 */
	getResponseMessages: () => ModelMessage[];
	/**
	 * What the model was given after the person's message, as messages: the page the
	 * server fetched before it ran and, on a resume, the continuation it carried on
	 * from.
	 */
	continuationGiven: ModelMessage[];
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
		// The one run that can stop a reply to wait for the person's answer to
		// `ask_user`. The plain run, and so the non-stream fallback, never sets it.
		canPause: true,
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
		prepared.turnPictures,
	);

	const prefetchedToolCalls = prepared.prefetchedToolCalls ?? [];
	const getNormalChatToolCalls = () => toolPack.getToolCalls();
	const finalInputValue = appendTurnGuidance(
		prepared.inputValue,
		prepared.turnGuidance,
	);
	// A resume of a reply that asked carries the reply so far and the person's
	// answer, after the page the server fetched (a resume reads no page, so the two
	// never meet). A provider that takes no tool messages is sent them as text. The
	// model run's gate cannot find a connector's result in text, so for that
	// provider the gate runs here first, on the provider the run starts with. The
	// fold is decided here, once: a failover attempt gets the same text, gated no
	// more (no provider uses flatten mode today).
	const continuation = params.continuationMessages ?? [];
	const continuationSent =
		continuation.length > 0 &&
		resolveHistoryToolMessagesMode(runtime.provider) === "flatten"
			? renderAskContinuationAsText(
					params.gateMessagesForAttempt
						? params.gateMessagesForAttempt(continuation, runtime.provider)
						: continuation,
				)
			: continuation;
	// What the model was given after the person's message, as a reply that asks
	// again is captured from (`buildAskResumeCapture`): the messages as they were,
	// not the text a provider that takes no tool messages was sent.
	const continuationGiven: ModelMessage[] = [
		...(prepared.prefetchedToolMessages ?? []),
		...continuation,
	];
	const outboundMessages: ModelMessage[] = [
		...(prepared.historyMessages ?? []),
		buildCurrentUserMessage(finalInputValue, prepared.turnPictureImages),
		...(prepared.prefetchedToolMessages ?? []),
		...continuationSent,
	];
	// What the run has said and read, as of its last finished step. A plain
	// assignment: the SDK swallows whatever a step callback throws.
	let responseMessages: ModelMessage[] = [];
	logOutboundMessageShape({
		label: "stream",
		systemPrompt: prepared.systemPrompt,
		messages: outboundMessages,
		toolCount: toolPack.tools ? Object.keys(toolPack.tools).length : 0,
	});

	// The model is about to read the pictures of this message, which is the part
	// of the wait the person would otherwise not be told about. One entry on the
	// response-activity channel with the number of pictures it is sent (the
	// pictures that made it into the request, not the ones attached), nothing
	// else: no name, no description. `turnPictureImages` is empty unless the model can
	// see, so a turn without pictures says nothing. The browser shows it only while
	// the reply streams (MessageBubble), and the stream is lazy: the model call
	// below starts when the orchestrator reads it, after this.
	if (prepared.turnPictureImages.length > 0) {
		params.onResponseActivity?.({
			id: RESPONSE_ACTIVITY_IDS.VIEWING_IMAGES,
			kind: "viewing_images",
			status: "running",
			count: prepared.turnPictureImages.length,
		});
	}

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
		// The thumbnails a tool queues; the run hands them over, per attempt.
		stepImages: toolPack.stepImages,
		toolChoice: undefined,
		// Forced web search is expressed in the turn guidance, not as a named
		// tool_choice: vLLM honours a named tool_choice through guided JSON
		// decoding, which bypasses the Qwen XML tool format and yields a
		// text step of raw arguments instead of a parsed tool call.
		firstStepToolChoice: undefined,
		maxToolSteps: activeDepthEffort?.maxToolSteps ?? NORMAL_CHAT_MAX_TOOL_STEPS,
		messages: outboundMessages,
		// The turn's rule for each attempt's messages (a resume's captured connector
		// results stay where the person keeps them); the run decides it per attempt.
		gateMessagesForAttempt: params.gateMessagesForAttempt,
		onStepMessages: (messages) => {
			responseMessages = messages;
		},
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
				continuationMessages: continuationSent,
			}),
			instructionsApplied: prepared.instructionsApplied,
			userPictures: prepared.turnPictures.metadata ?? undefined,
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
		getTurnAsk: () => toolPack.getTurnAsk(),
		getResponseMessages: () => responseMessages,
		continuationGiven,
	};
}
