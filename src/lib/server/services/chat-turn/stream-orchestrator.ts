import { getConfig } from "$lib/server/config-store";
import {
	extractProviderUsage,
	type ProviderUsageSnapshot,
} from "$lib/server/services/analytics";
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
import {
	persistAssistantEvidence,
	persistAssistantTurnState,
	persistUserTurnAttachments,
	runPostTurnTasks,
} from "$lib/server/services/chat-turn/finalize";
import { normalizeAssistantOutput } from "$lib/server/services/chat-turn/normalizer";
import {
	classifyStreamError,
	createEventStreamResponse,
	createServerChunkRuntime,
	createSseHeartbeatComment,
	createSsePreludeComment,
	extractAssistantChunk,
	extractErrorMessage,
	formatUpstreamErrorAsAssistantMessage,
	getReasoningContent,
	isAbruptUpstreamTermination,
	isUrlListValidationError,
	parseUpstreamEvents,
	processToolCallMarkers,
	type StreamErrorCode,
	type StreamPhaseTimings,
	streamErrorEvent,
	toIncrementalChunk,
	URL_LIST_TOOL_RECOVERY_APPENDIX,
} from "$lib/server/services/chat-turn/stream";
import { completeStreamTurn } from "$lib/server/services/chat-turn/stream-completion";
import { runNonStreamFallback } from "$lib/server/services/chat-turn/stream-fallback";
import { doReconnect as runReconnect } from "$lib/server/services/chat-turn/stream-reconnect";
import type { ChatTurnPreflight } from "$lib/server/services/chat-turn/types";
import { touchConversation } from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import {
	isLangflowTimeoutError,
	resolveTimeoutFailoverTargetModelId,
	sendMessage,
	sendMessageStream,
} from "$lib/server/services/langflow";
import { createMessage } from "$lib/server/services/messages";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import { estimateTokenCount } from "$lib/utils/tokens";
import { isFileProductionToolName } from "$lib/utils/tool-calls";

function getStreamTimeoutMs(): number {
	return Math.max(60_000, getConfig().requestTimeoutMs);
}

function getFirstVisibleOutputTimeoutMs(
	modelId?: string | null,
): number | null {
	const config = getConfig();
	const sourceModelId = modelId ?? "model1";
	const failoverTargetModelId = config.modelTimeoutFailoverTargetModel;
	if (
		config.modelTimeoutFailoverEnabled &&
		failoverTargetModelId &&
		failoverTargetModelId !== sourceModelId
	) {
		return Math.min(
			config.requestTimeoutMs,
			Math.max(1000, config.modelTimeoutFailoverTimeoutMs),
		);
	}

	return null;
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

function shouldFallbackToNonStreaming(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	const message = error.message.toLowerCase();

	return (
		error.name === "AbortError" ||
		error.name === "LangflowStreamConnectTimeoutError" ||
		message.includes("abort") ||
		message.includes("timed out") ||
		message.includes("fetch failed") ||
		message.includes("socket") ||
		message.includes("connection") ||
		message.includes("terminated")
	);
}

export interface StreamOrchestratorOptions {
	user: {
		id: string;
		displayName: string | null;
		email: string | null;
	};
	turn: ChatTurnPreflight;
	upstreamMessage: string;
	downstreamAbortSignal: AbortSignal;
	requestStartTime: number;
	isReconnect?: boolean;
	skipHonchoContext?: boolean;
	systemPromptAppendix?: string;
	routePhaseTimings?: StreamPhaseTimings;
}

export function runChatStreamOrchestrator(
	options: StreamOrchestratorOptions,
): Response {
	const {
		user,
		turn,
		upstreamMessage,
		downstreamAbortSignal,
		requestStartTime,
		isReconnect,
		skipHonchoContext,
		systemPromptAppendix: retryAppendix,
		routePhaseTimings,
	} = options;
	const conversationId = turn.conversationId;
	const normalizedMessage = turn.normalizedMessage;
	const streamId = turn.streamId;
	const modelId = turn.modelId;
	const modelDisplayName = turn.modelDisplayName;
	const skipPersistUserMessage = turn.skipPersistUserMessage;
	const safeAttachmentIds = turn.attachmentIds;
	const activeDocumentArtifactId = turn.activeDocumentArtifactId;
	const attachmentTraceId = turn.attachmentTraceId;
	const personalityProfileId = turn.personalityProfileId;
	const thinkingMode = turn.thinkingMode;
	const skillControlEnabled = getConfig().composerCommandRegistryEnabled;

	const encoder = new TextEncoder();
	let cancelStream = () => undefined;
	const streamStartTime = Date.now();
	const phaseTimingMs: StreamPhaseTimings = { ...(routePhaseTimings ?? {}) };
	const recordElapsedPhase = (name: string) => {
		if (phaseTimingMs[name] !== undefined) return;
		phaseTimingMs[name] = Date.now() - requestStartTime;
	};
	const recordDurationPhase = (name: string, startedAt: number) => {
		if (phaseTimingMs[name] !== undefined) return;
		phaseTimingMs[name] = Date.now() - startedAt;
	};
	const logPhaseTiming = (outcome: "success" | "error" | "stopped") => {
		recordElapsedPhase("end");
		const payload: Record<string, string | number | boolean | null> = {
			conversationId,
			streamId: streamId ?? null,
			modelId: modelId ?? null,
			outcome,
		};
		for (const [name, durationMs] of Object.entries(phaseTimingMs)) {
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
			let lastAssistantSnapshot = "";
			let emittedAssistantText = "";

			const closeDownstream = () => {
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
					enqueueChunk,
					closeDownstream,
					downstreamAbortSignal: downstreamSignal,
					getStreamBuffer: (id) => getStreamBuffer(id) ?? undefined,
					subscribeToStream,
					unsubscribeFromStream,
					createSsePreludeComment,
					createSseHeartbeatComment,
				});
			};

			const enqueueChunk = (chunk: string): boolean => {
				// Always broadcast to reconnect listeners first, even if this downstream
				// is already closed (e.g. reconnect client navigated away). The listener
				// needs `event: end` to fire onEnd and finalize the UI placeholder.
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
				let existingStreamId: string | null;
				try {
					existingStreamId = getOrphanedStream(conversationId);
				} catch (err) {
					console.error("[CHAT_STREAM] getOrphanedStream threw", {
						conversationId,
						streamId,
						err,
					});
					closeDownstream();
					return;
				}

				if (existingStreamId === streamId) {
					console.info("[CHAT_STREAM] Reconnect to same stream", streamId);
					setTimeout(() => doReconnect(streamId), 0);
					return;
				} else if (existingStreamId) {
					const clientStreamActive = isStreamActive(streamId);
					const orphanStreamActive = isStreamActive(existingStreamId);

					if (clientStreamActive) {
						console.info(
							"[CHAT_STREAM] Reconnect to client stream (concurrent active)",
							streamId,
						);
						setTimeout(() => doReconnect(streamId), 0);
						return;
					} else if (orphanStreamActive) {
						console.info(
							"[CHAT_STREAM] Reconnect to orphan stream (client streamId stale)",
							{
								clientStreamId: streamId,
								activeOrphanStreamId: existingStreamId,
							},
						);
						setTimeout(() => doReconnect(existingStreamId), 0);
						return;
					} else {
						console.info(
							"[CHAT_STREAM] No active streams - cleaning up and starting new",
							{
								clientStreamId: streamId,
								orphanedStreamId: existingStreamId,
							},
						);
						clearStreamBuffer(existingStreamId);
					}
				}

				registerActiveChatStream({
					streamId,
					userId: user.id,
					controller: upstreamAbortController,
					conversationId,
				});

				getOrCreateStreamBuffer(streamId, normalizedMessage);
				isMainStream = true;
			}
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
			});
			let firstVisibleOutputTimeoutId: ReturnType<typeof setTimeout> | null =
				null;
			const clearFirstVisibleOutputTimeout = () => {
				if (!firstVisibleOutputTimeoutId) return;
				clearTimeout(firstVisibleOutputTimeoutId);
				firstVisibleOutputTimeoutId = null;
			};
			const emitThinking = (reasoning: string) => {
				if (reasoning) {
					recordElapsedPhase("first_thinking");
				}
				const emitted = chunkRuntime.emitThinking(reasoning);
				if (emitted && chunkRuntime.thinkingContent.trim()) {
					clearFirstVisibleOutputTimeout();
				}
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
				},
			) => {
				chunkRuntime.emitToolCallEvent(name, input, status, details);
				if (chunkRuntime.toolCallRecords.length > 0) {
					clearFirstVisibleOutputTimeout();
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
					recordElapsedPhase("first_visible_token");
					clearFirstVisibleOutputTimeout();
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
			recordDurationPhase("prelude", streamStartTime);

			let fileProductionJobIdsAtStart = new Set<string>();
			try {
				fileProductionJobIdsAtStart = new Set(
					(
						await listConversationFileProductionJobs(user.id, conversationId)
					).map((job) => job.id),
				);
			} catch (error) {
				console.warn(
					"[CHAT_STREAM] Failed to snapshot file-production jobs at stream start",
					{
						conversationId,
						streamId,
						error,
					},
				);
			}

			const emitError = (code: StreamErrorCode) =>
				enqueueChunk(streamErrorEvent(code));
			const emitResolvedAssistantText = async (
				text: string,
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
						chunkRuntime.toolCallRecords.length > 0 ||
						emittedAssistantText.trim(),
				);
			const hasVisibleStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						chunkRuntime.toolCallRecords.length > 0 ||
						emittedAssistantText.trim(),
				);
			const hasVisibleAssistantAnswerOutput = () =>
				Boolean(chunkRuntime.fullResponse.trim());
			const completedToolCallRecords = () =>
				chunkRuntime.toolCallRecords.filter(
					(record) => record.status === "done",
				);
			const hasCompletedFileProductionToolCall = () =>
				completedToolCallRecords().some((record) =>
					isFileProductionToolName(record.name),
				);
			const hasCompletedNonFileToolCall = () =>
				completedToolCallRecords().some(
					(record) => !isFileProductionToolName(record.name),
				);
			const hasPersistableStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						hasCompletedFileProductionToolCall(),
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
			const completeOrRecoverAfterUpstreamEnd = async (
				reason: "done_signal" | "end_event" | "stream_closed",
			) => {
				chunkRuntime.flushNativeToolCalls();
				if (!flushBufferedStreamOutput()) {
					return;
				}
				if (hasPersistableStreamOutput()) {
					completeSuccess();
					return;
				}
				if (
					!attemptedNonStreamFallback &&
					!wasActiveChatStreamStopRequested(streamId) &&
					fallbackToNonStreaming
				) {
					console.warn(
						"[STREAM] Upstream stream ended before final assistant answer",
						{
							conversationId,
							streamId,
							modelId,
							reason,
							thinkingLength: chunkRuntime.thinkingContent.length,
							toolCallCount: chunkRuntime.toolCallRecords.length,
							completedToolCallCount: completedToolCallRecords().length,
							hasCompletedNonFileToolCall: hasCompletedNonFileToolCall(),
						},
					);
					await fallbackToNonStreaming(
						"stream_read_failure",
						latestUpstreamAttempt,
						new Error("Upstream stream ended before final assistant answer"),
					);
					return;
				}
				failStream("backend_failure");
			};
			let latestContextStatus:
				| import("$lib/types").ConversationContextStatus
				| undefined;
			let latestActiveWorkingSet:
				| Array<{
						id: string;
						type: string;
						name: string;
						mimeType: string | null;
						sizeBytes: number | null;
						conversationId: string | null;
						summary: string | null;
						createdAt: number;
						updatedAt: number;
				  }>
				| undefined;
			let latestTaskState: import("$lib/types").TaskState | null | undefined;
			let latestContextDebug:
				| import("$lib/types").ContextDebugState
				| null
				| undefined;
			let latestHonchoContext:
				| import("$lib/types").HonchoContextInfo
				| null
				| undefined;
			let latestHonchoSnapshot:
				| import("$lib/types").HonchoContextSnapshot
				| null
				| undefined;
			let latestContextTraceSections:
				| LegacyContextTraceSectionInput[]
				| undefined;
			let latestProviderUsage: ProviderUsageSnapshot | null = null;
			let latestModelId = modelId ?? "model1";
			let latestModelDisplayName = modelDisplayName;
			let initialContextStatus:
				| import("$lib/types").ConversationContextStatus
				| undefined;
			let initialTaskState: import("$lib/types").TaskState | null | undefined;
			let initialContextDebug:
				| import("$lib/types").ContextDebugState
				| null
				| undefined;
			let initialContextTraceSections:
				| LegacyContextTraceSectionInput[]
				| undefined;
			const completeSuccess = (wasStopped = false) => {
				if (ended) return;
				ended = true;
				logPhaseTiming(wasStopped ? "stopped" : "success");
				completeStreamTurn({
					wasStopped,
					conversationId,
					streamId,
					modelId: latestModelId,
					modelDisplayName: latestModelDisplayName,
					userId: user.id,
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
					linkedSources: turn.linkedSources,
					activeSkillSessionId:
						turn.skillPromptContext?.source === "active_session"
							? turn.skillPromptContext.sessionId
							: null,
					activeDocumentArtifactId,
					requestStartTime,
					fileProductionJobIdsAtStart,
					latestContextStatus,
					latestActiveWorkingSet,
					latestTaskState,
					latestContextDebug,
					latestHonchoContext,
					latestHonchoSnapshot,
					latestContextTraceSections,
					latestProviderUsage,
					initialContextStatus,
					initialTaskState,
					initialContextDebug,
					initialContextTraceSections,
					createMessage,
					persistUserTurnAttachments,
					persistAssistantTurnState,
					persistAssistantEvidence,
					runPostTurnTasks,
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

			const failStream = (code: StreamErrorCode) => {
				if (ended) return;
				ended = true;
				logPhaseTiming("error");
				clearFirstVisibleOutputTimeout();
				if (streamId) {
					clearStreamBuffer(streamId);
				}
				emitError(code);
				closeDownstream();
			};

			const timeoutId = setTimeout(() => {
				failStream("timeout");
				upstreamAbortController.abort();
			}, getStreamTimeoutMs());
			unrefTimer(timeoutId);
			const upstreamIdleTimeoutMs = getUpstreamIdleTimeoutMs();
			const firstVisibleOutputTimeoutMs =
				getFirstVisibleOutputTimeoutMs(modelId);
			let upstreamIdleTimeoutId: ReturnType<typeof setTimeout> | null = null;
			let lastUpstreamActivityAt = Date.now();
			let upstreamIdleTimedOutBeforeOutput = false;
			let fallbackToNonStreaming:
				| ((
						reason: "stream_connect_failure" | "stream_read_failure",
						attempt: number,
						error: unknown,
				  ) => Promise<null>)
				| null = null;
			const clearUpstreamIdleTimeout = () => {
				if (!upstreamIdleTimeoutId) return;
				clearTimeout(upstreamIdleTimeoutId);
				upstreamIdleTimeoutId = null;
			};
			const scheduleUpstreamIdleTimeout = (attempt: number) => {
				clearUpstreamIdleTimeout();
				upstreamIdleTimeoutId = setTimeout(() => {
					const now = Date.now();
					console.warn("[STREAM] Upstream stream idle timeout", {
						conversationId,
						streamId,
						modelId,
						attempt,
						idleTimeoutMs: upstreamIdleTimeoutMs,
						elapsedSinceLastUpstreamMs: now - lastUpstreamActivityAt,
						responseLength: chunkRuntime.fullResponse.length,
						thinkingLength: chunkRuntime.thinkingContent.length,
						toolCallCount: chunkRuntime.toolCallRecords.length,
					});
					if (!hasVisibleAssistantAnswerOutput()) {
						upstreamIdleTimedOutBeforeOutput = true;
						void (async () => {
							const timeoutFailoverTarget =
								await resolveTimeoutFailoverTargetModelId(modelId ?? "model1");
							if (timeoutFailoverTarget && fallbackToNonStreaming && !ended) {
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
				}, upstreamIdleTimeoutMs);
				unrefTimer(upstreamIdleTimeoutId);
			};
			const markUpstreamActivity = (attempt: number) => {
				lastUpstreamActivityAt = Date.now();
				scheduleUpstreamIdleTimeout(attempt);
			};
			const scheduleFirstVisibleOutputTimeout = () => {
				if (!firstVisibleOutputTimeoutMs) return;
				clearFirstVisibleOutputTimeout();
				firstVisibleOutputTimeoutId = setTimeout(() => {
					if (hasEmittedStreamOutput()) {
						return;
					}
					console.warn("[STREAM] First visible output timeout", {
						conversationId,
						streamId,
						modelId,
						timeoutMs: firstVisibleOutputTimeoutMs,
						responseLength: chunkRuntime.fullResponse.length,
						thinkingLength: chunkRuntime.thinkingContent.length,
						toolCallCount: chunkRuntime.toolCallRecords.length,
					});
					upstreamIdleTimedOutBeforeOutput = true;
					void (async () => {
						const timeoutFailoverTarget =
							await resolveTimeoutFailoverTargetModelId(modelId ?? "model1");
						if (timeoutFailoverTarget && fallbackToNonStreaming && !ended) {
							await fallbackToNonStreaming(
								"stream_read_failure",
								latestUpstreamAttempt,
								new Error(
									"Timed out waiting for first visible upstream stream output",
								),
							);
							upstreamAbortController.abort();
							return;
						}
						failStream("timeout");
						upstreamAbortController.abort();
					})();
				}, firstVisibleOutputTimeoutMs);
				unrefTimer(firstVisibleOutputTimeoutId);
			};

			let usedUrlListRecovery = false;
			let personalityPrompt: string | undefined;
			let latestUpstreamAttempt = 1;
			let currentStreamModelId = modelId;
			let attemptedNonStreamFallback = false;
			const currentSystemPromptAppendix = () => {
				const appendices = [
					retryAppendix,
					usedUrlListRecovery ? URL_LIST_TOOL_RECOVERY_APPENDIX : undefined,
				].filter((value): value is string => Boolean(value?.trim()));
				return appendices.length > 0 ? appendices.join("\n\n") : undefined;
			};
			const retryStreamOnTimeoutFailover = async (
				attempt: number,
				error: Error,
			): Promise<boolean> => {
				const timeoutFailoverTarget = await resolveTimeoutFailoverTargetModelId(
					currentStreamModelId ?? "model1",
				);
				if (
					!timeoutFailoverTarget ||
					timeoutFailoverTarget === currentStreamModelId ||
					attempt >= 2
				) {
					return false;
				}

				console.warn(
					"[STREAM] Retrying upstream stream on failover model after timeout",
					{
						conversationId,
						attempt,
						fromModelId: currentStreamModelId ?? "model1",
						toModelId: timeoutFailoverTarget,
						errorName: error.name,
						errorMessage: error.message,
					},
				);
				currentStreamModelId = timeoutFailoverTarget;
				latestModelId = timeoutFailoverTarget;
				return true;
			};
			fallbackToNonStreaming = async (
				reason: "stream_connect_failure" | "stream_read_failure",
				attempt: number,
				error: unknown,
			): Promise<null> => {
				attemptedNonStreamFallback = true;
				const timeoutFailoverTarget =
					isLangflowTimeoutError(error) || upstreamIdleTimedOutBeforeOutput
						? await resolveTimeoutFailoverTargetModelId(
								currentStreamModelId ?? "model1",
							)
						: null;
				const fallbackModelId = timeoutFailoverTarget ?? currentStreamModelId;
				if (upstreamIdleTimedOutBeforeOutput && !timeoutFailoverTarget) {
					failStream("timeout");
					return null;
				}
				console.warn(
					reason === "stream_connect_failure"
						? "[STREAM] Falling back to non-stream Langflow run after stream connect failure"
						: "[STREAM] Falling back to non-stream Langflow run after stream body terminated before usable output",
					{
						conversationId,
						attempt,
						fromModelId: currentStreamModelId ?? "model1",
						toModelId: fallbackModelId ?? "model1",
						errorName: error instanceof Error ? error.name : undefined,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					},
				);

				const recovered = await runNonStreamFallback({
					sendMessage,
					sendParams: {
						upstreamMessage,
						conversationId,
						modelId: fallbackModelId,
						attachmentIds: safeAttachmentIds,
						activeDocumentArtifactId,
						attachmentTraceId,
						thinkingMode,
						forceWebSearch: turn.forceWebSearch,
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
					skipHonchoContext,
					onContextStatus: (status) => {
						latestContextStatus = status;
						initialContextStatus = status;
					},
					onTaskState: (state) => {
						latestTaskState = state;
						initialTaskState = state;
					},
					onContextDebug: (debug) => {
						latestContextDebug = debug;
						initialContextDebug = debug;
					},
					onHonchoContext: (ctx) => {
						latestHonchoContext = ctx;
					},
					onHonchoSnapshot: (snap) => {
						latestHonchoSnapshot = snap;
					},
					onProviderUsage: (usage) => {
						latestProviderUsage = usage;
					},
					onResolvedModel: (resolvedModelId, displayName) => {
						latestModelId = resolvedModelId;
						latestModelDisplayName = displayName;
					},
				});
				if (!recovered && !ended) {
					failStream("backend_failure");
				}

				return null;
			};
			try {
				if (personalityProfileId) {
					const profile = await getPersonalityProfile(
						personalityProfileId,
					).catch(() => null);
					personalityPrompt = profile?.promptText || undefined;
				}

				upstreamAttempt: for (let attempt = 1; attempt <= 2; attempt += 1) {
					latestUpstreamAttempt = attempt;
					const langflowRequestStartedAt = Date.now();
					const langflowResponse = await sendMessageStream(
						upstreamMessage,
						conversationId,
						currentStreamModelId,
						{
							signal: upstreamAbortController.signal,
							user: {
								id: user.id,
								displayName: user.displayName,
								email: user.email,
							},
							attachmentIds: safeAttachmentIds,
							activeDocumentArtifactId,
							attachmentTraceId,
							systemPromptAppendix: currentSystemPromptAppendix(),
							personalityPrompt,
							skipHonchoContext,
							thinkingMode,
							forceWebSearch: turn.forceWebSearch,
						},
					).catch(async (error) => {
						if (
							wasActiveChatStreamStopRequested(streamId) ||
							!shouldFallbackToNonStreaming(error) ||
							hasEmittedStreamOutput()
						) {
							throw error;
						}

						return fallbackToNonStreaming(
							"stream_connect_failure",
							attempt,
							error,
						);
					});
					recordDurationPhase("langflow_request", langflowRequestStartedAt);
					if (!langflowResponse) {
						return;
					}
					latestModelId = langflowResponse.modelId ?? latestModelId;
					latestModelDisplayName =
						langflowResponse.modelDisplayName ?? latestModelDisplayName;
					if (!langflowResponse.stream) {
						latestContextStatus = langflowResponse.contextStatus;
						initialContextStatus = latestContextStatus;
						latestTaskState = await attachContinuityToTaskState(
							user.id,
							langflowResponse.taskState ?? null,
						).catch(() => langflowResponse.taskState ?? null);
						initialTaskState = latestTaskState;
						latestContextDebug = langflowResponse.contextDebug ?? null;
						initialContextDebug = latestContextDebug;
						latestHonchoContext = langflowResponse.honchoContext ?? null;
						latestHonchoSnapshot = langflowResponse.honchoSnapshot ?? null;
						latestContextTraceSections = langflowResponse.contextTraceSections;
						initialContextTraceSections = latestContextTraceSections;

						if (
							!(await emitResolvedAssistantText(langflowResponse.text ?? ""))
						) {
							return;
						}

						flushPendingThinking();
						if (!flushInlineThinkingBuffer()) {
							return;
						}
						if (!flushOutputBuffer()) {
							return;
						}
						completeSuccess();
						return;
					}
					const langflowStream = langflowResponse.stream;
					latestContextStatus = langflowResponse.contextStatus;
					initialContextStatus = latestContextStatus;
					latestTaskState =
						langflowResponse.taskState ??
						(await getConversationTaskState(user.id, conversationId).catch(
							() => null,
						));
					latestTaskState = await attachContinuityToTaskState(
						user.id,
						latestTaskState ?? null,
					).catch(() => latestTaskState ?? null);
					initialTaskState = latestTaskState;
					latestContextDebug =
						langflowResponse.contextDebug ??
						(await getContextDebugState(user.id, conversationId).catch(
							() => null,
						));
					initialContextDebug = latestContextDebug;
					latestHonchoContext = langflowResponse.honchoContext ?? null;
					latestHonchoSnapshot = langflowResponse.honchoSnapshot ?? null;
					latestContextTraceSections = langflowResponse.contextTraceSections;
					initialContextTraceSections = latestContextTraceSections;

					scheduleFirstVisibleOutputTimeout();
					scheduleUpstreamIdleTimeout(attempt);
					try {
						for await (const upstreamEvent of parseUpstreamEvents(
							langflowStream,
						)) {
							recordElapsedPhase("first_upstream_event");
							markUpstreamActivity(attempt);
							const { event: eventType, data } = upstreamEvent;
							const eventUsage = extractProviderUsage(data);
							if (eventUsage) {
								latestProviderUsage = eventUsage;
							}
							if (data === "[DONE]") {
								await completeOrRecoverAfterUpstreamEnd("done_signal");
								return;
							}
							const isEndEvent = eventType === "end";

							if (eventType === "error") {
								const errorMessage = extractErrorMessage(data);
								console.error("[STREAM] Upstream error event payload", {
									conversationId,
									attempt,
									errorMessage,
									data:
										typeof data === "string"
											? data
											: JSON.stringify(data).slice(0, 2000),
								});
								const canRetryUrlListValidation =
									!usedUrlListRecovery &&
									isUrlListValidationError(errorMessage) &&
									!hasEmittedStreamOutput();
								if (canRetryUrlListValidation) {
									usedUrlListRecovery = true;
									lastAssistantSnapshot = "";
									emittedAssistantText = "";
									console.warn(
										"[STREAM] Retrying upstream after URL list validation error",
										{
											conversationId,
											attempt,
											errorMessage,
										},
									);
									continue upstreamAttempt;
								}
								const upstreamError = new Error(errorMessage);
								const errorCode = classifyStreamError(errorMessage);
								if (
									!hasVisibleAssistantAnswerOutput() &&
									isLangflowTimeoutError(upstreamError)
								) {
									if (
										await retryStreamOnTimeoutFailover(attempt, upstreamError)
									) {
										continue upstreamAttempt;
									}
									failStream(errorCode);
									return;
								}
								if (
									hasCompletedFileProductionToolCall() &&
									flushBufferedStreamOutput() &&
									hasPersistableStreamOutput()
								) {
									completeSuccess();
									return;
								}
								if (errorCode === "backend_failure") {
									if (
										!(await emitResolvedAssistantText(
											formatUpstreamErrorAsAssistantMessage(errorMessage),
										))
									) {
										return;
									}
									if (!flushBufferedStreamOutput()) {
										return;
									}
									completeSuccess();
									return;
								}
								failStream(errorCode);
								return;
							}

							chunkRuntime.processNativeToolCalls(data);
							const rawChunk = extractAssistantChunk(eventType, data);
							const shouldEmitRawChunk =
								!isEndEvent || !hasVisibleAssistantAnswerOutput();
							const reasoningChunk = getReasoningContent(data);
							if (reasoningChunk) {
								if (!emitThinking(reasoningChunk)) {
									return;
								}
							}
							if (!rawChunk || !shouldEmitRawChunk) {
								if (isEndEvent) {
									await completeOrRecoverAfterUpstreamEnd("end_event");
									return;
								}
								continue;
							}

							const previousEmittedAssistantText = emittedAssistantText;
							const incremental = toIncrementalChunk(
								eventType,
								rawChunk,
								lastAssistantSnapshot,
								emittedAssistantText,
							);
							lastAssistantSnapshot = incremental.lastSnapshot;
							emittedAssistantText = incremental.emittedText;
							const chunk = incremental.chunk;
							if (!chunk) {
								if (isEndEvent) {
									await completeOrRecoverAfterUpstreamEnd("end_event");
									return;
								}
								continue;
							}

							// Suppress duplicate visible text from Langflow's final summary event.
							// Nemotron streams tokens as "<thinking>...</thinking>visible" so
							// emittedAssistantText includes thinking tags, but the final non-token
							// 'message' event has only visible text (tags stripped by Langflow).
							// toIncrementalChunk can't match them, so we guard here using fullResponse
							// with trimmed comparison to handle trailing newline/space differences.
							if (eventType !== "token" && previousEmittedAssistantText) {
								const normalizedEmittedText = normalizeAssistantOutput(
									previousEmittedAssistantText,
								);
								const normalizedChunk = normalizeAssistantOutput(chunk);
								if (
									normalizedChunk &&
									(normalizedChunk === normalizedEmittedText ||
										normalizedEmittedText.endsWith(normalizedChunk) ||
										normalizedChunk.endsWith(normalizedEmittedText))
								) {
									if (isEndEvent) {
										await completeOrRecoverAfterUpstreamEnd("end_event");
										return;
									}
									continue;
								}
							}

							// Strip tool call markers, emitting structured tool_call SSE events
							const cleanedChunk = processToolCallMarkers(
								chunk,
								emitToolCallEventWithDebug,
							);

							if (!cleanedChunk) {
								if (isEndEvent) {
									await completeOrRecoverAfterUpstreamEnd("end_event");
									return;
								}
								continue;
							}

							if (!emitChunkWithOutputHandling(cleanedChunk)) {
								return;
							}

							if (eventType === "end") {
								await completeOrRecoverAfterUpstreamEnd("end_event");
								return;
							}
						}

						if (ended) {
							return;
						}
					} finally {
						clearUpstreamIdleTimeout();
					}

					await completeOrRecoverAfterUpstreamEnd("stream_closed");
					return;
				}
			} catch (error) {
				if (ended) {
					return;
				}
				if (
					wasActiveChatStreamStopRequested(streamId) &&
					error instanceof Error &&
					(error.name === "AbortError" ||
						error.message.toLowerCase().includes("abort"))
				) {
					completeSuccess(true);
					return;
				}
				if (
					!attemptedNonStreamFallback &&
					!wasActiveChatStreamStopRequested(streamId) &&
					(upstreamIdleTimedOutBeforeOutput ||
						isLangflowTimeoutError(error) ||
						(shouldFallbackToNonStreaming(error) &&
							!hasVisibleStreamOutput())) &&
					!hasVisibleAssistantAnswerOutput()
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
						completeSuccess();
						return;
					}
					if (
						!attemptedNonStreamFallback &&
						!wasActiveChatStreamStopRequested(streamId) &&
						shouldFallbackToNonStreaming(error) &&
						!hasVisibleAssistantAnswerOutput()
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
				clearUpstreamIdleTimeout();
				clearFirstVisibleOutputTimeout();
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
