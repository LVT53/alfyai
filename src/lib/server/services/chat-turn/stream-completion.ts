import type { FinishReason } from "ai";
import { getConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import type { getChatFilesForAssistantMessage } from "$lib/server/services/chat-files";
import { finalizeChatTurn } from "$lib/server/services/chat-turn/finalize";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import {
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
	type StreamTimelineTerminalPayload,
} from "$lib/services/stream-timeline";
import type {
	ContextDebugState,
	ConversationContextStatus,
	DepthMetadata,
	FileProductionJob,
	LinkedContextSource,
	ReasoningDepth,
	TaskState,
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/types";
import {
	isConnectionWriteToolName,
	isFileProductionToolName,
} from "$lib/utils/tool-calls";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
import { parseSkillControlEnvelopePayloads } from "./skill-control-envelope";
import {
	createUiMessageStreamDoneFrame,
	streamDataPartEvent,
	streamErrorEvent,
	streamFinishEvent,
	streamReasoningEndEvent,
	streamTextDeltaEvent,
	streamTextEndEvent,
	streamTextStartEvent,
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
	skillControlEnvelopePayloads: string[];
	skillControlEnabled?: boolean;
	serverSegments: ThinkingSegment[];
	attachmentIds: string[];
	linkedSources: LinkedContextSource[];
	activeSkillSessionId?: string | null;
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
		skillControlEnvelopePayloads,
		skillControlEnabled = true,
		serverSegments,
		attachmentIds,
		linkedSources,
		activeSkillSessionId,
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

	const fileProductionFailureNotice = wasStopped
		? null
		: buildFileProductionFailureNotice(toolCallRecords);
	const completionWarning = wasStopped
		? null
		: buildCompletionWarning({
				upstreamFinishReason,
				upstreamRawFinishReason,
				streamClosedWithoutFinish,
			});
	const completionNotices = [
		fileProductionFailureNotice,
		completionWarning,
	].filter((notice): notice is string => Boolean(notice));
	const responseBeforeCitationNotice = appendNotices(
		fullResponse,
		completionNotices,
	);
	const citationGate = wasStopped
		? null
		: applyWebCitationQualityGate({
				assistantResponse: responseBeforeCitationNotice,
				toolCalls: toolCallRecords,
			});
	const finalResponse = citationGate?.response ?? responseBeforeCitationNotice;
	const skillControl = wasStopped
		? { operations: [] }
		: skillControlEnabled
			? parseSkillControlEnvelopePayloads(skillControlEnvelopePayloads)
			: { operations: [] };
	if (completionNotices.length > 0) {
		if (!fullResponse) {
			enqueueChunk(streamTextStartEvent());
		}
		enqueueChunk(
			streamTextDeltaEvent(
				`${fullResponse.trim() ? "\n\n" : ""}${completionNotices.join("\n\n")}`,
			),
		);
	}
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
				...(completionWarning
					? {
							completionWarning,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				...(serverTimeline ? { serverTimeline } : {}),
				userMessageId: userMsgId,
				assistantMessageId: assistantMsgId,
				modelId,
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				depthMetadata: streamDepthMetadata,
				generationDurationMs: genTimeMs,
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
				...(completionWarning
					? {
							completionWarning,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				...skillControl.metadata,
			},
			reasoningDepth,
			depthMetadata,
			skillControlOperations: skillControl.operations,
			skillControlSessionId: activeSkillSessionId ?? null,
			attachmentIds,
			activeDocumentArtifactId,
			contextStatus:
				preparedContext.contextStatus as ConversationContextStatus | null,
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

function appendNotices(response: string, notices: string[]): string {
	if (notices.length === 0) return response;
	const suffix = notices.join("\n\n");
	return response.trim() ? `${response}\n\n${suffix}` : suffix;
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

function buildFileProductionFailureNotice(
	toolCallRecords: ToolCallEntry[],
): string | null {
	const hasFailedFileProductionCall = toolCallRecords.some(
		(record) =>
			isFileProductionToolName(record.name) &&
			record.status === "done" &&
			record.metadata?.ok === false,
	);
	return hasFailedFileProductionCall
		? "Note: File production failed. Check the file card for details or retry the job."
		: null;
}

function buildCompletionWarning(params: {
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
}): string | null {
	if (params.streamClosedWithoutFinish) {
		return "Note: The upstream model stream ended before a normal completion signal, so this answer may be incomplete.";
	}
	switch (params.upstreamFinishReason) {
		case "length":
			return "Note: The model reached its output limit, so this answer may be incomplete.";
		case "content-filter":
			return "Note: The provider stopped part of the response because of a content filter, so this answer may be incomplete.";
		case "error":
			return "Note: The provider reported an error at the end of the stream, so this answer may be incomplete.";
		case "other":
			return "Note: The provider stopped with a non-standard finish reason, so this answer may be incomplete.";
		default:
			return null;
	}
}
