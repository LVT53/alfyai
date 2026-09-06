import type { FinishReason } from "ai";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { InterimThoughtStep } from "$lib/response-activity-types";
import { getConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { getChatFilesForAssistantMessage } from "$lib/server/services/chat-files";
import { recordCompletedTurnContextUsage } from "$lib/server/services/chat-turn/context-usage";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { finalizeChatTurn } from "$lib/server/services/chat-turn/finalize";
import type { FileProductionJob } from "$lib/server/services/file-production/types";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type {
	ChatTurnCompletionWarningCode,
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import type { TaskState } from "$lib/server/services/task-state/types";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import {
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import {
	isConnectionWriteToolName,
	isFileProductionToolName,
} from "$lib/utils/tool-calls";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
import { generateFollowUpSuggestions } from "./follow-up-suggestions";
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
};

export type FileProductionStartSnapshot =
	| Set<string>
	| {
			jobIds: Set<string>;
			snapshotStartedAt: number;
	  };

type NormalizedFileProductionStartSnapshot = {
	jobIds: Set<string>;
	snapshotStartedAt?: number;
};

export interface StreamCompletionFacts {
	startedResetGeneration?: StreamCompletionFact<number>;
	fileProductionJobIdsAtStart: StreamCompletionFact<FileProductionStartSnapshot>;
	// Issue 7.5 — sibling fact to fileProductionJobIdsAtStart, resolved
	// (not deferred) at completion time: see startPendingWriteIdsAtStartFact
	// in stream-orchestrator.ts for why pending writes don't need the
	// deferred-until-ready dance file production's background worker
	// requires.
	pendingWriteIdsAtStart?: StreamCompletionFact<Set<string>>;
}

export interface CompleteStreamTurnParams extends StreamCompletionFacts {
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
	isReconnect: boolean | undefined;
	thinkingContent: string;
	fullResponse: string;
	toolCallRecords: ToolCallEntry[];
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
	linkedSources: LinkedContextSource[];
	// Analytics overhaul (backend half) — threaded straight into
	// finalizeChatTurn's skillUse param; see its doc comment.
	skillUse?: { displayName: string } | null;
	activeDocumentArtifactId: string | null;
	requestStartTime: number;
	preparedContext: PreparedContextSnapshot;
	latestProviderUsage: ProviderUsageSnapshot | null;
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
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
		isReconnect,
		thinkingContent,
		fullResponse,
		toolCallRecords,
		thoughtSteps = [],
		skillControlEnvelopePayloads,
		skillControlEnabled = true,
		serverSegments,
		attachmentIds,
		linkedSources,
		skillUse,
		activeDocumentArtifactId,
		requestStartTime,
		fileProductionJobIdsAtStart: fileProductionJobIdsAtStartFact,
		pendingWriteIdsAtStart: pendingWriteIdsAtStartFact,
		preparedContext,
		latestProviderUsage,
		upstreamFinishReason = "stop",
		upstreamRawFinishReason = null,
		streamClosedWithoutFinish = false,
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
			});
	const citationGate = wasStopped
		? null
		: applyWebCitationQualityGate({
				assistantResponse: fullResponse,
				toolCalls: toolCallRecords,
				userMessage: normalizedMessage,
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
			? parseSkillControlEnvelopePayloads(skillControlEnvelopePayloads)
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
	const hadFileProductionToolCall = toolCallSummary.some((record) =>
		isFileProductionToolName(record.name),
	);
	// Issue 7.5 — widens the generatedOutputReconciliation gate below so a
	// turn that only called a connection tool (files/calendar/email/photos,
	// e.g. proposing a write) still gets its pending writes reconciled, even
	// when no file-production tool call happened this turn.
	const hadConnectionWriteToolCall = toolCallSummary.some((record) =>
		isConnectionWriteToolName(record.name),
	);
	const deferredFileProductionJobIdsAtStart = new Set<string>();
	let fileProductionReconciliationReady = !hadFileProductionToolCall;
	let fileProductionReconciliationSkipped = false;
	const getDeferredFileProductionJobs = async (
		requestUserId: string,
		requestConversationId: string,
	): Promise<FileProductionJob[]> => {
		if (
			!fileProductionReconciliationReady ||
			fileProductionReconciliationSkipped
		) {
			throw new Error(
				"File-production start snapshot was unavailable for deferred stream reconciliation",
			);
		}
		return getFileProductionJobs(requestUserId, requestConversationId);
	};

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
	) => {
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
				// Finding 4 — see repairedFinalContent above. Omitted entirely
				// when the citation repair changed nothing, mirroring
				// thoughtSteps/followUps just above.
				...(repairedFinalContent !== null
					? { finalContent: repairedFinalContent }
					: {}),
				userMessageId: userMsgId,
				assistantMessageId: assistantMsgId,
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

	try {
		const persistedAssistantResponse =
			wasStopped && finalResponse.trim().length === 0
				? "Stopped"
				: finalResponse;
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
		if (!wasStopped && !toolCallsStillRunning && finalResponse.trim()) {
			followUps = await generateFollowUpSuggestions({
				userId,
				conversationId,
				userMessage: normalizedMessage,
				assistantResponse: finalResponse,
			}).catch((error) => {
				console.error("[CHAT_STREAM] Follow-up suggestions failed", {
					conversationId,
					streamId,
					error,
				});
				return null;
			});
		}
		await finalizeChatTurn({
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
			serverSegments: serverSegments.length > 0 ? serverSegments : undefined,
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				...(wasStopped ? { wasStopped: true } : {}),
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
				...skillControl.metadata,
			},
			reasoningDepth,
			depthMetadata,
			attachmentIds,
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
			toolCalls: toolCallRecords,
			skillUse,
			contextTraceSections: preparedContext.contextTraceSections,
			webCitationAudit: citationGate?.audit,
			linkedSources,
			persistTurnState: !wasStopped,
			generatedOutputReconciliation:
				hadFileProductionToolCall || hadConnectionWriteToolCall
					? {
							fileProductionJobIdsAtStart: deferredFileProductionJobIdsAtStart,
							getFileProductionJobs: getDeferredFileProductionJobs,
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
				sendEndAndClose(receipt.userMessage?.id, receipt.assistantMessage.id);

				if (!hadFileProductionToolCall) return;

				try {
					const fileProductionStartSnapshot =
						await resolveFileProductionJobIdsAtStart({
							conversationId,
							streamId,
							fact: fileProductionJobIdsAtStartFact,
						});
					const fileProductionJobIdsAtStart = fileProductionStartSnapshot
						? await buildEffectiveFileProductionJobIdsAtStart({
								userId,
								conversationId,
								snapshot: fileProductionStartSnapshot,
								toolCallRecords,
								getFileProductionJobs,
							})
						: null;

					deferredFileProductionJobIdsAtStart.clear();
					if (fileProductionJobIdsAtStart) {
						for (const jobId of fileProductionJobIdsAtStart) {
							deferredFileProductionJobIdsAtStart.add(jobId);
						}
						fileProductionReconciliationSkipped = false;
					} else {
						fileProductionReconciliationSkipped = true;
					}
				} catch (error) {
					// Defensive only — resolveFileProductionJobIdsAtStart and
					// buildEffectiveFileProductionJobIdsAtStart already catch their
					// own failures internally. This local catch exists so an
					// unexpected throw here degrades to "skip reconciliation"
					// instead of rejecting onDurableReceiptReady, which has already
					// sent the terminal receipt above and must not fail the turn.
					console.error(
						"[CHAT_STREAM] Deferred file-production snapshot resolution failed",
						{ conversationId, streamId, error },
					);
					fileProductionReconciliationSkipped = true;
				} finally {
					fileProductionReconciliationReady = true;
				}
			},
		});
		return;
	} catch (error) {
		console.error(
			"[CHAT_STREAM] Stream finalization failed before terminal receipt",
			{
				conversationId,
				streamId,
				error,
			},
		);
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

// Issue 7.5 — resolves startPendingWriteIdsAtStartFact's snapshot. Unlike
// resolveFileProductionJobIdsAtStart below, there is no "deferred, wait for
// ready" dance: this is awaited directly at stream-completion time (see the
// call site above), so a failure here just means pending-write
// reconciliation is skipped for this turn (best-effort, never blocks or
// fails the turn itself).
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

async function resolveFileProductionJobIdsAtStart(params: {
	conversationId: string;
	streamId: string | null;
	fact: StreamCompletionFact<FileProductionStartSnapshot>;
}): Promise<NormalizedFileProductionStartSnapshot | null> {
	try {
		return normalizeFileProductionStartSnapshot(
			await resolveCompletionFact(params.fact),
		);
	} catch (error) {
		console.warn(
			"[CHAT_STREAM] Failed to snapshot file-production jobs at stream start",
			{
				conversationId: params.conversationId,
				streamId: params.streamId,
				error,
			},
		);
		return null;
	}
}

function normalizeFileProductionStartSnapshot(
	snapshot: FileProductionStartSnapshot,
): NormalizedFileProductionStartSnapshot {
	return snapshot instanceof Set
		? { jobIds: snapshot }
		: {
				jobIds: snapshot.jobIds,
				snapshotStartedAt: Number.isFinite(snapshot.snapshotStartedAt)
					? snapshot.snapshotStartedAt
					: undefined,
			};
}

async function buildEffectiveFileProductionJobIdsAtStart(params: {
	userId: string;
	conversationId: string;
	snapshot: NormalizedFileProductionStartSnapshot;
	toolCallRecords: ToolCallEntry[];
	getFileProductionJobs: (
		userId: string,
		conversationId: string,
	) => Promise<FileProductionJob[]>;
}): Promise<Set<string>> {
	const effectiveJobIds = new Set(params.snapshot.jobIds);

	for (const jobId of getSameTurnFileProductionJobIds(params.toolCallRecords)) {
		effectiveJobIds.delete(jobId);
	}

	if (params.snapshot.snapshotStartedAt === undefined) {
		return effectiveJobIds;
	}

	const currentJobs = await params
		.getFileProductionJobs(params.userId, params.conversationId)
		.catch(() => [] as FileProductionJob[]);
	for (const job of currentJobs) {
		if (
			effectiveJobIds.has(job.id) &&
			Number.isFinite(job.createdAt) &&
			job.createdAt >= params.snapshot.snapshotStartedAt
		) {
			effectiveJobIds.delete(job.id);
		}
	}

	return effectiveJobIds;
}

function getSameTurnFileProductionJobIds(
	toolCallRecords: ToolCallEntry[],
): Set<string> {
	const jobIds = new Set<string>();
	for (const record of toolCallRecords) {
		if (!isFileProductionToolName(record.name) || record.status !== "done") {
			continue;
		}
		const jobId = record.metadata?.jobId;
		if (typeof jobId === "string" && jobId.trim()) {
			jobIds.add(jobId.trim());
		}
	}
	return jobIds;
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
}): ChatTurnCompletionWarningCode[] {
	const codes: ChatTurnCompletionWarningCode[] = [];
	if (hasFailedFileProductionToolCall(params.toolCallRecords)) {
		codes.push("file_production_failed");
	}
	const finishWarningCode = classifyCompletionFinishWarning(params);
	if (finishWarningCode) {
		codes.push(finishWarningCode);
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
