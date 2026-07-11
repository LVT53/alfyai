import type { FinishReason } from "ai";
import { getConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import {
	appendToStreamBuffer,
	broadcastStreamChunk,
	clearStreamBuffer,
	getOrCreateStreamBuffer,
	getOrphanedStream,
	getStreamBuffer,
	isStreamActive,
	registerActiveChatStream,
	subscribeToStream,
	unregisterActiveChatStream,
	unsubscribeFromStream,
	wasActiveChatStreamStopRequested,
} from "$lib/server/services/chat-turn/active-streams";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import {
	classifyStreamError,
	createEventStreamResponse,
	createServerChunkRuntime,
	createSseHeartbeatComment,
	createSsePreludeComment,
	isAbruptUpstreamTermination,
	type StreamPhaseTimings,
	streamErrorEvent,
	streamRequestErrorEvent,
	streamResponseActivityEvent,
} from "$lib/server/services/chat-turn/stream";
import {
	completeStreamTurn,
	type FileProductionStartSnapshot,
	type StreamCompletionFact,
} from "$lib/server/services/chat-turn/stream-completion";
import { runNonStreamFallback } from "$lib/server/services/chat-turn/stream-fallback";
import {
	shouldFallbackOnAbruptTermination,
	shouldFallbackOnStreamConnectFailure,
	shouldFallbackOnStreamError,
	shouldFallbackOnUpstreamErrorEvent,
} from "$lib/server/services/chat-turn/stream-fallback-policy";
import { createUpstreamIdleTimeout } from "$lib/server/services/chat-turn/stream-idle-timeout";
import { doReconnect as runReconnect } from "$lib/server/services/chat-turn/stream-reconnect";
import { arbitrateStreamStart } from "$lib/server/services/chat-turn/stream-reconnect-arbiter";
import { createStreamTerminal } from "$lib/server/services/chat-turn/stream-terminal";
import { runStreamingNormalChatSendModel } from "$lib/server/services/chat-turn/streaming-normal-chat-model-run";
import type {
	AdmittedChatTurn,
	ChatTurnPreflight,
	ChatTurnPreparationResult,
} from "$lib/server/services/chat-turn/types";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { touchConversation } from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile";
import { mapNormalChatModelRunUsageToProviderSnapshot } from "$lib/server/services/normal-chat-model";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import type { StreamErrorCode } from "$lib/services/stream-protocol";
import {
	createFallbackResponseActivityId,
	createTerminalStreamTimelinePayload,
	RESPONSE_ACTIVITY_IDS,
	recordContextPreparationTimelineTimings,
	recordDurationStreamTimelineMark,
	recordElapsedStreamTimelineMark,
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
} from "$lib/services/stream-timeline";
import type {
	ContextDebugState,
	ConversationContextStatus,
	DepthMetadata,
	ModelId,
	ResponseActivityEntry,
	TaskState,
	ToolCallEntry,
} from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { isFileProductionToolName } from "$lib/utils/tool-calls";
import type { StreamingNormalChatPreparedContext } from "./streaming-normal-chat-model-run";

function getStreamTimeoutMs(): number {
	return Math.max(60_000, getConfig().requestTimeoutMs);
}

function truncateFallbackToolText(value: unknown, maxLength: number): string {
	let text = "";
	try {
		text = typeof value === "string" ? value : JSON.stringify(value ?? null);
	} catch {
		text = "[unserializable tool payload]";
	}
	if (!text) return "";
	return text.length <= maxLength ? text : `${text.slice(0, maxLength)}...`;
}

function buildCompletedToolCallFallbackContext(
	toolCalls: ToolCallEntry[],
): string | null {
	const completed = toolCalls
		.filter(
			(toolCall) =>
				toolCall.status === "done" && !isFileProductionToolName(toolCall.name),
		)
		.slice(0, 8);
	if (completed.length === 0) return null;

	return completed
		.map((toolCall, index) => {
			const candidates = (toolCall.candidates ?? []).slice(0, 4);
			const candidateLines = candidates.map((candidate, candidateIndex) => {
				const title = truncateFallbackToolText(candidate.title, 160);
				const snippet = truncateFallbackToolText(candidate.snippet, 360);
				return [
					`  ${candidateIndex + 1}. ${title || candidate.id}`,
					snippet ? ` - ${snippet}` : "",
				].join("");
			});
			return [
				`Tool ${index + 1}: ${toolCall.name}`,
				`Input: ${truncateFallbackToolText(toolCall.input, 500)}`,
				toolCall.outputSummary
					? `Summary: ${truncateFallbackToolText(toolCall.outputSummary, 700)}`
					: null,
				candidateLines.length > 0
					? ["Candidates:", ...candidateLines].join("\n")
					: null,
			]
				.filter((line): line is string => Boolean(line))
				.join("\n");
		})
		.join("\n\n");
}

function getUpstreamIdleTimeoutMs(): number {
	const config = getConfig();
	const requestTimeoutMs = config.requestTimeoutMs;
	return Math.max(60_000, Math.min(150_000, Math.floor(requestTimeoutMs / 2)));
}

function unrefTimer(
	timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
) {
	timer.unref?.();
}

function asToolInput(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return {};
	}
	return value as Record<string, unknown>;
}

function isMappedProviderUsage(value: unknown): value is ProviderUsageSnapshot {
	return Boolean(
		value &&
			typeof value === "object" &&
			("promptTokens" in value ||
				"completionTokens" in value ||
				"source" in value),
	);
}

function mapModelRunUsage(
	usage: unknown,
): ProviderUsageSnapshot | null | undefined {
	if (!usage) return null;
	if (isMappedProviderUsage(usage)) return usage;
	return mapNormalChatModelRunUsageToProviderSnapshot(
		usage as Parameters<typeof mapNormalChatModelRunUsageToProviderSnapshot>[0],
	);
}

export function startStartedResetGenerationFact(
	userId: string,
): StreamCompletionFact<number> {
	const startedResetGeneration = getCurrentMemoryResetGeneration(userId);
	void startedResetGeneration.catch(() => undefined);
	return startedResetGeneration;
}

function startFileProductionJobIdsAtStartFact(params: {
	userId: string;
	conversationId: string;
}): StreamCompletionFact<FileProductionStartSnapshot> {
	const snapshotStartedAt = Date.now();
	let snapshot: Promise<FileProductionStartSnapshot>;
	try {
		snapshot = listConversationFileProductionJobs(
			params.userId,
			params.conversationId,
		).then((jobs) => ({
			jobIds: new Set(jobs.map((job) => job.id)),
			snapshotStartedAt,
		}));
	} catch (error) {
		snapshot = Promise.reject(error);
	}
	void snapshot.catch(() => undefined);
	return snapshot;
}

// Issue 7.5 — same "kick off the snapshot query as soon as turn prep is
// done, in parallel with the (long) model stream, then resolve it once at
// finalize" pattern as startFileProductionJobIdsAtStartFact above. Simpler
// than that one: a pending write is created SYNCHRONOUSLY by a write tool's
// execute() (createPendingWrite is awaited before the tool call ever
// returns to the model) — unlike file-production jobs, there is no
// background worker that could still be racing to create one after this
// snapshot, so a plain Set (no snapshotStartedAt tracking, no
// toolCallRecords cross-referencing) is enough.
function startPendingWriteIdsAtStartFact(params: {
	userId: string;
	conversationId: string;
}): StreamCompletionFact<Set<string>> {
	let snapshot: Promise<Set<string>>;
	try {
		snapshot = listPendingWritesForConversation(
			params.userId,
			params.conversationId,
		).then((writes) => new Set(writes.map((write) => write.id)));
	} catch (error) {
		snapshot = Promise.reject(error);
	}
	void snapshot.catch(() => undefined);
	return snapshot;
}

export interface StreamOrchestratorOptions {
	user: {
		id: string;
		displayName: string | null;
		email: string | null;
	};
	turn: ChatTurnPreflight;
	prepareTurn?: undefined;
	upstreamMessage: string;
	downstreamAbortSignal: AbortSignal;
	requestStartTime: number;
	startedResetGeneration?: StreamCompletionFact<number>;
	isReconnect?: boolean;
	systemPromptAppendix?: string;
	routePhaseTimings?: StreamPhaseTimings;
}

export type AdmittedStreamOrchestratorOptions = Omit<
	StreamOrchestratorOptions,
	"turn" | "prepareTurn"
> & {
	turn: AdmittedChatTurn;
	prepareTurn: () => Promise<ChatTurnPreparationResult>;
};

function isPreparedChatTurn(
	turn: ChatTurnPreflight | AdmittedChatTurn,
): turn is ChatTurnPreflight {
	return Boolean((turn as ChatTurnPreflight).depthMetadata);
}

export function runChatStreamOrchestrator(
	options: StreamOrchestratorOptions,
): Response;
export function runChatStreamOrchestrator(
	options: AdmittedStreamOrchestratorOptions,
): Response;
export function runChatStreamOrchestrator(
	options: StreamOrchestratorOptions | AdmittedStreamOrchestratorOptions,
): Response {
	const {
		user,
		turn,
		upstreamMessage,
		downstreamAbortSignal,
		requestStartTime,
		startedResetGeneration,
		isReconnect,
		systemPromptAppendix: retryAppendix,
		routePhaseTimings,
		prepareTurn,
	} = options;
	const conversationId = turn.conversationId;
	const normalizedMessage = turn.normalizedMessage;
	const streamId = turn.streamId;
	const modelId = turn.modelId;
	const modelDisplayName = turn.modelDisplayName;
	const providerDisplayName = turn.providerDisplayName;
	const skipPersistUserMessage = turn.skipPersistUserMessage;
	const safeAttachmentIds = turn.attachmentIds;
	const activeDocumentArtifactId = turn.activeDocumentArtifactId;
	const attachmentTraceId = turn.attachmentTraceId;
	const personalityProfileId = turn.personalityProfileId;
	const thinkingMode = turn.thinkingMode;
	const skillControlEnabled = getConfig().composerCommandRegistryEnabled;
	let preparedTurn: ChatTurnPreflight | null = isPreparedChatTurn(turn)
		? turn
		: null;
	let preparedSkillSystemPromptAppendix: string | undefined;

	const encoder = new TextEncoder();
	let cancelStream = () => {};
	const streamStartTime = Date.now();
	const phaseTimingMs: StreamPhaseTimings = { ...(routePhaseTimings ?? {}) };
	const recordElapsedPhase = (name: ServerStreamTimelineMark) =>
		recordElapsedStreamTimelineMark(
			phaseTimingMs,
			name,
			requestStartTime,
			Date.now(),
		);
	const recordDurationPhase = (
		name: ServerStreamTimelineMark,
		startedAt: number,
	) =>
		recordDurationStreamTimelineMark(
			phaseTimingMs,
			name,
			Date.now() - startedAt,
		);
	const recordDepthSelectionPhase = (metadata: DepthMetadata | undefined) => {
		recordDurationStreamTimelineMark(
			phaseTimingMs,
			SERVER_STREAM_TIMELINE_MARKS.DEPTH_SELECTION,
			metadata?.timing?.totalMs,
		);
	};
	const logPhaseTiming = (outcome: "success" | "error" | "stopped") => {
		recordElapsedPhase(SERVER_STREAM_TIMELINE_MARKS.END);
		const payload: Record<string, string | number | boolean | null> = {
			conversationId,
			streamId: streamId ?? null,
			modelId: modelId ?? null,
			outcome,
		};
		for (const [name, durationMs] of Object.entries(phaseTimingMs)) {
			if (durationMs === undefined) continue;
			payload[`${name}_ms`] = durationMs;
		}
		if (getConfig().contextDiagnosticsDebug) {
			console.info("[CHAT_STREAM] phase_timing", payload);
		}
	};

	const stream = new ReadableStream({
		async start(controller) {
			const downstreamAbortController = new AbortController();
			const downstreamSignal = downstreamAbortController.signal;
			let downstreamClosed = false;
			let ended = false;

			const closeDownstream = (): void => {
				if (downstreamClosed) return;
				downstreamClosed = true;
				downstreamAbortSignal.removeEventListener("abort", closeDownstream);
				if (!downstreamAbortController.signal.aborted) {
					downstreamAbortController.abort();
				}
				// Do NOT abort upstream on client disconnect — let generation complete and persist to DB.
				// The client reloads persisted messages on visibility restore (mobile background fix).
				try {
					controller.close();
				} catch {
					return;
				}
			};

			cancelStream = closeDownstream;

			if (downstreamAbortSignal.aborted) {
				closeDownstream();
			} else {
				downstreamAbortSignal.addEventListener("abort", closeDownstream, {
					once: true,
				});
			}

			const doReconnect = (targetStreamId: string) => {
				runReconnect(targetStreamId, {
					userId: user.id,
					conversationId,
					enqueueChunk,
					closeDownstream,
					downstreamAbortSignal: downstreamSignal,
					getStreamBuffer: (params) => getStreamBuffer(params) ?? undefined,
					subscribeToStream,
					unsubscribeFromStream,
					createSsePreludeComment,
					createSseHeartbeatComment,
				});
			};

			const enqueueChunk = (chunk: string): boolean => {
				// Always broadcast to reconnect listeners first, even if this downstream
				// is already closed (e.g. reconnect client navigated away). The listener
				// needs terminal UI stream parts to finalize the UI placeholder.
				if (isMainStream && streamId) {
					broadcastStreamChunk(streamId, chunk);
				}
				if (downstreamClosed) return true;

				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					closeDownstream();
				}

				return true;
			};

			if (streamId) {
				console.info("[CHAT_STREAM] start called", {
					streamId,
					abortAlreadySignaled: downstreamAbortSignal.aborted,
				});
			}
			const upstreamAbortController = new AbortController();
			let isMainStream = false;

			if (streamId) {
				const decision = arbitrateStreamStart({
					streamId,
					userId: user.id,
					conversationId,
					controller: upstreamAbortController,
					userMessage: normalizedMessage,
					reasoningDepth: turn.reasoningDepth,
					getOrphanedStream,
					isStreamActive,
					registerActiveChatStream,
					clearStreamBuffer,
					getOrCreateStreamBuffer,
				});
				if (decision.action === "reconnect") {
					setTimeout(() => doReconnect(decision.targetStreamId), 0);
					return;
				}
				if (decision.action === "close") {
					closeDownstream();
					return;
				}
				isMainStream = true;
			}
			const wasStopRequested = () =>
				wasActiveChatStreamStopRequested({
					streamId,
					userId: user.id,
				});
			let emitResponseActivity: (entry: ResponseActivityEntry) => void =
				() => {};
			const chunkRuntime = createServerChunkRuntime({
				enqueueChunk,
				skillControlEnabled,
				onToken: (chunk) => {
					if (streamId)
						appendToStreamBuffer(streamId, "token", { text: chunk });
				},
				onThinking: (reasoning) => {
					if (streamId)
						appendToStreamBuffer(streamId, "thinking", { text: reasoning });
				},
				onToolCall: (name, input, status, outputSummary, details) => {
					if (streamId) {
						appendToStreamBuffer(streamId, "tool_call", {
							callId: details?.callId,
							name,
							input,
							status,
							outputSummary,
							sourceType: details?.sourceType,
							candidates: details?.candidates,
							metadata: details?.metadata,
						});
					}
				},
				onResponseActivity: (entry) => emitResponseActivity(entry),
			});
			emitResponseActivity = (entry: ResponseActivityEntry) => {
				if (ended) return;
				const activity = {
					...entry,
					occurredAt: entry.occurredAt ?? Date.now(),
				};
				if (activity.kind === "deliberation" && activity.label) {
					chunkRuntime.emitStatusSegment({
						id: activity.id,
						label: activity.label,
						status: activity.status,
						passIndex: activity.passIndex,
						passTotal: activity.passTotal,
						passKind: activity.passKind,
					});
				}
				if (streamId) {
					appendToStreamBuffer(streamId, "response_activity", {
						activity,
					});
				}
				enqueueChunk(streamResponseActivityEvent(activity));
			};
			const emitThinking = (reasoning: string) => {
				if (reasoning) {
					recordElapsedPhase(SERVER_STREAM_TIMELINE_MARKS.FIRST_THINKING);
				}
				const emitted = chunkRuntime.emitThinking(reasoning);
				return emitted;
			};
			const emitToolCallEventWithDebug = (
				name: string,
				input: Record<string, unknown>,
				status: "running" | "done",
				details?: {
					callId?: string;
					outputSummary?: string | null;
					sourceType?: import("$lib/types").EvidenceSourceType | null;
					candidates?: import("$lib/types").ToolEvidenceCandidate[];
					metadata?: Record<string, string | number | boolean | null>;
				},
			) => {
				chunkRuntime.emitToolCallEvent(name, input, status, details);
			};
			const emitPrefetchedToolCalls = (
				records:
					| Array<{
							name: string;
							input: Record<string, unknown>;
							status: "running" | "done";
							callId?: string;
							outputSummary?: string | null;
							sourceType?: import("$lib/types").EvidenceSourceType | null;
							candidates?: import("$lib/types").ToolEvidenceCandidate[];
							metadata?: Record<string, string | number | boolean | null>;
					  }>
					| undefined,
			) => {
				for (const record of records ?? []) {
					emitToolCallEventWithDebug(record.name, record.input, record.status, {
						callId: record.callId,
						outputSummary: record.outputSummary,
						sourceType: record.sourceType,
						candidates: record.candidates,
						metadata: record.metadata,
					});
				}
			};
			const emitRecoveredToolCalls = (records: ToolCallEntry[]) => {
				for (const record of records) {
					if (record.status === "done") {
						emitToolCallEventWithDebug(
							record.name,
							asToolInput(record.input),
							"running",
							{
								callId: record.callId,
							},
						);
					}
					emitToolCallEventWithDebug(
						record.name,
						asToolInput(record.input),
						record.status,
						{
							callId: record.callId,
							outputSummary: record.outputSummary,
							sourceType: record.sourceType,
							candidates: record.candidates,
							metadata: record.metadata,
						},
					);
				}
			};
			const emitChunkWithOutputHandling = (chunk: string): boolean => {
				const previousVisibleAnswerLength = chunkRuntime.fullResponse.length;
				const emitted = chunkRuntime.emitChunkWithOutputHandling(chunk);
				if (
					emitted &&
					chunkRuntime.fullResponse.length > previousVisibleAnswerLength &&
					chunkRuntime.fullResponse.trim()
				) {
					recordElapsedPhase(SERVER_STREAM_TIMELINE_MARKS.FIRST_VISIBLE_TOKEN);
				}
				return emitted;
			};
			const flushPendingThinking = chunkRuntime.flushPendingThinking;
			const flushInlineThinkingBuffer = chunkRuntime.flushInlineThinkingBuffer;
			const flushOutputBuffer = chunkRuntime.flushOutputBuffer;
			const heartbeatIntervalId = setInterval(() => {
				enqueueChunk(createSseHeartbeatComment());
			}, 15000);
			unrefTimer(heartbeatIntervalId);

			enqueueChunk(createSsePreludeComment());
			recordDurationPhase(
				SERVER_STREAM_TIMELINE_MARKS.PRELUDE,
				streamStartTime,
			);
			emitResponseActivity({
				id: RESPONSE_ACTIVITY_IDS.CONTEXT_PREPARING,
				kind: "context",
				status: "running",
			});

			const emitError = (code: StreamErrorCode) =>
				enqueueChunk(streamErrorEvent(code));
			const emitResolvedAssistantText = async (
				text: string | null,
			): Promise<boolean> => {
				if (!text) {
					return true;
				}

				return emitChunkWithOutputHandling(text);
			};
			const hasEmittedStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						chunkRuntime.thinkingContent.trim() ||
						chunkRuntime.toolCallRecords.length > 0,
				);
			const hasVisibleStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						chunkRuntime.toolCallRecords.length > 0,
				);
			const hasVisibleAssistantAnswerOutput = () =>
				Boolean(chunkRuntime.fullResponse.trim());
			const completedToolCallRecords = () =>
				chunkRuntime.toolCallRecords.filter(
					(record) => record.status === "done",
				);
			const isCompletedFileProductionToolCall = (record: ToolCallEntry) =>
				isFileProductionToolName(record.name) && record.status === "done";
			const hasCompletedFileProductionToolCall = () =>
				completedToolCallRecords().some(isCompletedFileProductionToolCall);
			const hasCompletedNonFileToolCall = () =>
				completedToolCallRecords().some(
					(record) => !isFileProductionToolName(record.name),
				);
			const hasPersistableStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						hasCompletedFileProductionToolCall() ||
						hasCompletedNonFileToolCall(),
				);
			const flushBufferedStreamOutput = () => {
				flushPendingThinking();
				if (!flushInlineThinkingBuffer()) {
					return false;
				}
				if (!flushOutputBuffer()) {
					return false;
				}
				return true;
			};
			// One value per prepared-context concept. The completion boundary used
			// to receive a latest*/initial* mirror-pair for each of these; they
			// always held the same value here, so the orchestrator now tracks a
			// single scalar each and hands them over as one snapshot object.
			let latestContextStatus: ConversationContextStatus | undefined;
			let latestTaskState: TaskState | null | undefined;
			let latestContextDebug: ContextDebugState | null | undefined;
			let latestContextTraceSections:
				| LegacyContextTraceSectionInput[]
				| undefined;
			let latestProviderUsage: ProviderUsageSnapshot | null = null;
			let latestModelId = modelId ?? "model1";
			let latestModelDisplayName = modelDisplayName;
			let latestProviderIconUrl: string | null = null;
			let latestDepthMetadata: DepthMetadata | undefined =
				preparedTurn?.depthMetadata;
			let latestUpstreamFinishReason: FinishReason | null = null;
			let latestUpstreamRawFinishReason: string | null = null;
			let fileProductionJobIdsAtStart: StreamCompletionFact<FileProductionStartSnapshot> | null =
				null;
			const ensureFileProductionJobIdsAtStart = () => {
				fileProductionJobIdsAtStart ??= startFileProductionJobIdsAtStartFact({
					userId: user.id,
					conversationId,
				});
				return fileProductionJobIdsAtStart;
			};
			let pendingWriteIdsAtStart: StreamCompletionFact<Set<string>> | null =
				null;
			const ensurePendingWriteIdsAtStart = () => {
				pendingWriteIdsAtStart ??= startPendingWriteIdsAtStartFact({
					userId: user.id,
					conversationId,
				});
				return pendingWriteIdsAtStart;
			};
			const runCompleteStreamTurn = async (args: {
				wasStopped: boolean;
				streamClosedWithoutFinish: boolean;
			}) => {
				await completeStreamTurn({
					wasStopped: args.wasStopped,
					conversationId,
					streamId: streamId ?? null,
					modelId: latestModelId,
					modelDisplayName: latestModelDisplayName,
					providerDisplayName,
					providerIconUrl: latestProviderIconUrl,
					reasoningDepth: turn.reasoningDepth,
					depthMetadata: latestDepthMetadata,
					userId: user.id,
					startedResetGeneration,
					normalizedMessage,
					upstreamMessage,
					skipPersistUserMessage,
					isReconnect,
					thinkingContent: chunkRuntime.thinkingContent,
					fullResponse: chunkRuntime.fullResponse,
					toolCallRecords: chunkRuntime.toolCallRecords,
					skillControlEnvelopePayloads:
						chunkRuntime.skillControlEnvelopePayloads,
					skillControlEnabled,
					serverSegments: chunkRuntime.serverSegments,
					attachmentIds: safeAttachmentIds,
					linkedSources: preparedTurn?.linkedSources ?? turn.linkedSources,
					activeSkillSessionId:
						preparedTurn?.skillPromptContext?.source === "active_session"
							? preparedTurn.skillPromptContext.sessionId
							: null,
					activeDocumentArtifactId: activeDocumentArtifactId ?? null,
					requestStartTime,
					fileProductionJobIdsAtStart: ensureFileProductionJobIdsAtStart(),
					pendingWriteIdsAtStart: ensurePendingWriteIdsAtStart(),
					// The former latest*/initial* mirror-pairs always held the same
					// value at this boundary, so they collapse into one prepared-context
					// snapshot carried across as a single object.
					preparedContext: {
						contextStatus: latestContextStatus,
						taskState: latestTaskState,
						contextDebug: latestContextDebug,
						contextTraceSections: latestContextTraceSections,
					},
					latestProviderUsage,
					upstreamFinishReason: latestUpstreamFinishReason,
					upstreamRawFinishReason: latestUpstreamRawFinishReason,
					streamClosedWithoutFinish: args.streamClosedWithoutFinish,
					serverTimeline: createTerminalStreamTimelinePayload(phaseTimingMs),
					touchConversation,
					enqueueChunk,
					closeDownstream,
					clearStreamBuffer,
					getStreamBuffer,
					syncGeneratedFilesToMemory,
					getChatFilesForAssistantMessage,
					getFileProductionJobs: listConversationFileProductionJobs,
					assignFileProductionJobsToAssistantMessage,
					estimateTokenCount,
				});
			};
			const terminal = createStreamTerminal({
				isEnded: () => ended,
				markEnded: () => {
					ended = true;
				},
				logPhaseTiming,
				streamId,
				clearStreamBuffer,
				closeDownstream,
				emitError,
				emitRequestError: (error) =>
					enqueueChunk(streamRequestErrorEvent(error)),
				runCompleteStreamTurn,
				flushNativeToolCalls: () => chunkRuntime.flushNativeToolCalls(),
				flushBufferedStreamOutput,
				wasStopRequested,
				hasVisibleAssistantAnswerOutput,
				hasCompletedFileProductionToolCall,
				hasCompletedNonFileToolCall,
				getAttemptedNonStreamFallback: () => attemptedNonStreamFallback,
				getFallbackRunner: () => fallbackToNonStreaming,
				getLatestUpstreamAttempt: () => latestUpstreamAttempt,
				upstreamEndLog: { conversationId, streamId, modelId },
				getUpstreamEndSnapshot: () => ({
					thinkingLength: chunkRuntime.thinkingContent.length,
					toolCallCount: chunkRuntime.toolCallRecords.length,
					completedToolCallCount: completedToolCallRecords().length,
					hasCompletedNonFileToolCall: hasCompletedNonFileToolCall(),
				}),
			});
			const {
				completeSuccess,
				failStream,
				failPreparedTurnStream,
				completeOrRecoverAfterUpstreamEnd,
			} = terminal;

			const timeoutId = setTimeout(() => {
				failStream("timeout");
				upstreamAbortController.abort();
			}, getStreamTimeoutMs());
			unrefTimer(timeoutId);
			let fallbackToNonStreaming:
				| ((
						reason: "stream_connect_failure" | "stream_read_failure",
						attempt: number,
						error: unknown,
				  ) => Promise<null>)
				| null = null;
			const idleTimeout = createUpstreamIdleTimeout({
				idleTimeoutMs: getUpstreamIdleTimeoutMs(),
				log: { conversationId, streamId, modelId },
				snapshot: () => ({
					responseLength: chunkRuntime.fullResponse.length,
					thinkingLength: chunkRuntime.thinkingContent.length,
					toolCallCount: chunkRuntime.toolCallRecords.length,
				}),
				hasVisibleAssistantAnswerOutput,
				onIdleTimeout: (attempt, { willAttemptFallback }) => {
					if (willAttemptFallback) {
						void (async () => {
							if (fallbackToNonStreaming && !ended) {
								await fallbackToNonStreaming(
									"stream_read_failure",
									attempt,
									new Error("Timed out waiting for upstream stream activity"),
								);
								upstreamAbortController.abort();
								return;
							}
							failStream("timeout");
							upstreamAbortController.abort();
						})();
					} else {
						failStream("timeout");
						upstreamAbortController.abort();
					}
				},
				unref: unrefTimer,
			});

			let personalityPrompt: string | undefined;
			let latestUpstreamAttempt = 1;
			const currentStreamModelId = (modelId ?? undefined) as
				| ModelId
				| undefined;
			let attemptedNonStreamFallback = false;
			const currentSystemPromptAppendix = () => {
				const appendices = [
					preparedSkillSystemPromptAppendix,
					retryAppendix,
				].filter((value): value is string => Boolean(value?.trim()));
				return appendices.length > 0 ? appendices.join("\n\n") : undefined;
			};
			fallbackToNonStreaming = async (
				reason: "stream_connect_failure" | "stream_read_failure",
				attempt: number,
				error: unknown,
			): Promise<null> => {
				attemptedNonStreamFallback = true;
				const fallbackActivityId = createFallbackResponseActivityId(
					reason,
					attempt,
				);
				emitResponseActivity({
					id: fallbackActivityId,
					kind: "fallback",
					status: "running",
					detail: reason,
				});
				const fallbackModelId = currentStreamModelId;
				console.warn(
					reason === "stream_connect_failure"
						? "[STREAM] Falling back to non-stream provider run after stream connect failure"
						: "[STREAM] Falling back to non-stream provider run after stream body terminated before usable output",
					{
						conversationId,
						attempt,
						fromModelId: currentStreamModelId ?? "model1",
						modelId: fallbackModelId ?? "model1",
						errorName: error instanceof Error ? error.name : undefined,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					},
				);

				const recovered = await runNonStreamFallback({
					runPlainNormalChatSendModel,
					sendParams: {
						runtimeConfig: getConfig(),
						upstreamMessage,
						conversationId,
						modelId: (fallbackModelId ?? undefined) as ModelId | undefined,
						attachmentIds: safeAttachmentIds,
						activeDocumentArtifactId: activeDocumentArtifactId ?? undefined,
						attachmentTraceId: attachmentTraceId ?? undefined,
						thinkingMode,
						depthMetadata: latestDepthMetadata,
						forceWebSearch: turn.forceWebSearch,
						enabledConnectionCapabilities: turn.enabledConnectionCapabilities,
					},
					user,
					attachContinuityToTaskState,
					emitResolvedAssistantText,
					flushPendingThinking,
					flushInlineThinkingBuffer,
					flushOutputBuffer,
					hasVisibleAssistantText: hasVisibleAssistantAnswerOutput,
					completeSuccess,
					signal: upstreamAbortController.signal,
					systemPromptAppendix: currentSystemPromptAppendix(),
					personalityPrompt,
					onContextStatus: (status) => {
						latestContextStatus = status;
					},
					onTaskState: (state) => {
						latestTaskState = state;
					},
					onContextDebug: (debug) => {
						latestContextDebug = debug;
					},
					onProviderUsage: (usage) => {
						latestProviderUsage = usage;
					},
					onResolvedModel: (resolvedModelId, displayName) => {
						latestModelId = resolvedModelId;
						latestModelDisplayName = displayName;
					},
					onDepthMetadata: (metadata) => {
						latestDepthMetadata = metadata;
					},
					onRecoveredToolCalls: emitRecoveredToolCalls,
					onContextPreparationTimings: (timings, fallbackAttempt) => {
						recordContextPreparationTimelineTimings(phaseTimingMs, timings, {
							type: "fallback",
							attempt: fallbackAttempt,
						});
					},
					onResponseActivity: emitResponseActivity,
					completedToolCallContext: buildCompletedToolCallFallbackContext(
						chunkRuntime.toolCallRecords,
					),
				});
				if (!recovered && !ended) {
					emitResponseActivity({
						id: fallbackActivityId,
						kind: "fallback",
						status: "error",
						detail: reason,
					});
					failStream("backend_failure");
				} else if (recovered) {
					emitResponseActivity({
						id: fallbackActivityId,
						kind: "fallback",
						status: "done",
						detail: reason,
					});
				}

				return null;
			};
			try {
				if (!preparedTurn) {
					if (!prepareTurn) {
						throw new Error("Stream turn preparation is required");
					}
					const turnPreparationStartedAt = Date.now();
					let preparation: ChatTurnPreparationResult;
					try {
						preparation = await prepareTurn();
					} finally {
						recordDurationPhase(
							SERVER_STREAM_TIMELINE_MARKS.TURN_PREPARATION,
							turnPreparationStartedAt,
						);
					}
					if (!preparation.ok) {
						console.warn("[CHAT_STREAM] turn preparation failed", {
							conversationId,
							streamId,
							status: preparation.error.status,
							code: preparation.error.code,
							error: preparation.error.error,
						});
						failPreparedTurnStream(preparation.error);
						return;
					}
					preparedTurn = preparation.value;
				}
				preparedSkillSystemPromptAppendix = prepareTurn
					? buildSkillSystemPromptAppendix(preparedTurn.skillPromptContext)
					: undefined;
				latestDepthMetadata = preparedTurn.depthMetadata;
				recordDepthSelectionPhase(latestDepthMetadata);
				emitResponseActivity({
					id: RESPONSE_ACTIVITY_IDS.DEPTH_SELECTED,
					kind: "depth",
					status: "done",
					detail: latestDepthMetadata.appliedProfile,
				});
				ensureFileProductionJobIdsAtStart();
				ensurePendingWriteIdsAtStart();

				if (personalityProfileId) {
					const profile = await getPersonalityProfile(
						personalityProfileId,
					).catch(() => null);
					personalityPrompt = profile?.promptText || undefined;
				}

				const attempt = 1;
				latestUpstreamAttempt = attempt;
				const modelStreamRequestStartedAt = Date.now();
				const modelRunParams = {
					userId: user.id,
					runtimeConfig: getConfig(),
					message: upstreamMessage,
					conversationId,
					modelId: currentStreamModelId,
					user: {
						id: user.id,
						displayName: user.displayName,
						email: user.email,
					},
					attachmentIds: safeAttachmentIds,
					activeDocumentArtifactId: activeDocumentArtifactId ?? undefined,
					attachmentTraceId: attachmentTraceId ?? undefined,
					systemPromptAppendix: currentSystemPromptAppendix(),
					personalityPrompt,
					thinkingMode,
					depthMetadata: latestDepthMetadata,
					forceWebSearch: turn.forceWebSearch,
					enabledConnectionCapabilities: turn.enabledConnectionCapabilities,
					signal: upstreamAbortController.signal,
					onResponseActivity: emitResponseActivity,
				};
				let modelRun: Awaited<
					ReturnType<typeof runStreamingNormalChatSendModel>
				> | null = null;
				try {
					modelRun = await runStreamingNormalChatSendModel(modelRunParams);
					latestProviderIconUrl = modelRun.providerIconUrl ?? null;
				} catch (error) {
					if (
						!shouldFallbackOnStreamConnectFailure({
							error,
							wasStopRequested: wasStopRequested(),
							hasEmittedStreamOutput: hasEmittedStreamOutput(),
						})
					) {
						throw error;
					}

					modelRun = await fallbackToNonStreaming(
						"stream_connect_failure",
						attempt,
						error,
					);
				}
				recordDurationPhase(
					SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST,
					modelStreamRequestStartedAt,
				);
				if (!modelRun) {
					return;
				}
				latestModelId = modelRun.modelId ?? latestModelId;
				latestModelDisplayName =
					modelRun.modelDisplayName ?? latestModelDisplayName;
				latestDepthMetadata = modelRun.depthMetadata ?? latestDepthMetadata;
				const prepared: StreamingNormalChatPreparedContext =
					modelRun.prepared ?? {};
				recordContextPreparationTimelineTimings(
					phaseTimingMs,
					prepared.contextPreparationTimings,
				);
				emitResponseActivity({
					id: RESPONSE_ACTIVITY_IDS.CONTEXT_READY,
					kind: "context",
					status: "done",
				});
				emitPrefetchedToolCalls(modelRun.prefetchedToolCalls);
				latestContextStatus = prepared.contextStatus;
				latestTaskState =
					prepared.taskState ??
					(await getConversationTaskState(user.id, conversationId).catch(
						() => null,
					));
				latestTaskState = await attachContinuityToTaskState(
					user.id,
					latestTaskState ?? null,
				).catch(() => latestTaskState ?? null);
				latestContextDebug =
					prepared.contextDebug ??
					(await getContextDebugState(user.id, conversationId).catch(
						() => null,
					));
				latestContextTraceSections = prepared.contextTraceSections;
				emitResponseActivity({
					id: RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER,
					kind: "drafting",
					status: "running",
				});

				idleTimeout.schedule(attempt);
				let fileProductionActive = false;
				const FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS = 300;
				let fileProductionPostCaptureChars = 0;
				try {
					for await (const upstreamEvent of modelRun.stream) {
						recordElapsedPhase(
							SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT,
						);
						idleTimeout.markActivity(attempt);
						switch (upstreamEvent.type) {
							case "text_delta":
								if (
									fileProductionActive ||
									fileProductionPostCaptureChars > 0
								) {
									if (!emitThinking(upstreamEvent.text)) {
										return;
									}
									if (
										!fileProductionActive &&
										fileProductionPostCaptureChars > 0
									) {
										fileProductionPostCaptureChars = Math.max(
											0,
											fileProductionPostCaptureChars -
												upstreamEvent.text.length,
										);
									}
								} else if (!emitChunkWithOutputHandling(upstreamEvent.text)) {
									return;
								}
								break;
							case "reasoning_delta":
								if (!emitThinking(upstreamEvent.text)) {
									return;
								}
								break;
							case "tool_call":
								if (isFileProductionToolName(upstreamEvent.toolName)) {
									fileProductionActive = true;
									fileProductionPostCaptureChars = 0;
								}
								emitToolCallEventWithDebug(
									upstreamEvent.toolName,
									asToolInput(upstreamEvent.input),
									"running",
									{ callId: upstreamEvent.callId },
								);
								break;
							case "tool_result": {
								const matchingToolCall = modelRun
									.getNormalChatToolCalls()
									.find((record) => record.callId === upstreamEvent.callId);
								if (isFileProductionToolName(upstreamEvent.toolName)) {
									fileProductionActive = false;
									fileProductionPostCaptureChars =
										FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS;
								}
								emitToolCallEventWithDebug(
									upstreamEvent.toolName,
									matchingToolCall?.input ?? {},
									"done",
									{
										callId: upstreamEvent.callId,
										outputSummary: matchingToolCall?.outputSummary ?? null,
										sourceType: matchingToolCall?.sourceType ?? null,
										candidates: matchingToolCall?.candidates ?? [],
										metadata: matchingToolCall?.metadata ?? {},
									},
								);
								break;
							}
							case "tool_error": {
								const matchingToolCall = modelRun
									.getNormalChatToolCalls()
									.find((record) => record.callId === upstreamEvent.callId);
								if (isFileProductionToolName(upstreamEvent.toolName)) {
									fileProductionActive = false;
									fileProductionPostCaptureChars =
										FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS;
								}
								emitToolCallEventWithDebug(
									upstreamEvent.toolName,
									matchingToolCall?.input ?? {},
									"done",
									{
										callId: upstreamEvent.callId,
										outputSummary: null,
										sourceType: null,
										candidates: [],
										metadata: {
											ok: false,
											evidenceReady: false,
											error: upstreamEvent.error,
										},
									},
								);
								break;
							}
							case "usage": {
								const mappedUsage = mapModelRunUsage(upstreamEvent.usage);
								if (mappedUsage) {
									latestProviderUsage = mappedUsage;
								}
								break;
							}
							case "finish":
								latestModelId =
									(upstreamEvent.model.modelId as ModelId | undefined) ??
									latestModelId;
								latestModelDisplayName =
									upstreamEvent.model.displayName ?? latestModelDisplayName;
								latestUpstreamFinishReason = upstreamEvent.finishReason;
								latestUpstreamRawFinishReason =
									upstreamEvent.rawFinishReason ?? null;
								await completeOrRecoverAfterUpstreamEnd("end_event");
								return;
							case "error": {
								const errorMessage = upstreamEvent.error;
								latestUpstreamFinishReason = "error";
								latestUpstreamRawFinishReason = errorMessage;
								console.error("[STREAM] Upstream error event payload", {
									conversationId,
									attempt,
									errorMessage,
								});
								const upstreamError = new Error(errorMessage);
								const errorCode = classifyStreamError(errorMessage);
								const canRecoverWithNonStreamFallback =
									shouldFallbackOnUpstreamErrorEvent({
										error: upstreamError,
										attemptedNonStreamFallback,
										wasStopRequested: wasStopRequested(),
										hasVisibleAssistantAnswerOutput:
											hasVisibleAssistantAnswerOutput(),
										hasVisibleStreamOutput: hasVisibleStreamOutput(),
										hasCompletedNonFileToolCall: hasCompletedNonFileToolCall(),
									});
								if (canRecoverWithNonStreamFallback && fallbackToNonStreaming) {
									await fallbackToNonStreaming(
										"stream_read_failure",
										attempt,
										upstreamError,
									);
									return;
								}
								if (
									flushBufferedStreamOutput() &&
									(hasVisibleAssistantAnswerOutput() ||
										hasCompletedFileProductionToolCall())
								) {
									await completeSuccess();
									return;
								}
								failStream(errorCode);
								return;
							}
						}
					}

					if (ended) {
						return;
					}
				} finally {
					idleTimeout.clear();
				}

				await completeOrRecoverAfterUpstreamEnd("stream_closed");
				return;
			} catch (error) {
				if (ended) {
					return;
				}
				if (
					wasStopRequested() &&
					error instanceof Error &&
					(error.name === "AbortError" ||
						error.message.toLowerCase().includes("abort"))
				) {
					await completeSuccess(true);
					return;
				}
				if (
					shouldFallbackOnStreamError({
						error,
						attemptedNonStreamFallback,
						wasStopRequested: wasStopRequested(),
						hasVisibleAssistantAnswerOutput: hasVisibleAssistantAnswerOutput(),
						hasVisibleStreamOutput: hasVisibleStreamOutput(),
						upstreamIdleTimedOutBeforeOutput: idleTimeout.timedOutBeforeOutput,
					})
				) {
					await fallbackToNonStreaming(
						"stream_read_failure",
						latestUpstreamAttempt,
						error,
					);
					return;
				}
				if (isAbruptUpstreamTermination(error)) {
					if (flushBufferedStreamOutput() && hasPersistableStreamOutput()) {
						await completeSuccess(false, {
							streamClosedWithoutFinish: true,
						});
						return;
					}
					if (
						shouldFallbackOnAbruptTermination({
							error,
							attemptedNonStreamFallback,
							wasStopRequested: wasStopRequested(),
							hasVisibleAssistantAnswerOutput:
								hasVisibleAssistantAnswerOutput(),
						})
					) {
						await fallbackToNonStreaming(
							"stream_read_failure",
							latestUpstreamAttempt,
							error,
						);
						return;
					}
				}
				console.error("[STREAM] Chat stream error", {
					conversationId,
					userId: user.id,
					message: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
					cause:
						error instanceof Error && "cause" in error
							? (error as Error & { cause?: unknown }).cause
							: undefined,
				});
				if (attachmentTraceId) {
					logAttachmentTrace("stream_failure", {
						traceId: attachmentTraceId,
						conversationId,
						attachmentIds: safeAttachmentIds,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					});
				}
				failStream(
					classifyStreamError(
						error instanceof Error ? error.message : String(error),
					),
				);
			} finally {
				clearInterval(heartbeatIntervalId);
				clearTimeout(timeoutId);
				idleTimeout.clear();
				if (streamId) {
					unregisterActiveChatStream(streamId, upstreamAbortController);
				}
				cancelStream = () => undefined;
			}
		},
		cancel() {
			cancelStream();
		},
	});

	return createEventStreamResponse(stream, { serverTiming: routePhaseTimings });
}
