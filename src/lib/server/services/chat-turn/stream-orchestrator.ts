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
	getReasoningContent,
	isAbruptUpstreamTermination,
	isUrlListValidationError,
	parseUpstreamEvents,
	processToolCallMarkers,
	type StreamErrorCode,
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
import { sendMessage, sendMessageStream } from "$lib/server/services/langflow";
import { createMessage } from "$lib/server/services/messages";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import { estimateTokenCount } from "$lib/utils/tokens";

function getStreamTimeoutMs(): number {
	return Math.max(60_000, getConfig().requestTimeoutMs);
}

function getUpstreamIdleTimeoutMs(): number {
	const requestTimeoutMs = getConfig().requestTimeoutMs;
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

	const encoder = new TextEncoder();
	let cancelStream = () => undefined;

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
				onToken: (chunk) => {
					if (streamId)
						appendToStreamBuffer(streamId, "token", { text: chunk });
				},
				onThinking: (reasoning) => {
					if (streamId)
						appendToStreamBuffer(streamId, "thinking", { text: reasoning });
				},
				onToolCall: (name, input, status, outputSummary) => {
					if (streamId) {
						appendToStreamBuffer(streamId, "tool_call", {
							name,
							input,
							status,
							outputSummary,
						});
					}
				},
			});
			const emitThinking = chunkRuntime.emitThinking;
			const emitToolCallEventWithDebug = (
				name: string,
				input: Record<string, unknown>,
				status: "running" | "done",
				details?: {
					outputSummary?: string | null;
					sourceType?: import("$lib/types").EvidenceSourceType | null;
					candidates?: import("$lib/types").ToolEvidenceCandidate[];
				},
			) => {
				chunkRuntime.emitToolCallEvent(name, input, status, details);
			};
			const emitChunkWithOutputHandling =
				chunkRuntime.emitChunkWithOutputHandling;
			const flushPendingThinking = chunkRuntime.flushPendingThinking;
			const flushInlineThinkingBuffer = chunkRuntime.flushInlineThinkingBuffer;
			const flushOutputBuffer = chunkRuntime.flushOutputBuffer;
			const heartbeatIntervalId = setInterval(() => {
				enqueueChunk(createSseHeartbeatComment());
			}, 15000);
			unrefTimer(heartbeatIntervalId);

			enqueueChunk(createSsePreludeComment());

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
			const hasPersistableStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						chunkRuntime.toolCallRecords.some(
							(record) => record.status === "done",
						),
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
			let latestProviderUsage: ProviderUsageSnapshot | null = null;
			let initialContextStatus:
				| import("$lib/types").ConversationContextStatus
				| undefined;
			let initialTaskState: import("$lib/types").TaskState | null | undefined;
			let initialContextDebug:
				| import("$lib/types").ContextDebugState
				| null
				| undefined;
			const completeSuccess = (wasStopped = false) => {
				if (ended) return;
				ended = true;
				completeStreamTurn({
					wasStopped,
					conversationId,
					streamId,
					modelId,
					modelDisplayName,
					userId: user.id,
					normalizedMessage,
					upstreamMessage,
					skipPersistUserMessage,
					isReconnect,
					thinkingContent: chunkRuntime.thinkingContent,
					fullResponse: chunkRuntime.fullResponse,
					toolCallRecords: chunkRuntime.toolCallRecords,
					serverSegments: chunkRuntime.serverSegments,
					attachmentIds: safeAttachmentIds,
					activeDocumentArtifactId,
					requestStartTime,
					fileProductionJobIdsAtStart,
					latestContextStatus,
					latestActiveWorkingSet,
					latestTaskState,
					latestContextDebug,
					latestHonchoContext,
					latestHonchoSnapshot,
					latestProviderUsage,
					initialContextStatus,
					initialTaskState,
					initialContextDebug,
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
			let upstreamIdleTimeoutId: ReturnType<typeof setTimeout> | null = null;
			let lastUpstreamActivityAt = Date.now();
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
					failStream("timeout");
					upstreamAbortController.abort();
				}, upstreamIdleTimeoutMs);
				unrefTimer(upstreamIdleTimeoutId);
			};
			const markUpstreamActivity = (attempt: number) => {
				lastUpstreamActivityAt = Date.now();
				scheduleUpstreamIdleTimeout(attempt);
			};

			let usedUrlListRecovery = false;
			let personalityPrompt: string | undefined;
			let latestUpstreamAttempt = 1;
			let attemptedNonStreamFallback = false;
			const currentSystemPromptAppendix = () =>
				retryAppendix ??
				(usedUrlListRecovery ? URL_LIST_TOOL_RECOVERY_APPENDIX : undefined);
			const fallbackToNonStreaming = async (
				reason: "stream_connect_failure" | "stream_read_failure",
				attempt: number,
				error: unknown,
			): Promise<null> => {
				attemptedNonStreamFallback = true;
				console.warn(
					reason === "stream_connect_failure"
						? "[STREAM] Falling back to non-stream Langflow run after stream connect failure"
						: "[STREAM] Falling back to non-stream Langflow run after stream body terminated before usable output",
					{
						conversationId,
						attempt,
						errorName: error instanceof Error ? error.name : undefined,
						errorMessage:
							error instanceof Error ? error.message : String(error),
					},
				);

				await runNonStreamFallback({
					sendMessage,
					sendParams: {
						upstreamMessage,
						conversationId,
						modelId,
						attachmentIds: safeAttachmentIds,
						activeDocumentArtifactId,
						attachmentTraceId,
					},
					user,
					attachContinuityToTaskState,
					emitResolvedAssistantText,
					flushPendingThinking,
					flushInlineThinkingBuffer,
					flushOutputBuffer,
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
				});

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
					const langflowResponse = await sendMessageStream(
						upstreamMessage,
						conversationId,
						modelId,
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
					if (!langflowResponse) {
						return;
					}
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

					scheduleUpstreamIdleTimeout(attempt);
					try {
						for await (const upstreamEvent of parseUpstreamEvents(
							langflowStream,
						)) {
							markUpstreamActivity(attempt);
							const { event: eventType, data } = upstreamEvent;
							const eventUsage = extractProviderUsage(data);
							if (eventUsage) {
								latestProviderUsage = eventUsage;
							}
							if (data === "[DONE]" || eventType === "end") {
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
								failStream(classifyStreamError(errorMessage));
								return;
							}

							const rawChunk = extractAssistantChunk(eventType, data);
							const reasoningChunk = getReasoningContent(data);
							if (reasoningChunk) {
								if (!emitThinking(reasoningChunk)) {
									return;
								}
							}
							if (!rawChunk) {
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
							if (!chunk) continue;

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
									continue;
								}
							}

							// Strip tool call markers, emitting structured tool_call SSE events
							const cleanedChunk = processToolCallMarkers(
								chunk,
								emitToolCallEventWithDebug,
							);

							if (!cleanedChunk) continue;

							if (!emitChunkWithOutputHandling(cleanedChunk)) {
								return;
							}
						}
					} finally {
						clearUpstreamIdleTimeout();
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
					shouldFallbackToNonStreaming(error) &&
					!hasEmittedStreamOutput()
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
						chunkRuntime.toolCallRecords.length === 0
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

	return createEventStreamResponse(stream);
}
