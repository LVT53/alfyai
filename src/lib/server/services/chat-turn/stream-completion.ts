import type { FinishReason } from "ai";
import type { ChatTurnOrigin } from "$lib/chat-turn-origin";
import type { MessageUserIntent } from "$lib/message-user-intent";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import { getConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { getChatFilesForAssistantMessage } from "$lib/server/services/chat-files";
import { recordCompletedTurnContextUsage } from "$lib/server/services/chat-turn/context-usage";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	collectInstructionSuggestions,
	FileAssociationFinalizationError,
	finalizeChatTurn,
} from "$lib/server/services/chat-turn/finalize";
import { getConversation } from "$lib/server/services/conversations";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { SupportedLanguage } from "$lib/server/services/language";
import { listMessageWindow } from "$lib/server/services/messages";
import type {
	ChatTurnCompletionWarningCode,
	ThinkingSegment,
	ToolCallEntry,
	TurnCompletionRecord,
} from "$lib/server/services/messages-types";
import type { TaskState } from "$lib/server/services/task-state/types";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import {
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import type { UserPicturesMetadata } from "$lib/shared/artifacts/image-body";
import {
	ASK_ENDED_BEFORE_ANSWER,
	ASK_STOPPED_BEFORE_ANSWER,
	askCallPausedTheReply,
} from "$lib/shared/ask-user";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import { projectNormalChatFinalization } from "$lib/shared/normal-chat-completion";
import {
	isConnectionWriteToolName,
	isFileProductionToolName,
} from "$lib/utils/tool-calls";
import { wasActiveChatStreamStopRequested } from "./active-streams";
import type { AskResumeInput } from "./ask-capture";
import type { AskResumeCapture } from "./ask-questions";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
import {
	FOLLOW_UP_SUGGESTIONS_HISTORY_MESSAGE_LIMIT,
	generateFollowUpSuggestions,
	goneMarkLettersOf,
} from "./follow-up-suggestions";
import { resolveTurnReplyLanguage } from "./reply-language";
import { parseSkillControlEnvelopePayloads } from "./skill-control-envelope";
import {
	createUiMessageStreamDoneFrame,
	streamDataPartEvent,
	streamErrorEvent,
	streamFinishEvent,
	streamReasoningEndEvent,
	streamTextEndEvent,
} from "./stream";

export type StreamCompletionFact<T> = T | Promise<T>;

// The prepared-context snapshot the orchestrator hands to completion. It
// replaces the former latest*/initial* scalar mirror-pairs: each pair always
// carried the same value at this boundary, so it collapses to one value per
// concept and the boundary carries a single object instead of eight scalars.
export type PreparedContextSnapshot = {
	contextStatus: ConversationContextStatus | null | undefined;
	taskState: TaskState | null | undefined;
	contextDebug: ContextDebugState | null | undefined;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	// Full-prompt estimate (system prompt + final packet + tool schemas) from
	// the model-run wrapper. Fallback for the context usage ring when the
	// provider reported no input tokens.
	estimatedPromptTokens?: number;
	// Which instruction scopes the prepared system prompt carried. Persisted so
	// a reloaded page's Info popover reports the same scopes the live turn did,
	// and never re-read from storage here (see PreparedOutboundChatContext).
	instructionsApplied?: InstructionScopeApplication;
	// What the user message keeps of the pictures beside its uploads (card
	// pictures, the open picture, the marked copy); written with the message.
	userPictures?: UserPicturesMetadata;
};

export interface StreamCompletionFacts {
	startedResetGeneration?: StreamCompletionFact<number>;
	pendingWriteIdsAtStart?: StreamCompletionFact<Set<string>>;
}

export interface CompleteStreamTurnParams extends StreamCompletionFacts {
	persistenceSignal?: AbortSignal;
	onPersistenceStarted?: () => void;
	completionTurn?: import("./prepared-normal-chat-turn").CompletionReceipt;
	// The account's UI language: the last fallback of the language what is
	// written after the reply is in (reply-language.ts), for a turn whose
	// language call failed and whose reply says nothing and follows no earlier one.
	uiLanguage?: SupportedLanguage;
	wasStopped: boolean;
	conversationId: string;
	streamId: string | null;
	modelId: string | null;
	modelDisplayName: string | null;
	providerDisplayName?: string | null;
	providerIconUrl?: string | null;
	reasoningDepth?: ReasoningDepth;
	depthMetadata?: DepthMetadata;
	userId: string;
	normalizedMessage: string;
	upstreamMessage: string;
	skipPersistUserMessage: boolean;
	// Gap 2 — threaded straight into finalizeChatTurn's turnOrigin param;
	// see its doc comment.
	turnOrigin?: ChatTurnOrigin;
	isReconnect: boolean | undefined;
	thinkingContent: string;
	fullResponse: string;
	toolCallRecords: ToolCallEntry[];
	// Current server recorder, before any lossy display/evidence adaptation.
	fileProductionToolCalls?: ToolCallEntry[];
	// P3b (ADR-0056) — the durable Interim Thought Step rail accumulated by
	// the reasoning-phase classifier this turn (possibly empty — a slow,
	// rejected, or unavailable classifier degrades to zero steps, never a
	// failed or altered turn). Persisted into assistantMetadata.thoughtSteps
	// below, exactly like turnAcknowledgment's fields ride assistantMetadata.
	thoughtSteps?: InterimThoughtStep[];
	skillControlEnvelopePayloads: string[];
	skillControlEnabled?: boolean;
	serverSegments: ThinkingSegment[];
	attachmentIds: string[];
	// Analytics overhaul (backend half) — threaded straight into
	// finalizeChatTurn's skillUse param; see its doc comment.
	skillUse?: { displayName: string } | null;
	// What the USER chose for this turn (see $lib/message-user-intent.ts),
	// built by the orchestrator from the preflighted turn. Persisted into
	// assistantMetadata.userIntent AND carried on the terminal
	// data-stream-metadata frame, so the provenance line reads the same live
	// as after a reload. Omitted/undefined when the user chose nothing.
	userIntent?: MessageUserIntent;
	activeDocumentArtifactId: string | null;
	requestStartTime: number;
	preparedContext: PreparedContextSnapshot;
	latestProviderUsage: ProviderUsageSnapshot | null;
	// Original streamed run only; recovery must not replace these facts.
	streamFinishReason?: FinishReason | null;
	stepCount?: number | null;
	lastStepOutputTokens?: number | null;
	visibleCharsAfterLastToolCall?: number;
	strippedVisibleChars?: number;
	droppedToolCalls?: number | null;
	recovery?: TurnCompletionRecord["recovery"];
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
	// The model stopped before it wrote its answer: no visible text came after the
	// last tool call that needs words after it, and the repair (the non-stream
	// rerun with tools off) produced none either (`stream-terminal.ts` and the
	// orchestrator's `fallbackToNonStreaming` decide it). The turn is saved as it
	// is and carries the `no_final_answer` notice; it gets no follow-up chips.
	// Never acted on for a stopped turn.
	noFinalAnswer?: boolean;
	// The reply asked the person (`ask_user`, "Ask me first") and stops there: the
	// question the tool recorded and what the resume starts from. Saved as a paused
	// segment: no follow-up chips, the question tied to the saved message by
	// finalize, and the terminal frame names it. Never set for a stopped turn.
	askPause?: { questionId: string; capture: AskResumeCapture } | null;
	// The turn carries a reply on from the person's answer to a question it asked
	// (a resume, ask-resume.ts). Its segment names the row that asked, can cite what
	// the reply found in the segments before, and settles the question once it is
	// saved, writing the answer into the ask call of the row that asked.
	askResume?: Pick<
		AskResumeInput,
		| "questionId"
		| "claim"
		| "askedMessageId"
		| "askToolCallId"
		| "priorSegmentToolCalls"
		| "userTexts"
		| "answerDigest"
	> | null;
	serverTimeline?: StreamTimelineTerminalPayload;
	touchConversation: (
		userId: string,
		conversationId: string,
	) => Promise<unknown>;
	enqueueChunk: (chunk: string) => boolean;
	closeDownstream: () => void;
	clearStreamBuffer: (streamId: string) => void;
	getStreamBuffer: (params: {
		streamId: string;
		userId: string;
		conversationId: string;
	}) => { userMessage?: string } | null;
	syncGeneratedFilesToMemory: (params: {
		userId: string;
		conversationId: string;
		assistantMessageId: string;
		fileIds: string[];
		assistantResponse: string;
	}) => Promise<void>;
	getChatFilesForAssistantMessage: (
		conversationId: string,
		assistantMessageId: string,
	) => ReturnType<typeof getChatFilesForAssistantMessage>;
	getFileProductionJobs: (
		userId: string,
		conversationId: string,
	) => Promise<FileProductionJob[]>;
	assignFileProductionJobsToAssistantMessage: (
		userId: string,
		conversationId: string,
		assistantMessageId: string,
		jobIds: string[],
	) => Promise<void>;
	estimateTokenCount: (text: string) => number;
}

export async function completeStreamTurn(
	params: CompleteStreamTurnParams,
): Promise<void> {
	const {
		uiLanguage,
		wasStopped,
		conversationId,
		streamId,
		modelId,
		modelDisplayName,
		providerDisplayName,
		providerIconUrl,
		reasoningDepth,
		depthMetadata,
		userId,
		startedResetGeneration: startedResetGenerationFact,
		normalizedMessage,
		upstreamMessage,
		skipPersistUserMessage,
		turnOrigin,
		isReconnect,
		thinkingContent,
		fullResponse,
		toolCallRecords,
		thoughtSteps = [],
		skillControlEnvelopePayloads,
		skillControlEnabled = true,
		serverSegments,
		attachmentIds,
		skillUse,
		userIntent,
		activeDocumentArtifactId,
		requestStartTime,
		pendingWriteIdsAtStart: pendingWriteIdsAtStartFact,
		preparedContext,
		latestProviderUsage,
		upstreamFinishReason = "stop",
		upstreamRawFinishReason = null,
		streamClosedWithoutFinish = false,
		noFinalAnswer = false,
		askPause: askPauseHandedOver = null,
		askResume = null,
		serverTimeline,
		touchConversation,
		enqueueChunk,
		closeDownstream,
		clearStreamBuffer,
		getStreamBuffer,
		syncGeneratedFilesToMemory,
		getChatFilesForAssistantMessage,
		getFileProductionJobs,
		assignFileProductionJobsToAssistantMessage,
		estimateTokenCount,
	} = params;

	// A stopped turn pauses nothing: a stop asked before the pause wins, so the
	// segment is saved stopped and its question is discarded (the orchestrator).
	const askPause = wasStopped ? null : askPauseHandedOver;
	const recovery = params.recovery ?? "none";
	const completion: TurnCompletionRecord = {
		end: wasStopped
			? "stopped"
			: askPause
				? "paused"
				: noFinalAnswer
					? "no_final_answer"
					: recovery === "answered"
						? "recovered"
						: "answered",
		finish:
			params.streamFinishReason !== undefined
				? params.streamFinishReason
				: (params.upstreamFinishReason ?? null),
		steps: params.stepCount ?? null,
		lastStepOutputTokens: params.lastStepOutputTokens ?? null,
		charsAfterLastToolCall: params.visibleCharsAfterLastToolCall ?? 0,
		strippedChars: params.strippedVisibleChars ?? 0,
		recovery,
		droppedToolCalls: params.droppedToolCalls ?? null,
	};
	// The segments saved with the message are what a later turn's history replays
	// of this one. A turn saved without a pause has its question discarded, so an
	// ask call it recorded (the run asked, then was stopped, failed, was recovered
	// by the fallback or declined to pause) is saved as ended, not as waiting, and
	// that history does not read a question still open.
	const savedSegments = askPause
		? serverSegments
		: settleUnansweredAskCalls(
				serverSegments,
				wasStopped ? ASK_STOPPED_BEFORE_ANSWER : ASK_ENDED_BEFORE_ANSWER,
			);

	// E1 — truncation/content-filter/file-production-failure notices used to
	// be English sentences appended into `fullResponse` (and therefore into
	// the persisted assistant message body). They now stay out of the
	// message body entirely and ride as stable `completionWarningCodes` on
	// the turn's `data-stream-metadata` payload instead (see
	// `sendEndAndClose`/assistantMetadata below) — the same "structured
	// status, no baked prose" shape web-citation-audit.ts already uses for
	// citation-quality notices.
	const completionWarningCodes = wasStopped
		? []
		: buildCompletionWarningCodes({
				toolCallRecords,
				upstreamFinishReason,
				upstreamRawFinishReason,
				streamClosedWithoutFinish,
				noFinalAnswer,
			});
	// A segment that carries a reply on may cite what the segments before it found
	// (their stored tool calls), and an address the person typed into an answer is
	// theirs as one in their message is: the citation gate reads both with this
	// segment's own.
	const citationGate = wasStopped
		? null
		: applyWebCitationQualityGate({
				assistantResponse: fullResponse,
				toolCalls: [
					...(askResume?.priorSegmentToolCalls ?? []),
					...toolCallRecords,
				],
				userMessage: [normalizedMessage, ...(askResume?.userTexts ?? [])].join(
					"\n",
				),
			});
	const finalResponse = citationGate?.response ?? fullResponse;
	// Finding 4 — the RAW model text was already streamed to this client as
	// text-delta frames, so a citation repair that rewrites the persisted
	// message leaves the live bubble showing links the reloaded conversation
	// no longer has. The terminal frame therefore carries the repaired text
	// as `finalContent` and the client swaps its streamed text for it (see
	// finalizeStreamingMessageList in routes/(app)/chat/[conversationId]/
	// _helpers.ts). Additive and present ONLY when the repair actually
	// changed the text, so an unrepaired turn costs nothing and an older
	// client simply ignores the field. Reconnects get it for free:
	// stream-reconnect.ts replays the token buffer and then forwards live
	// frames — including this one — verbatim.
	const repairedFinalContent =
		citationGate && citationGate.response !== fullResponse
			? citationGate.response
			: null;
	const skillControl = wasStopped
		? { operations: [] }
		: skillControlEnabled
			? (params.completionTurn?.skillControl ??
				parseSkillControlEnvelopePayloads(skillControlEnvelopePayloads))
			: { operations: [] };
	if (citationGate?.appendedNotice) {
		console.warn(
			"[CHAT_STREAM] Web citation quality issue detected (notice suppressed from user output)",
			{
				conversationId,
				streamId,
				status: citationGate.audit?.status,
			},
		);
	}

	const thinkingTokenCount = estimateTokenCount(thinkingContent);
	const responseTokenCount = estimateTokenCount(finalResponse);
	const totalTokenCount = thinkingTokenCount + responseTokenCount;
	const genTimeMs = Date.now() - requestStartTime;
	const analyticsModel = modelId ?? "model1";
	const persistUserMessage = !skipPersistUserMessage;
	const toolCallSummary = toolCallRecords.map((record) => ({
		name: record.name,
		status: record.status,
	}));
	const rawFileProductionToolCalls =
		params.fileProductionToolCalls ?? toolCallRecords;
	const hadFileProductionToolCall = rawFileProductionToolCalls.some((record) =>
		isFileProductionToolName(record.name),
	);
	// Issue 7.5 — widens the generatedOutputReconciliation gate below so a
	// turn that only called a connection tool (files/calendar/email/photos,
	// e.g. proposing a write) still gets its pending writes reconciled, even
	// when no file-production tool call happened this turn.
	const hadConnectionWriteToolCall = toolCallSummary.some((record) =>
		isConnectionWriteToolName(record.name),
	);

	if (getConfig().contextDiagnosticsDebug) {
		console.info("[CHAT_STREAM] Tool-call summary", {
			conversationId,
			streamId,
			wasStopped,
			toolCallCount: toolCallSummary.length,
			fileProductionCallCount: toolCallSummary.filter((record) =>
				isFileProductionToolName(record.name),
			).length,
			toolCalls: toolCallSummary,
		});
	}

	let userMessageToPersist = normalizedMessage;
	if (isReconnect && streamId) {
		const buffer = getStreamBuffer({
			streamId,
			userId,
			conversationId,
		});
		if (buffer?.userMessage) {
			userMessageToPersist = buffer.userMessage;
		}
	}
	// Refreshed after the turn's prompt usage is recorded (see below), so the
	// terminal metadata and the persisted turn state both carry the real
	// prompt size against the model's context window rather than the
	// pre-request packet estimate.
	let completedContextStatus: ConversationContextStatus | null | undefined =
		preparedContext.contextStatus;
	// Owner idea (variant A) — up to two short follow-up questions for this
	// turn, resolved (not deferred) below, before the terminal frame is sent,
	// so they ride `data-stream-metadata` live rather than only appearing on
	// reload. `null` (the initial value, and the best-effort fallback on any
	// skip/failure) simply omits the field from that payload — see
	// `sendEndAndClose` below, mirroring `thoughtSteps`'s `.length > 0` gate.
	let followUps: string[] | null = null;
	const sendEndAndClose = (
		userMsgId: string | undefined,
		assistantMsgId: string,
		waitingQuestionId?: string,
	) => {
		// Read at terminal time, not at setup time: `toolCallRecords` is the
		// runtime's live array and only holds this turn's records once the turn
		// has run. A turn that drafts a skill carries the draft card instead of
		// the offer: the two are alternative ways to keep something from this
		// turn, and the person is asked once.
		const instructionSuggestions = skillControl.metadata?.skillDrafts?.length
			? []
			: collectInstructionSuggestions(toolCallRecords);
		const streamDepthMetadata = withDepthMetadataModelInfo(
			depthMetadata ??
				buildBaselineDepthMetadata({
					reasoningDepth,
					modelId,
					modelDisplayName,
					providerDisplayName,
				}),
			{
				modelId,
				modelDisplayName,
				providerDisplayName,
			},
		);

		if (thinkingContent) {
			enqueueChunk(streamReasoningEndEvent());
		}
		if (finalResponse) {
			enqueueChunk(streamTextEndEvent());
		}
		enqueueChunk(
			streamDataPartEvent("data-stream-metadata", {
				thinkingTokenCount,
				responseTokenCount,
				totalTokenCount,
				thinking: thinkingContent || undefined,
				wasStopped,
				...(completionWarningCodes.length > 0
					? {
							completionWarningCodes,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				...(serverTimeline ? { serverTimeline } : {}),
				// P3d (ADR-0056) — the same thoughtSteps array already written to
				// assistantMetadata.thoughtSteps below (for persistence) also rides
				// the terminal data-stream-metadata payload, mirroring
				// completionWarningCodes just above. Without this, the same-session
				// client only ever saw steps after a page reload (the DB read
				// model); this closes that gap. Omitted entirely when empty,
				// mirroring completionWarningCodes.
				...(thoughtSteps.length > 0 ? { thoughtSteps } : {}),
				// Owner idea (variant A) — resolved just above, before this frame is
				// built; omitted entirely when there is nothing to show, mirroring
				// thoughtSteps/completionWarningCodes just above.
				...(followUps && followUps.length > 0 ? { followUps } : {}),
				// Slice F — the instruction offers this turn made. They are read off
				// the same records finalize writes them to the assistant message
				// from, so the Review/Dismiss row is on screen in the session that
				// produced it rather than only after a reload (the row is a
				// decision to make now: the model has just told the user it exists).
				...(instructionSuggestions.length > 0
					? { instructionSuggestions }
					: {}),
				// The skill drafts this turn proposed (parsed from the envelope
				// above, and persisted by finalize from the same records), so the
				// Save/Dismiss card is on screen in the session that produced it
				// rather than only after a reload. Omitted entirely when the turn
				// drafted nothing; a drafting turn never sends the instruction
				// offers just above.
				...(skillControl.metadata?.skillDrafts?.length
					? { skillDrafts: skillControl.metadata.skillDrafts }
					: {}),
				// The user's own choices for this turn — the same record written
				// to assistantMetadata.userIntent below, so the live provenance
				// line is server-authoritative rather than the client's guess.
				...(userIntent ? { userIntent } : {}),
				// Which instruction scopes the prompt carried — the same record
				// written to assistantMetadata.instructionsApplied below, so the
				// Info popover's row is there in the same session, not only after
				// a reload.
				...(preparedContext.instructionsApplied
					? { instructionsApplied: preparedContext.instructionsApplied }
					: {}),
				// Finding 4 — see repairedFinalContent above. Omitted entirely
				// when the citation repair changed nothing, mirroring
				// thoughtSteps/followUps just above.
				...(params.completionTurn ? { finalContent: finalResponse } : {}),
				...(repairedFinalContent !== null
					? { finalContent: repairedFinalContent }
					: {}),
				userMessageId: userMsgId,
				assistantMessageId: assistantMsgId,
				// The question a paused segment asked, named only when finalize tied
				// it to the saved message (the receipt says so): the page draws the
				// card from the question rows and reads them when it sees this.
				...(waitingQuestionId ? { waitingQuestionId } : {}),
				modelId,
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				depthMetadata: streamDepthMetadata,
				generationDurationMs: genTimeMs,
				// The post-turn context status (prompt tokens against the real
				// context window) rides the terminal payload so the header ring
				// updates in the same session, without a reload.
				...(completedContextStatus
					? { contextStatus: completedContextStatus }
					: {}),
			}),
		);
		enqueueChunk(
			streamFinishEvent(
				streamClosedWithoutFinish ? "error" : (upstreamFinishReason ?? "stop"),
			),
		);
		enqueueChunk(createUiMessageStreamDoneFrame());
		touchConversation(userId, conversationId).catch(() => undefined);
		if (streamId) clearStreamBuffer(streamId);
		closeDownstream();
	};

	const sendErrorAndClose = () => {
		enqueueChunk(streamErrorEvent("backend_failure"));
		if (streamId) clearStreamBuffer(streamId);
		closeDownstream();
	};

	// The ending of a turn that saved nothing because its conversation was
	// deleted: what a stopped turn ends with, minus the message ids it has none
	// of. The browser ends its turn the way it ends one the person stopped (no
	// error, no recovery, no reconnect, and a follow-up it had queued goes back
	// to the draft instead of being sent into a chat that is going). The frames
	// are sent before the buffer a reconnected reader listens on is cleared,
	// like every other ending.
	const sendStoppedAndClose = () => {
		if (thinkingContent) {
			enqueueChunk(streamReasoningEndEvent());
		}
		if (finalResponse) {
			enqueueChunk(streamTextEndEvent());
		}
		enqueueChunk(
			streamDataPartEvent("data-stream-metadata", { wasStopped: true }),
		);
		enqueueChunk(streamFinishEvent("stop"));
		enqueueChunk(createUiMessageStreamDoneFrame());
		if (streamId) clearStreamBuffer(streamId);
		closeDownstream();
	};

	// Deleting a chat stops the reply streaming into it (cleanup/
	// conversation-cleanup.ts) without waiting for the turn to end, so the turn
	// ends while the delete is still running and goes to save its answer into a
	// chat that is going or gone. That is no failure and there is nothing worth
	// saving: the turn ends quietly (`sendStoppedAndClose`) and starts no
	// post-turn work. A turn is only treated so when a stop was asked for it and
	// the conversation itself reads as gone: a turn nobody stopped that cannot
	// save its answer failed for real, and a read that fails proves nothing, so
	// both are left to the error ending.
	const endQuietlyWhenItsChatWasDeleted = async (): Promise<boolean> => {
		if (
			!wasStopped &&
			!wasActiveChatStreamStopRequested({ streamId, userId })
		) {
			return false;
		}
		let conversation: Awaited<ReturnType<typeof getConversation>> | undefined;
		try {
			conversation = await getConversation(userId, conversationId);
		} catch {
			return false;
		}
		if (conversation !== null) return false;
		console.info(
			"[CHAT_STREAM] Stopped turn ended after its conversation was deleted; nothing was saved",
			{ conversationId, streamId },
		);
		sendStoppedAndClose();
		return true;
	};

	try {
		if (await endQuietlyWhenItsChatWasDeleted()) return;
		params.persistenceSignal?.throwIfAborted();
		const persistedAssistantResponse =
			wasStopped && !params.completionTurn && finalResponse.trim().length === 0
				? "Stopped"
				: finalResponse;
		// The language of the conversation for the person, named once after the
		// reply (reply-language.ts: the model's answer, else the deterministic
		// chain): the follow-up chips, the rail headline and the title below all
		// follow it, and the message records it, never a guess made before the
		// reply. Best-effort: a failure here is the account's UI language, never a
		// failed turn.
		const turnLanguage = finalResponse.trim()
			? await resolveTurnReplyLanguage({
					userId,
					conversationId,
					reply: finalResponse,
					latestUserMessage: normalizedMessage,
					uiLanguage,
				}).catch(() => null)
			: null;
		const responseLanguage = turnLanguage?.language ?? uiLanguage ?? "en";
		params.persistenceSignal?.throwIfAborted();
		// Issue 7.5 — resolved (not deferred) here: by the time the stream has
		// fully finished, every pending write this turn's tool calls created
		// already exists in the DB (createPendingWrite is awaited inside the
		// tool's own execute(), long before this point) — unlike file
		// production's background-worker jobs there is no "might still be
		// racing to appear" window to wait out.
		const pendingWriteIdsAtStart =
			(hadFileProductionToolCall || hadConnectionWriteToolCall) &&
			pendingWriteIdsAtStartFact !== undefined
				? await resolvePendingWriteIdsAtStartFact({
						conversationId,
						streamId,
						fact: pendingWriteIdsAtStartFact,
					})
				: undefined;
		// Resolve the reset-generation fact here so finalize's post-turn tail
		// receives the concrete value. The fact is pre-warmed at request start
		// (see startStartedResetGenerationFact), so this await settles a
		// resolved promise rather than blocking the terminal receipt; a rejected
		// fact degrades to undefined and the turn still finalizes.
		const startedResetGeneration = await resolveStartedResetGenerationFact({
			conversationId,
			streamId,
			fact: startedResetGenerationFact,
		});
		params.persistenceSignal?.throwIfAborted();
		// Fold the completed turn's prompt usage (provider-reported input
		// tokens, else the wrapper's full-prompt estimate) into the context
		// status before finalize persists it and the terminal frames flush.
		// Never throws; degrades to the pre-request status.
		completedContextStatus = await recordCompletedTurnContextUsage({
			userId,
			conversationId,
			contextStatus: preparedContext.contextStatus,
			providerUsage: latestProviderUsage,
			estimatedPromptTokens: preparedContext.estimatedPromptTokens,
			logPrefix: "[CHAT_STREAM]",
		});
		params.persistenceSignal?.throwIfAborted();
		// Owner idea (variant A) — up to two short follow-up questions for this
		// turn. Skipped (never attempted) when the turn was stopped early, a
		// tool call is still mid-flight, or there is no finished answer to base
		// them on; Atlas mode needs no check here — see the module doc on
		// generateFollowUpSuggestions. Best-effort: any failure/timeout/
		// implausible-output already degrades to `null` inside that call, and
		// the `.catch` below is belt-and-suspenders so a genuinely unexpected
		// throw can never fail (or even delay past its own timeout) this turn.
		const toolCallsStillRunning = toolCallRecords.some(
			(record) => record.status === "running",
		);
		// A paused segment is not a finished reply: the chips come with the segment
		// that finishes it, after the person's answer. A turn that ended without its
		// final answer has nothing to follow up either: a chip is the person's next
		// message about what the reply says, and this reply has not said it.
		if (
			!askPause &&
			!wasStopped &&
			!noFinalAnswer &&
			!toolCallsStillRunning &&
			finalResponse.trim()
		) {
			// The prepared-context snapshot this boundary receives carries no
			// message rows (context-selection loads the history for the prompt
			// deep inside prepareTurn and never surfaces it here), so the few
			// turns the suggester needs come from one bounded read of the
			// messages service instead — newest-first with a small LIMIT, the
			// same window helper the conversation-open read path uses. This turn
			// is not in it: finalizeChatTurn persists the user + assistant rows
			// below, after this point, so the window holds exactly the PRIOR
			// turns. Best-effort like everything else on this path: a failed read
			// degrades to no history section, never to a failed turn.
			const recentMessages = await listMessageWindow(conversationId, {
				limit: FOLLOW_UP_SUGGESTIONS_HISTORY_MESSAGE_LIMIT,
			})
				.then((page) =>
					page.messages.filter(
						(message) =>
							message.role === "user" || message.role === "assistant",
					),
				)
				.catch(() => []);
			const recentHistory = recentMessages.map((message) => ({
				role: message.role as "user" | "assistant",
				content: message.content,
			}));
			params.persistenceSignal?.throwIfAborted();
			// The marks this window's messages and this turn carried: only a chat
			// that had marks is told they are gone, and has its chips checked for them.
			const goneMarkLetters = goneMarkLettersOf([
				...recentMessages,
				{ pictures: preparedContext.userPictures ?? null },
			]);
			followUps = await generateFollowUpSuggestions({
				signal: params.persistenceSignal,
				userId,
				conversationId,
				userMessage: normalizedMessage,
				assistantResponse: finalResponse,
				recentHistory,
				responseLanguage,
				goneMarkLetters,
			}).catch((error) => {
				console.error("[CHAT_STREAM] Follow-up suggestions failed", {
					conversationId,
					streamId,
					error,
				});
				return null;
			});
		}
		params.persistenceSignal?.throwIfAborted();
		await finalizeChatTurn({
			persistenceSignal: params.persistenceSignal,
			onPersistenceStarted: params.onPersistenceStarted,
			completionTurn: params.completionTurn,
			turnKind: "stream",
			streamId,
			userId,
			conversationId,
			userMessageContent: userMessageToPersist,
			persistUserMessage,
			normalizedMessage,
			upstreamMessage,
			assistantResponse: persistedAssistantResponse,
			assistantThinking: thinkingContent || undefined,
			serverSegments: savedSegments.length > 0 ? savedSegments : undefined,
			assistantMetadata: {
				completion,
				evidenceStatus: "pending",
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				...(wasStopped ? { wasStopped: true } : {}),
				// The row this segment carries on: a reply that paused is consecutive
				// rows, each naming the one before it (messages.ts projects it).
				...(askResume ? { continuesMessageId: askResume.askedMessageId } : {}),
				// The language the conversation was in for the person at this reply
				// (a later turn whose call fails falls back to it: messages.ts
				// getLastConversationLanguage) and what the words of the reply say.
				...(turnLanguage
					? {
							conversationLanguage: turnLanguage.language,
							replyLanguage: turnLanguage.reply,
						}
					: {}),
				...(completionWarningCodes.length > 0
					? {
							completionWarningCodes,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				// P3b (ADR-0056) — durable turn state, read back by the ADR-0022
				// read model via parseThoughtSteps (messages.ts's
				// projectMessageMetadata). Omitted entirely when empty, mirroring
				// completionWarningCodes just above.
				...(thoughtSteps.length > 0 ? { thoughtSteps } : {}),
				// Citation auto-repair summary (web-citation-audit.ts). Omitted when
				// no web-grounding tool ran this turn (nothing to check), mirroring
				// completionWarningCodes just above.
				...(citationGate?.repair ? { citationAudit: citationGate.repair } : {}),
				// Follow-up chips — persisted additively (same paved road as
				// thoughtSteps/railSummary) so a reloaded page still shows the same
				// suggestions the live session got on the terminal frame above.
				...(followUps && followUps.length > 0 ? { followUps } : {}),
				// What the USER chose for this turn — read by the provenance line
				// instead of the tool calls. Omitted entirely when they chose
				// nothing, mirroring followUps just above.
				...(userIntent ? { userIntent } : {}),
				// Which instruction scopes the prompt carried, for the Info
				// popover. Omitted entirely when no scope applied, mirroring
				// followUps just above.
				...(preparedContext.instructionsApplied
					? { instructionsApplied: preparedContext.instructionsApplied }
					: {}),
				...skillControl.metadata,
			},
			reasoningDepth,
			depthMetadata,
			attachmentIds,
			userPictures: preparedContext.userPictures,
			activeDocumentArtifactId,
			contextStatus: completedContextStatus ?? null,
			initialTaskState: preparedContext.taskState,
			initialContextDebug: preparedContext.contextDebug,
			analytics: {
				model: analyticsModel,
				modelDisplayName,
				promptTokens: estimateTokenCount(upstreamMessage),
				completionTokens: responseTokenCount,
				reasoningTokens: thinkingTokenCount,
				generationTimeMs: genTimeMs,
				// ADR-0042 amendment — server stream-timeline marks, threaded
				// through to messageAnalytics for observability. firstByteMs
				// falls back to MODEL_STREAM_REQUEST (the request was sent, even
				// if no upstream event ever arrived) when FIRST_UPSTREAM_EVENT
				// was never reached.
				firstByteMs: readServerTimelineMarkMs(
					serverTimeline,
					SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT,
					SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST,
				),
				firstThinkingMs: readServerTimelineMarkMs(
					serverTimeline,
					SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING,
				),
				firstTokenMs: readServerTimelineMarkMs(
					serverTimeline,
					SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN,
				),
				providerUsage: latestProviderUsage,
			},
			assistantMirrorContent: wasStopped ? "" : finalResponse,
			maintenanceReason: "chat_stream",
			startedResetGeneration,
			responseLanguage,
			toolCalls: toolCallRecords,
			skillUse,
			turnOrigin,
			contextTraceSections: preparedContext.contextTraceSections,
			webCitationAudit: citationGate?.audit,
			persistTurnState: !wasStopped,
			ask:
				askPause || askResume
					? {
							...(askPause ? { pause: askPause } : {}),
							...(askResume
								? {
										resume: {
											questionId: askResume.questionId,
											claim: askResume.claim,
											askedMessageId: askResume.askedMessageId,
											askToolCallId: askResume.askToolCallId,
											answerDigest: askResume.answerDigest,
										},
									}
								: {}),
						}
					: undefined,
			generatedOutputReconciliation:
				hadFileProductionToolCall || hadConnectionWriteToolCall
					? {
							fileProductionToolCalls: rawFileProductionToolCalls,
							getFileProductionJobs,
							assignFileProductionJobsToAssistantMessage,
							syncGeneratedFilesToMemory,
							getChatFilesForAssistantMessage,
							pendingWriteIdsAtStart,
						}
					: undefined,
			// finalizeChatTurn owns scheduling the deferred post-turn projection
			// itself (ADR-0015) — this hook is invoked and awaited once the
			// durable message identities are known, before that background work
			// starts, so the terminal SSE frames flush at the right moment. No
			// promise or task-starting function comes back from finalizeChatTurn
			// for this transport to separately schedule.
			onDurableReceiptReady: async (receipt) => {
				console.info(
					`[TURN_END] end=${completion.end} finish=${completion.finish ?? "none"} steps=${completion.steps ?? "?"} lastStepOut=${completion.lastStepOutputTokens ?? "?"} afterLastTool=${completion.charsAfterLastToolCall} stripped=${completion.strippedChars} recovery=${completion.recovery} dropped=${completion.droppedToolCalls ?? "?"} model=${modelId ?? "none"}`,
				);
				sendEndAndClose(
					receipt.userMessage?.id,
					receipt.assistantMessage.id,
					receipt.waitingQuestionId,
				);
			},
		});
		return;
	} catch (error) {
		// The chat can go between the first look and the save: the save then fails.
		if (await endQuietlyWhenItsChatWasDeleted()) return;
		console.error(
			"[CHAT_STREAM] Stream finalization failed before terminal receipt",
			{
				conversationId,
				streamId,
				error,
			},
		);
		if (
			error instanceof FileAssociationFinalizationError &&
			error.modelCompletion &&
			streamId
		) {
			const observation = {
				version: 1 as const,
				state: "terminal" as const,
				streamId,
				conversationId,
				assistantMessageId: error.assistantMessageId,
				normalChatFinalization: error.normalChatFinalization,
				modelCompletion: error.modelCompletion,
				completion:
					projectNormalChatFinalization(
						error.modelCompletion,
						error.normalChatFinalization,
					) ?? error.modelCompletion,
			};
			enqueueChunk(
				streamDataPartEvent("data-stream-metadata", {
					observation,
					finalContent: error.finalContent,
					assistantMessageId: error.assistantMessageId,
					normalChatFinalization: error.normalChatFinalization,
				}),
			);
			enqueueChunk(
				streamFinishEvent(
					error.normalChatFinalization.wasStopped ||
						observation.completion.outcome === "stopped"
						? "stop"
						: "error",
				),
			);
			enqueueChunk(createUiMessageStreamDoneFrame());
			if (streamId) clearStreamBuffer(streamId);
			closeDownstream();
			return;
		}
		sendErrorAndClose();
		return;
	}
}

function resolveCompletionFact<T>(fact: StreamCompletionFact<T>): Promise<T> {
	return Promise.resolve(fact);
}

async function resolveStartedResetGenerationFact(params: {
	conversationId: string;
	streamId: string | null;
	fact: StreamCompletionFact<number> | undefined;
}): Promise<number | undefined> {
	if (params.fact === undefined) return undefined;

	try {
		return await resolveCompletionFact(params.fact);
	} catch (error) {
		console.warn(
			"[CHAT_STREAM] Failed to resolve stream reset generation fact",
			{
				conversationId: params.conversationId,
				streamId: params.streamId,
				error,
			},
		);
		return undefined;
	}
}

// Pending-write snapshot failure remains best effort and independent of file ownership.
async function resolvePendingWriteIdsAtStartFact(params: {
	conversationId: string;
	streamId: string | null;
	fact: StreamCompletionFact<Set<string>>;
}): Promise<Set<string> | undefined> {
	try {
		return await resolveCompletionFact(params.fact);
	} catch (error) {
		console.warn(
			"[CHAT_STREAM] Failed to snapshot pending writes at stream start",
			{
				conversationId: params.conversationId,
				streamId: params.streamId,
				error,
			},
		);
		return undefined;
	}
}

// Settles the ask calls of a reply saved without a pause, with what a later
// turn's history reads of an ask call whose question was discarded with its
// reply (`ASK_STOPPED_BEFORE_ANSWER` and `ASK_ENDED_BEFORE_ANSWER`, shared with the
// resume that closes a question it can never carry on). The summary says it and
// the digest stays as it was, which for a call that paused is none: history
// replays the summary and the digest as two fields of the call's result, so
// setting both would say the sentence twice. Only a call that
// paused the reply (`askCallPausedTheReply`, the one test history uses too) is
// rewritten: a card the tool refused asked nobody and keeps what the model was
// told.
function settleUnansweredAskCalls(
	segments: ThinkingSegment[],
	summary: string,
): ThinkingSegment[] {
	return segments.map((segment) =>
		segment.type === "tool_call" && askCallPausedTheReply(segment)
			? { ...segment, outputSummary: summary }
			: segment,
	);
}

// ADR-0042 amendment — reads a server stream-timeline mark (ms elapsed since
// turn start, measured server-side) for persistence into messageAnalytics.
// This is observability, not a turn input: any missing/malformed/throwing
// read degrades to `undefined` rather than failing or altering the turn. The
// marks in `serverTimeline.server` are already validated finite/non-negative
// numbers by createTerminalStreamTimelinePayload, but this stays defensive so
// a future change to that shape can never surface here as a thrown error.
function readServerTimelineMarkMs(
	serverTimeline: StreamTimelineTerminalPayload | undefined,
	mark: ServerStreamTimelineMark,
	fallbackMark?: ServerStreamTimelineMark,
): number | undefined {
	try {
		const value = serverTimeline?.server?.[mark];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
			return value;
		}
		if (fallbackMark) {
			const fallbackValue = serverTimeline?.server?.[fallbackMark];
			if (
				typeof fallbackValue === "number" &&
				Number.isFinite(fallbackValue) &&
				fallbackValue >= 0
			) {
				return fallbackValue;
			}
		}
		return undefined;
	} catch {
		return undefined;
	}
}

// E1 — replaces buildFileProductionFailureNotice + buildCompletionWarning
// (which each returned an English sentence, concatenated into the message
// body by the caller via appendNotices). Both notices collapse into one
// array of stable ChatTurnCompletionWarningCode values that ride
// data-stream-metadata / assistantMetadata instead — E2 (client) owns
// localizing them into copy.
function buildCompletionWarningCodes(params: {
	toolCallRecords: ToolCallEntry[];
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
	noFinalAnswer?: boolean;
}): ChatTurnCompletionWarningCode[] {
	const codes: ChatTurnCompletionWarningCode[] = [];
	if (hasFailedFileProductionToolCall(params.toolCallRecords)) {
		codes.push("file_production_failed");
	}
	const finishWarningCode = classifyCompletionFinishWarning(params);
	if (finishWarningCode) {
		codes.push(finishWarningCode);
	}
	if (params.noFinalAnswer) {
		codes.push("no_final_answer");
	}
	return codes;
}

function hasFailedFileProductionToolCall(
	toolCallRecords: ToolCallEntry[],
): boolean {
	return toolCallRecords.some(
		(record) =>
			isFileProductionToolName(record.name) &&
			record.status !== "running" &&
			record.metadata?.ok === false,
	);
}

function classifyCompletionFinishWarning(params: {
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
}): ChatTurnCompletionWarningCode | null {
	if (params.streamClosedWithoutFinish) {
		return "stream_closed_without_finish";
	}
	switch (params.upstreamFinishReason) {
		case "length":
			return "output_truncated";
		case "content-filter":
			return "content_filtered";
		case "error":
			return "provider_error";
		case "other":
			return "non_standard_finish";
		default:
			return null;
	}
}
