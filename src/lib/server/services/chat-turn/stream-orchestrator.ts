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
import {
	persistAssistantEvidence,
	persistAssistantTurnState,
	persistUserTurnAttachments,
	runPostTurnTasks,
} from "$lib/server/services/chat-turn/finalize";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import {
	classifyStreamError,
	createEventStreamResponse,
	createServerChunkRuntime,
	createSseHeartbeatComment,
	createSsePreludeComment,
	isAbruptUpstreamTermination,
	type StreamErrorCode,
	type StreamPhaseTimings,
	streamErrorEvent,
} from "$lib/server/services/chat-turn/stream";
import { completeStreamTurn } from "$lib/server/services/chat-turn/stream-completion";
import { runNonStreamFallback } from "$lib/server/services/chat-turn/stream-fallback";
import { doReconnect as runReconnect } from "$lib/server/services/chat-turn/stream-reconnect";
import { runStreamingNormalChatSendModel } from "$lib/server/services/chat-turn/streaming-normal-chat-model-run";
import type { ChatTurnPreflight } from "$lib/server/services/chat-turn/types";
import { touchConversation } from "$lib/server/services/conversations";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import {
	createMessage,
} from "$lib/server/services/messages";
import {
	isModelTimeoutError,
	resolveModelTimeoutFailoverTargetModelId,
} from "$lib/server/services/normal-chat-failover";
import { mapNormalChatModelRunUsageToProviderSnapshot } from "$lib/server/services/normal-chat-model";

import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import type { ModelId, ToolCallEntry } from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import { isFileProductionToolName } from "$lib/utils/tool-calls";

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
		isModelTimeoutError(error) ||
		error.name === "AbortError" ||
		message.includes("abort") ||
		message.includes("timed out") ||
		message.includes("fetch failed") ||
		message.includes("socket") ||
		message.includes("connection") ||
		message.includes("terminated")
	);
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
					metadata?: Record<string, string | number | boolean | null>;
				},
			) => {
				chunkRuntime.emitToolCallEvent(name, input, status, details);
				if (chunkRuntime.toolCallRecords.length > 0) {
					clearFirstVisibleOutputTimeout();
				}
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
			const isSuccessfulFileProductionToolCall = (record: ToolCallEntry) =>
				isFileProductionToolName(record.name) &&
				record.status === "done" &&
				record.metadata?.ok !== false;
			const hasSuccessfulFileProductionToolCall = () =>
				completedToolCallRecords().some(isSuccessfulFileProductionToolCall);
			const hasCompletedNonFileToolCall = () =>
				completedToolCallRecords().some(
					(record) => !isFileProductionToolName(record.name),
				);
			const hasPersistableStreamOutput = () =>
				Boolean(
					chunkRuntime.fullResponse.trim() ||
						hasSuccessfulFileProductionToolCall(),
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
					await completeSuccess();
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
			const completeSuccess = async (wasStopped = false) => {
				if (ended) return;
				ended = true;
				logPhaseTiming(wasStopped ? "stopped" : "success");
				await completeStreamTurn({
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
								await resolveModelTimeoutFailoverTargetModelId(
									modelId ?? "model1",
								);
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
							await resolveModelTimeoutFailoverTargetModelId(
								modelId ?? "model1",
							);
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

			let personalityPrompt: string | undefined;
			let latestUpstreamAttempt = 1;
			let currentStreamModelId = (modelId ?? undefined) as ModelId | undefined;
			let attemptedNonStreamFallback = false;
			const currentSystemPromptAppendix = () => {
				const appendices = [retryAppendix].filter((value): value is string =>
					Boolean(value?.trim()),
				);
				return appendices.length > 0 ? appendices.join("\n\n") : undefined;
			};
			const retryStreamOnTimeoutFailover = async (
				attempt: number,
				error: Error,
			): Promise<boolean> => {
				const timeoutFailoverTarget =
					await resolveModelTimeoutFailoverTargetModelId(
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
				currentStreamModelId = timeoutFailoverTarget as ModelId;
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
					isModelTimeoutError(error) || upstreamIdleTimedOutBeforeOutput
						? await resolveModelTimeoutFailoverTargetModelId(
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
						? "[STREAM] Falling back to non-stream provider run after stream connect failure"
						: "[STREAM] Falling back to non-stream provider run after stream body terminated before usable output",
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
					onRecoveredToolCalls: emitRecoveredToolCalls,
					completedToolCallContext: buildCompletedToolCallFallbackContext(
						chunkRuntime.toolCallRecords,
					),
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
						forceWebSearch: turn.forceWebSearch,
						signal: upstreamAbortController.signal,
					};
					const modelRun = await runStreamingNormalChatSendModel(
						modelRunParams,
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
					recordDurationPhase(
						"model_stream_request",
						modelStreamRequestStartedAt,
					);
					if (!modelRun) {
						return;
					}
					latestModelId = modelRun.modelId ?? latestModelId;
					latestModelDisplayName =
						modelRun.modelDisplayName ?? latestModelDisplayName;
					const prepared = modelRun.prepared ?? {};
					emitPrefetchedToolCalls(modelRun.prefetchedToolCalls);
					latestContextStatus = prepared.contextStatus;
					initialContextStatus = latestContextStatus;
					latestTaskState =
						prepared.taskState ??
						(await getConversationTaskState(user.id, conversationId).catch(
							() => null,
						));
					latestTaskState = await attachContinuityToTaskState(
						user.id,
						latestTaskState ?? null,
					).catch(() => latestTaskState ?? null);
					initialTaskState = latestTaskState;
					latestContextDebug =
						prepared.contextDebug ??
						(await getContextDebugState(user.id, conversationId).catch(
							() => null,
						));
					initialContextDebug = latestContextDebug;
					latestHonchoContext = prepared.honchoContext ?? null;
					latestHonchoSnapshot = prepared.honchoSnapshot ?? null;
					latestContextTraceSections = prepared.contextTraceSections;
					initialContextTraceSections = latestContextTraceSections;

					scheduleFirstVisibleOutputTimeout();
					scheduleUpstreamIdleTimeout(attempt);
					try {
						for await (const upstreamEvent of modelRun.stream) {
							recordElapsedPhase("first_upstream_event");
							markUpstreamActivity(attempt);
							switch (upstreamEvent.type) {
								case "text_delta":
									if (!emitChunkWithOutputHandling(upstreamEvent.text)) {
										return;
									}
									break;
								case "reasoning_delta":
									if (!emitThinking(upstreamEvent.text)) {
										return;
									}
									break;
								case "tool_call":
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
									latestModelDisplayName =
										upstreamEvent.model.displayName ?? latestModelDisplayName;
									await completeOrRecoverAfterUpstreamEnd("end_event");
									return;
								case "error": {
									const errorMessage = upstreamEvent.error;
									console.error("[STREAM] Upstream error event payload", {
										conversationId,
										attempt,
										errorMessage,
									});
									const upstreamError = new Error(errorMessage);
									const errorCode = classifyStreamError(errorMessage);
									if (
										!hasVisibleAssistantAnswerOutput() &&
										isModelTimeoutError(upstreamError)
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
										hasSuccessfulFileProductionToolCall() &&
										flushBufferedStreamOutput() &&
										hasPersistableStreamOutput()
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
					await completeSuccess(true);
					return;
				}
				if (
					!attemptedNonStreamFallback &&
					!wasActiveChatStreamStopRequested(streamId) &&
					(upstreamIdleTimedOutBeforeOutput ||
						isModelTimeoutError(error) ||
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
						await completeSuccess();
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
