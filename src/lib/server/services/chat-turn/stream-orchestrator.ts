import type { FinishReason } from "ai";
import { buildMessageUserIntent } from "$lib/message-user-intent";
import type { ModelId } from "$lib/model-types";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import { getConfig } from "$lib/server/config-store";
import type { ProviderUsageSnapshot } from "$lib/server/services/analytics";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import {
	acquireChatStream,
	broadcastStreamChunk,
	clearStreamBuffer,
	getStreamBuffer,
	subscribeToStream,
	unsubscribeFromStream,
	wasActiveChatStreamStopRequested,
} from "$lib/server/services/chat-turn/active-streams";
import {
	type AskResumeInput,
	buildAskResumeCapture,
	capturedProvenanceResults,
	gateCapturedConnectorResults,
} from "$lib/server/services/chat-turn/ask-capture";
import {
	type AskResumeCapture,
	discardAskQuestion,
	discardStaleAskQuestions,
	releaseAskQuestion,
} from "$lib/server/services/chat-turn/ask-questions";
import type { LegacyContextTraceSectionInput } from "$lib/server/services/chat-turn/context-trace";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	classifyStreamErrorCause,
	createEventStreamResponse,
	createServerChunkRuntime,
	createSseHeartbeatComment,
	createSsePreludeComment,
	type StreamPhaseTimings,
	streamErrorEvent,
	streamNormalChatOutputEvent,
	streamRequestErrorEvent,
	streamResponseActivityEvent,
} from "$lib/server/services/chat-turn/stream";
import {
	completeStreamTurn,
	type StreamCompletionFact,
} from "$lib/server/services/chat-turn/stream-completion";
import { doReconnect as runReconnect } from "$lib/server/services/chat-turn/stream-reconnect";
import { createStreamTerminal } from "$lib/server/services/chat-turn/stream-terminal";
import { runStreamingNormalChatSendModel } from "$lib/server/services/chat-turn/streaming-normal-chat-model-run";
import { createThoughtStepClassifierSession } from "$lib/server/services/chat-turn/thought-step-classifier";
import { resolveTurnAcknowledgment } from "$lib/server/services/chat-turn/turn-acknowledgment";
import type {
	AdmittedChatTurn,
	ChatTurnPreflight,
	ChatTurnPreparationResult,
} from "$lib/server/services/chat-turn/types";
import { listPendingWritesForConversation } from "$lib/server/services/connections/pending-writes";
import { touchConversation } from "$lib/server/services/conversations";
import { isAbortErrorCause } from "$lib/server/services/error-cause";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { createTurnTakes } from "$lib/server/services/images/turn-takes";
import type {
	ContextDebugState,
	ConversationContextStatus,
} from "$lib/server/services/knowledge/context-types";
import type { SupportedLanguage } from "$lib/server/services/language";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile/reset-generation";
import { mapNormalChatModelRunUsageToProviderSnapshot } from "$lib/server/services/normal-chat-model";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import {
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
} from "$lib/server/services/task-state";
import type { TaskState } from "$lib/server/services/task-state/types";
import type { StreamErrorCode } from "$lib/services/stream-protocol";
import {
	createTerminalStreamTimelinePayload,
	RESPONSE_ACTIVITY_IDS,
	recordContextPreparationTimelineTimings,
	recordDurationStreamTimelineMark,
	recordElapsedStreamTimelineMark,
	SERVER_STREAM_TIMELINE_MARKS,
	type ServerStreamTimelineMark,
} from "$lib/services/stream-timeline";
import type { UserPicturesMetadata } from "$lib/shared/artifacts/image-body";
import type { InstructionScopeApplication } from "$lib/shared/instructions";
import { estimateTokenCount } from "$lib/utils/tokens";
import { isFileProductionToolName } from "$lib/utils/tool-calls";
import {
	createFileProductionCapture,
	looksLikeFileProductionLeak,
} from "./file-production-capture";
import type {
	StreamingNormalChatPreparedContext,
	StreamingNormalChatSendModelResult,
} from "./streaming-normal-chat-model-run";

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

// Pending writes keep their own synchronous turn-start snapshot.
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
		uiLanguage?: SupportedLanguage;
	};
	turn: ChatTurnPreflight;
	prepareTurn?: undefined;
	upstreamMessage: string;
	downstreamAbortSignal: AbortSignal;
	requestStartTime: number;
	startedResetGeneration?: StreamCompletionFact<number>;
	isReconnect?: boolean;
	systemPromptAppendix?: string;
	// A retry's own forced skill instructions (see chat-turn/types.ts's
	// AppliedSkillContext), pre-resolved by retry.ts from the already-prepared
	// `turn.appliedSkill` — mirrors how `systemPromptAppendix` carries retry's
	// own regeneration text above. Undefined for a fresh (non-retry) stream,
	// which instead resolves this from `preparedTurn.appliedSkill` once
	// `prepareTurn` finishes (see `currentPendingSkillInstructions` below).
	pendingSkillInstructions?: string;
	// A turn that carries a reply on from the person's answer to a question it asked
	// ("Ask me first", ask-resume.ts): the run starts from the reply so far, and the
	// question it answers is settled when the turn's segment is saved or given back
	// when it ends unsaved.
	resume?: AskResumeInput;
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
		pendingSkillInstructions: retryPendingSkillInstructions,
		resume,
		routePhaseTimings,
		prepareTurn,
	} = options;
	// What a resume adds to every model run of the turn, the stream's and its
	// non-stream rerun's: the reply so far, with the answer as the ask's result,
	// after the person's message; the history ending before that message; no page
	// read again; the captured connector results gated for each attempt (a resume's
	// original messages are the captured ones); and what the paused segment read and
	// the person typed, for the address check (ADR-0068).
	const resumeRunParams = resume
		? {
				continuationSnapshot: resume.snapshot,
				resumeDepthOverride: resume.depthOverride,
				continuationMessages: resume.continuation,
				historyBeforeMessageId: resume.userMessageId,
				skipWebPrefetch: true,
				gateMessagesForAttempt: gateCapturedConnectorResults({
					results: resume.capturedResults,
					keepConnectorDataLocal: resume.keepConnectorDataLocal,
				}),
				resumeProvenance: {
					userTexts: resume.userTexts,
					priorResults: capturedProvenanceResults({
						v: 1,
						messages: resume.continuation,
						results: resume.capturedResults,
					}),
				},
			}
		: {};
	const conversationId = turn.conversationId;
	const normalizedMessage = turn.normalizedMessage;
	const streamId = turn.streamId;
	const modelId = turn.modelId;
	const modelDisplayName = turn.modelDisplayName;
	const providerDisplayName = turn.providerDisplayName;
	const skipPersistUserMessage = turn.skipPersistUserMessage;
	const turnOrigin = turn.turnOrigin;
	const safeAttachmentIds = turn.attachmentIds;
	const activeDocumentArtifactId = turn.activeDocumentArtifactId;
	const attachmentTraceId = turn.attachmentTraceId;
	// What this turn has made with make_image, shared by the stream and its rerun.
	const turnTakes = createTurnTakes();
	const personalityProfileId = turn.personalityProfileId;
	const thinkingMode = turn.thinkingMode;
	const skillControlEnabled = getConfig().composerCommandRegistryEnabled;
	let preparedTurn: ChatTurnPreflight | null = isPreparedChatTurn(turn)
		? turn
		: null;
	let preparedPendingSkillInstructions: string | undefined;

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

	// A resume holds the claim that won its question (ask-questions.ts). Every way
	// the turn's start can end hands it back, as its outermost step: a segment that
	// was saved settled its question with the claim already (finalize) and the
	// store ignores a claim that has been, so this only gives back a question whose
	// segment was not saved, for the person to send again. Wrapping the whole start,
	// not a finally inside it, is what keeps a step from skipping it: the arbiter's
	// early returns, a throw in the setup before the turn's own try, and a throw in
	// the turn's own ending (every one would leave the chat refusing messages, with
	// no card to answer, until a restart). Best-effort: a store that is down must
	// not hide how the turn ended. A turn that is not a resume is not wrapped.
	const releaseResumeClaim = async (): Promise<void> => {
		if (!resume) return;
		try {
			await releaseAskQuestion({
				userId: user.id,
				questionId: resume.questionId,
				claim: resume.claim,
			});
		} catch (error) {
			console.warn("[CHAT_STREAM] Could not give a question back", {
				conversationId,
				streamId,
				questionId: resume.questionId,
				error,
			});
		}
	};
	let releaseOwnedStream: (discard?: boolean) => void = () => {};
	const startHoldingTheClaim =
		(
			run: (
				controller: ReadableStreamDefaultController<Uint8Array>,
			) => Promise<void>,
		) =>
		async (controller: ReadableStreamDefaultController<Uint8Array>) => {
			try {
				await run(controller);
			} catch (error) {
				releaseOwnedStream(true);
				throw error;
			} finally {
				releaseOwnedStream();
				await releaseResumeClaim();
			}
		};

	const stream = new ReadableStream({
		start: startHoldingTheClaim(async (controller) => {
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
				const decision = acquireChatStream({
					streamId,
					userId: user.id,
					conversationId,
					controller: upstreamAbortController,
					userMessage: normalizedMessage,
					reasoningDepth: turn.reasoningDepth,
					intent: isReconnect ? "observe" : "start",
				});
				if (decision.action === "observe") {
					setTimeout(() => doReconnect(decision.streamId), 0);
					return;
				}
				if (decision.action === "close") {
					closeDownstream();
					return;
				}
				releaseOwnedStream = decision.release;

				isMainStream = true;
			}
			// P2 (ADR-0056) — kick off the instant-acknowledgment control call as
			// early as this main-stream path allows (not for reconnect/close,
			// which return above without ever running a new turn), and never
			// await it here. It races the rest of turn setup in the background;
			// whichever finishes first, the turn's own work is never delayed by
			// it. `Promise.resolve(...)` guards against a mocked/misbehaving
			// resolver returning a non-promise. Wired to `emitResponseActivity`
			// once that closure exists, below. A resume asks for none: it is the
			// same reply going on, not a message to acknowledge.
			const turnAcknowledgmentPromise = resume
				? Promise.resolve(null)
				: Promise.resolve(
						resolveTurnAcknowledgment({
							userId: user.id,
							conversationId,
							message: normalizedMessage,
							signal: downstreamSignal,
						}),
					);
			const wasStopRequested = () =>
				wasActiveChatStreamStopRequested({
					streamId,
					userId: user.id,
				});
			let emitResponseActivity: (entry: ResponseActivityEntry) => void =
				() => {};
			// P3b (ADR-0056) — the reasoning-phase classifier session. Created
			// once per turn (only ever reached on the main-stream path, exactly
			// like turnAcknowledgmentPromise above), fed every reasoning-delta
			// chunk below, and read back at completion time
			// (runCompleteStreamTurn) for durable persistence. `onStep` uses the
			// same forward-reference trick as `onResponseActivity` just below —
			// `emitResponseActivity` is reassigned a few lines down, and this
			// closure always calls whichever version is current when a step
			// actually fires.
			const thoughtStepClassifierSession = createThoughtStepClassifierSession({
				userId: user.id,
				conversationId,
				signal: downstreamSignal,
				// The status line is written while Alfy thinks, before any reply text
				// exists, so no reply language can be known yet: it follows the
				// account's UI language (owner decision, 2026-10-13). This is the one
				// model call the UI language reaches; the reply itself is the model's
				// to word under REPLY_LANGUAGE_RULE, and what is written after it is in
				// the language the model names for the conversation (reply-language.ts).
				targetLanguage: user.uiLanguage ?? "en",
				onStep: (step) => {
					emitResponseActivity({
						id: `thought-step:${step.id}`,
						kind: "thought_step",
						status: "running",
						detail: step.activityClass,
						occurredAt: step.createdAt,
						...(step.entity ? { label: step.entity } : {}),
						// Amendment (2026-08-16) to ADR-0056 — the entity-grounded
						// summary, carried on the SAME existing `thought_step` kind
						// (no new stream part name). Absent whenever the runtime
						// tether guard dropped it, exactly like `label` above is
						// already absent whenever there is no entity.
						...(step.summary ? { summary: step.summary } : {}),
					});
				},
			});
			const chunkRuntime = createServerChunkRuntime({
				enqueueChunk,
				skillControlEnabled,
				structuredOutput: true,
				onThinking: (reasoning) => {
					// P3b — fed the SAME text that is about to be appended to
					// chunkRuntime.thinkingContent (this callback fires from
					// inside flushPendingThinking, after the same cleaning/
					// batching this exact chunk just went through), so the
					// classifier session's running offset stays in lockstep
					// with what becomes the persisted messages.thinking text.
					thoughtStepClassifierSession.onReasoningDelta(reasoning);
				},
				onResponseActivity: (entry) => emitResponseActivity(entry),
			});
			emitResponseActivity = (entry: ResponseActivityEntry) => {
				if (ended) return;
				const activity = {
					...entry,
					occurredAt: entry.occurredAt ?? Date.now(),
				};
				enqueueChunk(streamResponseActivityEvent(activity));
			};
			// P2 (ADR-0056) — surface the acknowledgment, if and only if it
			// arrived. `resolveTurnAcknowledgment` never rejects (it is
			// best-effort end to end), so a `null` result — cap miss, timeout,
			// malformed output, dropped topic, or any other failure — silently
			// means no acknowledgment activity is emitted and the deterministic
			// spine (context-preparing / drafting-answer, already emitted above
			// and below) is all the client ever sees, exactly as before this
			// slice. `.catch` is defense in depth only. Rides the existing
			// data-response-activity part; introduces no new stream part name.
			void turnAcknowledgmentPromise
				.then((acknowledgment) => {
					if (!acknowledgment) return;
					emitResponseActivity({
						id: RESPONSE_ACTIVITY_IDS.TURN_ACKNOWLEDGED,
						kind: "acknowledgment",
						status: "running",
						detail: acknowledgment.intentClass,
						label: acknowledgment.topic,
					});
				})
				.catch(() => {});
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
				status: "running" | "done" | "failed",
				details?: {
					callId?: string;
					outputSummary?: string | null;
					resultDigest?: string | null;
					sourceType?:
						| import("$lib/server/services/message-evidence").EvidenceSourceType
						| null;
					candidates?: import("$lib/server/services/message-evidence").ToolEvidenceCandidate[];
					metadata?: Record<string, string | number | boolean | null>;
					map?:
						| import("$lib/server/services/messages-types").ToolCallMapData
						| null;
					instructionSuggestion?:
						| import("$lib/shared/instructions").InstructionSuggestion
						| null;
				},
			) => {
				chunkRuntime.emitToolCallEvent(name, input, status, details);
			};
			const emitPrefetchedToolCalls = (
				records:
					| Array<{
							name: string;
							input: Record<string, unknown>;
							status: "running" | "done" | "failed";
							callId?: string;
							outputSummary?: string | null;
							resultDigest?: string | null;
							sourceType?:
								| import("$lib/server/services/message-evidence").EvidenceSourceType
								| null;
							candidates?: import("$lib/server/services/message-evidence").ToolEvidenceCandidate[];
							metadata?: Record<string, string | number | boolean | null>;
							map?:
								| import("$lib/server/services/messages-types").ToolCallMapData
								| null;
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
						map: record.map,
					});
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
			let latestEstimatedPromptTokens: number | undefined;
			let latestInstructionsApplied: InstructionScopeApplication | undefined;
			let latestUserPictures: UserPicturesMetadata | undefined;
			let latestProviderUsage: ProviderUsageSnapshot | null = null;
			let latestModelId = modelId ?? "model1";
			let latestModelDisplayName = modelDisplayName;
			let latestProviderIconUrl: string | null = null;
			let latestDepthMetadata: DepthMetadata | undefined =
				preparedTurn?.depthMetadata;
			let latestUpstreamFinishReason: FinishReason | null = null;
			let streamFinishReason: FinishReason | null = null;
			let stepCount: number | null = null;
			let lastStepOutputTokens: number | null = null;
			let droppedToolCalls: number | null = null;
			const recovery: "none" | "answered" | "failed" = "none";
			let latestUpstreamRawFinishReason: string | null = null;
			// The streaming model run of this turn, once it exists. What the reply
			// asked the person (ask_user) and what the run said and read are read
			// from it at the ending, long after the closures below were made. The
			// non-stream fallback has none and never asks.
			let streamingRun: StreamingNormalChatSendModelResult | null = null;
			const readTurnAsk = () => streamingRun?.getTurnAsk() ?? null;
			// The reply is paused when the run asked and what it said and read holds
			// the ask's result. A resume answers that result, so a capture without it
			// (a stream that closed without a finish can end before the step that
			// asked was captured) could never be answered: such a turn ends as one
			// that never paused, and its question is discarded.
			const buildAskPause = (): {
				questionId: string;
				capture: AskResumeCapture;
			} | null => {
				const run = streamingRun;
				const ask = readTurnAsk();
				if (!run || !ask) return null;
				return {
					questionId: ask.questionId,
					capture: buildAskResumeCapture({
						continuationGiven: run.continuationGiven,
						responseMessages: run.getResponseMessages(),
						toolCalls: [
							...run.prefetchedToolCalls,
							...run.getNormalChatToolCalls(),
						],
						priorResults: resume?.capturedResults ?? [],
						snapshot:
							run.completionTurn?.getSnapshot()?.fidelity === "exact"
								? run.completionTurn.getSnapshot()
								: undefined,
					}),
				};
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
				paused: boolean;
				noFinalAnswer: boolean;
			}) => {
				await completeStreamTurn({
					completionTurn: streamingRun?.completionTurn,
					uiLanguage: user.uiLanguage,
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
					turnOrigin,
					isReconnect,
					thinkingContent: chunkRuntime.thinkingContent,
					fullResponse: chunkRuntime.fullResponse,
					toolCallRecords: chunkRuntime.toolCallRecords,
					fileProductionToolCalls: streamingRun?.getNormalChatToolCalls(),
					// P3b (ADR-0056) — the durable step rail accumulated this turn,
					// read back at completion time and persisted into
					// assistantMetadata.thoughtSteps (see stream-completion.ts).
					thoughtSteps: thoughtStepClassifierSession.getSteps(),
					skillControlEnvelopePayloads:
						chunkRuntime.skillControlEnvelopePayloads,
					skillControlEnabled,
					serverSegments: chunkRuntime.serverSegments,
					attachmentIds: safeAttachmentIds,
					skillUse: preparedTurn?.appliedSkill
						? { displayName: preparedTurn.appliedSkill.skillDisplayName }
						: null,
					// The user's own choices for this turn — the skill they applied
					// from the composer (resolved at preflight) and a forced `/web` —
					// recorded with the assistant message for its provenance line.
					userIntent: buildMessageUserIntent({
						skill: preparedTurn?.appliedSkill
							? {
									id: preparedTurn.appliedSkill.skillId,
									displayName: preparedTurn.appliedSkill.skillDisplayName,
								}
							: null,
						forceWebSearch: turn.forceWebSearch,
					}),
					activeDocumentArtifactId: activeDocumentArtifactId ?? null,
					requestStartTime,
					pendingWriteIdsAtStart: ensurePendingWriteIdsAtStart(),
					// The former latest*/initial* mirror-pairs always held the same
					// value at this boundary, so they collapse into one prepared-context
					// snapshot carried across as a single object.
					preparedContext: {
						contextStatus: latestContextStatus,
						taskState: latestTaskState,
						contextDebug: latestContextDebug,
						contextTraceSections: latestContextTraceSections,
						estimatedPromptTokens: latestEstimatedPromptTokens,
						instructionsApplied: latestInstructionsApplied,
						userPictures: latestUserPictures,
					},
					latestProviderUsage,
					streamFinishReason,
					stepCount,
					lastStepOutputTokens,
					droppedToolCalls,
					recovery,
					visibleCharsAfterLastToolCall:
						chunkRuntime.visibleCharsAfterLastToolCall,
					strippedVisibleChars: chunkRuntime.strippedVisibleChars,
					upstreamFinishReason: latestUpstreamFinishReason,
					upstreamRawFinishReason: latestUpstreamRawFinishReason,
					streamClosedWithoutFinish: args.streamClosedWithoutFinish,
					noFinalAnswer: args.noFinalAnswer,
					askPause: args.paused ? buildAskPause() : null,
					askResume: resume ?? null,
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
				getCompletion: () =>
					streamingRun?.completionTurn?.getSnapshot()?.completion,
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
				flushBufferedStreamOutput,
				wasStopRequested,
			});
			const {
				completeSuccess,
				failStream,
				failPreparedTurnStream,
				completeAfterUpstreamEnd,
			} = terminal;

			let personalityPrompt: string | undefined;
			let _latestUpstreamAttempt = 1;
			const currentStreamModelId = (modelId ?? undefined) as
				| ModelId
				| undefined;
			const _attemptedNonStreamFallback = false;
			const currentSystemPromptAppendix = () => {
				return retryAppendix?.trim() ? retryAppendix : undefined;
			};
			// On-demand skill loading: a retry pre-resolves its own forced skill
			// instructions (retryPendingSkillInstructions); a fresh stream resolves
			// them from `preparedTurn.appliedSkill` once `prepareTurn` finishes (see
			// `preparedPendingSkillInstructions` below) — exactly mirroring
			// currentSystemPromptAppendix's retry-vs-fresh split above.
			const currentPendingSkillInstructions = () => {
				return (
					retryPendingSkillInstructions ?? preparedPendingSkillInstructions
				);
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
				preparedPendingSkillInstructions = prepareTurn
					? (preparedTurn.appliedSkill?.instructionsEnvelope ?? undefined)
					: undefined;
				latestDepthMetadata = preparedTurn.depthMetadata;
				recordDepthSelectionPhase(latestDepthMetadata);
				emitResponseActivity({
					id: RESPONSE_ACTIVITY_IDS.DEPTH_SELECTED,
					kind: "depth",
					status: "done",
					detail: latestDepthMetadata.appliedProfile,
				});
				ensurePendingWriteIdsAtStart();
				// A crash, or a turn that could not save, leaves questions that no reply
				// was saved with. A turn that holds the chat's stream (the arbiter above
				// ran for it: it has a streamId) clears this chat's before it can ask its
				// own; the arbiter lets one stream run per chat, so none of them is being
				// asked now. A turn with no streamId is not arbitrated and may overlap
				// another turn of the chat, so it leaves them to a turn that holds the
				// stream. Best-effort: a store that is down must not stop the turn.
				if (isMainStream) {
					try {
						await discardStaleAskQuestions({
							userId: user.id,
							conversationId,
						});
					} catch (error) {
						console.warn(
							"[CHAT_STREAM] Could not clear the chat's stale questions",
							{
								conversationId,
								streamId,
								error,
							},
						);
					}
				}

				if (personalityProfileId) {
					const profile = await getPersonalityProfile(
						personalityProfileId,
					).catch(() => null);
					personalityPrompt = profile?.promptText || undefined;
				}

				const attempt = 1;
				_latestUpstreamAttempt = attempt;
				const modelStreamRequestStartedAt = Date.now();
				const modelRunParams = {
					userId: user.id,
					completionRequestId: streamId ?? undefined,
					onOutputEvent: (
						event: import("$lib/shared/normal-chat-output").NormalChatOutputEvent,
					) => {
						enqueueChunk(streamNormalChatOutputEvent(event));
					},
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
					pictureRefs: turn.pictureRefs,
					imageMarks: turn.imageMarks,
					turnTakes,
					attachmentTraceId: attachmentTraceId ?? undefined,
					systemPromptAppendix: currentSystemPromptAppendix(),
					pendingSkillInstructions: currentPendingSkillInstructions(),
					personalityPrompt,
					thinkingMode,
					depthMetadata: latestDepthMetadata,
					forceWebSearch: turn.forceWebSearch,
					enabledConnectionCapabilities: turn.enabledConnectionCapabilities,
					...resumeRunParams,
					signal: upstreamAbortController.signal,
					onResponseActivity: emitResponseActivity,
					// A tool waiting on a job (a picture) is activity, so a long wait
					// never reads as a silent stream. `touch` never revives a stream
					// that has ended.
				};
				const modelRun = await runStreamingNormalChatSendModel(modelRunParams);
				latestProviderIconUrl = modelRun.providerIconUrl ?? null;

				recordDurationPhase(
					SERVER_STREAM_TIMELINE_MARKS.MODEL_STREAM_REQUEST,
					modelStreamRequestStartedAt,
				);
				if (!modelRun) {
					return;
				}
				streamingRun = modelRun;
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
				latestEstimatedPromptTokens = prepared.estimatedPromptTokens;
				latestInstructionsApplied = prepared.instructionsApplied;
				latestUserPictures = prepared.userPictures;
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

				// Text written while a produce_file call is in flight (and a short
				// window after it) is buffered and classified once: leaked document
				// JSON / repair narration goes to the thinking lane, real answer text
				// stays visible (file-production-capture.ts).
				const fileProductionCapture = createFileProductionCapture();
				const FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS = 300;
				const flushFileProductionCapture = (): boolean => {
					const captured = fileProductionCapture.buffer;
					fileProductionCapture.buffer = "";
					fileProductionCapture.postWindowChars = 0;
					if (!captured) return true;
					return looksLikeFileProductionLeak(captured)
						? emitThinking(captured)
						: emitChunkWithOutputHandling(captured);
				};
				for await (const upstreamEvent of modelRun.stream) {
					recordElapsedPhase(SERVER_STREAM_TIMELINE_MARKS.FIRST_UPSTREAM_EVENT);
					switch (upstreamEvent.type) {
						case "text_delta":
							if (modelRun.completionTurn) {
								thoughtStepClassifierSession.stop();
								if (!emitChunkWithOutputHandling(upstreamEvent.text)) return;
								break;
							}
							if (
								fileProductionCapture.active ||
								fileProductionCapture.postWindowChars > 0
							) {
								fileProductionCapture.buffer += upstreamEvent.text;
								if (!fileProductionCapture.active) {
									fileProductionCapture.postWindowChars = Math.max(
										0,
										fileProductionCapture.postWindowChars -
											upstreamEvent.text.length,
									);
									if (
										fileProductionCapture.postWindowChars === 0 &&
										!flushFileProductionCapture()
									) {
										return;
									}
								}
							} else {
								// P3b — "Classification stops hard on the first answer
								// text-delta" (architecture-deepening-slices.md § P3b).
								// This branch is real visible-answer output (the
								// file-production capture branch above is not), so this
								// is exactly that boundary. Idempotent; called on every
								// answer chunk rather than tracked separately.
								thoughtStepClassifierSession.stop();
								if (!emitChunkWithOutputHandling(upstreamEvent.text)) {
									return;
								}
							}
							break;
						case "reasoning_delta":
							if (!emitThinking(upstreamEvent.text)) {
								return;
							}
							break;
						case "tool_call":
							if (isFileProductionToolName(upstreamEvent.toolName)) {
								fileProductionCapture.active = true;
								fileProductionCapture.postWindowChars = 0;
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
								fileProductionCapture.active = false;
								if (!flushFileProductionCapture()) {
									return;
								}
								fileProductionCapture.postWindowChars =
									FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS;
							}
							// A tool can RETURN a failure rather than throw one — the
							// AI SDK still calls this a tool_result. produce_file does
							// exactly that when the file-production ledger reports the
							// job failed. Honour the recorded entry's own status so the
							// activity row shows the failure glyph instead of "done",
							// matching what the thrown-error branch below emits.
							emitToolCallEventWithDebug(
								upstreamEvent.toolName,
								matchingToolCall?.input ?? {},
								matchingToolCall?.status === "failed" ? "failed" : "done",
								{
									callId: upstreamEvent.callId,
									outputSummary: matchingToolCall?.outputSummary ?? null,
									resultDigest: matchingToolCall?.resultDigest ?? null,
									sourceType: matchingToolCall?.sourceType ?? null,
									candidates: matchingToolCall?.candidates ?? [],
									metadata: matchingToolCall?.metadata ?? {},
									map: matchingToolCall?.map ?? null,
									// Slice F — the recorded entry is the only place a
									// `suggest_instruction` offer exists at this point;
									// finalize persists it off the runtime's records.
									instructionSuggestion:
										matchingToolCall?.instructionSuggestion ?? null,
								},
							);
							break;
						}
						case "tool_error": {
							const matchingToolCall = modelRun
								.getNormalChatToolCalls()
								.find((record) => record.callId === upstreamEvent.callId);
							if (isFileProductionToolName(upstreamEvent.toolName)) {
								fileProductionCapture.active = false;
								if (!flushFileProductionCapture()) {
									return;
								}
								fileProductionCapture.postWindowChars =
									FILE_PRODUCTION_POST_CAPTURE_MAX_CHARS;
							}
							// E1 — a failed tool call is a "failed" status, not a fake
							// "done". `errorCode` rides the same StreamErrorCode
							// vocabulary `data-stream-error` uses, via the shared
							// cause -> code seam (classifyStreamErrorCause), so a
							// failed tool call is never represented as having
							// succeeded.
							emitToolCallEventWithDebug(
								upstreamEvent.toolName,
								matchingToolCall?.input ?? {},
								"failed",
								{
									callId: upstreamEvent.callId,
									outputSummary: null,
									sourceType: null,
									candidates: [],
									metadata: {
										ok: false,
										evidenceReady: false,
										error: upstreamEvent.error,
										errorCode: classifyStreamErrorCause(
											new Error(upstreamEvent.error),
										),
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
							if (!flushFileProductionCapture()) {
								return;
							}
							latestModelId =
								(upstreamEvent.model.modelId as ModelId | undefined) ??
								latestModelId;
							latestModelDisplayName =
								upstreamEvent.model.displayName ?? latestModelDisplayName;
							latestUpstreamFinishReason = upstreamEvent.finishReason;
							streamFinishReason = upstreamEvent.finishReason;
							stepCount = upstreamEvent.stepCount ?? null;
							lastStepOutputTokens = upstreamEvent.lastStepOutputTokens ?? null;
							droppedToolCalls = upstreamEvent.droppedToolCalls ?? null;
							latestUpstreamRawFinishReason =
								upstreamEvent.rawFinishReason ?? null;
							// Upstream has finished; its idle watchdog must not race the repair.
							await completeAfterUpstreamEnd("end_event");
							return;
						case "error": {
							latestUpstreamFinishReason = "error";
							latestUpstreamRawFinishReason = upstreamEvent.error;
							if (modelRun.completionTurn?.getSnapshot()?.completion)
								await completeAfterUpstreamEnd("end_event");
							else
								failStream(
									classifyStreamErrorCause(new Error(upstreamEvent.error)),
								);
							return;
						}
					}
				}

				if (ended) {
					return;
				}

				await completeAfterUpstreamEnd("stream_closed");
				return;
			} catch (error) {
				if (ended) {
					return;
				}
				if (wasStopRequested() && isAbortErrorCause(error)) {
					await completeSuccess(true);
					return;
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
				failStream(classifyStreamErrorCause(error));
			} finally {
				try {
					await streamingRun?.completionTurn?.finish();
				} catch (error) {
					console.error("[CHAT_STREAM] Completion audit could not settle", {
						conversationId,
						streamId,
						error,
					});
					if (!ended) failStream("backend_failure");
				}
				clearInterval(heartbeatIntervalId);
				releaseOwnedStream();
				cancelStream = () => undefined;
				// A question the run recorded stays only if the reply that asked it was
				// saved, paused and tied to it (finalize stamps it before the terminal
				// frame). Whatever else ended the turn (a stop, an error, a fallback, a
				// chat deleted meanwhile, a stamp that failed) leaves it with no reply
				// to belong to, so it goes. The store ignores a stamped question.
				const askedQuestion = readTurnAsk();
				if (askedQuestion) {
					try {
						await discardAskQuestion({
							userId: user.id,
							questionId: askedQuestion.questionId,
						});
					} catch (error) {
						console.warn(
							"[CHAT_STREAM] Could not discard an unsaved question",
							{
								conversationId,
								streamId,
								questionId: askedQuestion.questionId,
								error,
							},
						);
					}
				}
			}
		}),
		cancel() {
			cancelStream();
		},
	});

	return createEventStreamResponse(stream, { serverTiming: routePhaseTimings });
}
