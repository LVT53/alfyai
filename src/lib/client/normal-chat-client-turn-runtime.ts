import { submitAtlasTurn } from "$lib/client/api/atlas";
import {
	checkForOrphanedStream,
	getStreamBufferInfo,
	type StreamCallbacks,
	type StreamChatOptions,
	type StreamHandle,
	type StreamMetadata,
	type StreamTimingSnapshot,
	streamChat,
} from "$lib/services/streaming";
import type {
	ArtifactSummary,
	AtlasAction,
	AtlasProfile,
	ChatMessage,
	LinkedContextSource,
	ModelId,
	NormalChatRuntimePhase,
	PendingAttachment,
	PendingSkillSelection,
	ReasoningDepth,
	ResponseActivityEntry,
} from "$lib/types";

type StreamToolCallDetails = Parameters<
	NonNullable<StreamCallbacks["onToolCall"]>
>[3];

export type NormalChatSendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	linkedSources?: LinkedContextSource[];
	pendingSkill?: PendingSkillSelection | null;
	conversationId?: string | null;
	modelId?: ModelId;
	personalityProfileId?: string | null;
	reasoningDepth?: ReasoningDepth;
	forceWebSearch?: boolean;
	// Issue 7.2 — composer connection capability selection for this turn.
	enabledConnectionCapabilities?: string[];
	atlasMode?: boolean;
	atlasProfile?: AtlasProfile | null;
	atlasAction?: AtlasAction;
	parentAtlasJobId?: string | null;
	clientAtlasTurnId?: string | null;
};

export type NormalChatRuntimeSnapshot = {
	phase: NormalChatRuntimePhase;
	active: boolean;
	isSending: boolean;
	isPollingForCompletion: boolean;
	streamInterruptedByBackground: boolean;
	canRetry: boolean;
	queuedTurn: NormalChatSendPayload | null;
	queuedContextCompression: boolean;
	lastUserMessage: string;
	lastAssistantResponse: string;
};

type PendingSkillSessionResult =
	| { ok: true }
	| {
			ok: false;
			errorMessage: string;
			restoredPayload?: NormalChatSendPayload | null;
	  };

// R1 (ADR-0060) — the visible message-list mutations the runtime drives used
// to be nine separate one-line adapter members (appendUserMessage,
// appendAssistantPlaceholder, appendTokenChunk, appendThinkingChunk,
// applyToolCallUpdate, applyResponseActivityUpdate, setAssistantRuntimePhase,
// removeMessage, finalizeStreamingMessage), each a pass-through to a page-side
// list helper that already existed. The runtime picked *which* mutation
// happened and *when*; the page's implementation was always "call the helper
// with these args and update the store." Consolidated into one typed event +
// one adapter member (`applyMessageListEvent`) so the interface no longer
// enumerates every mutation shape — the page still owns the message list and
// still owns the helpers, it just receives one event instead of nine entry
// points.
export type NormalChatMessageListEvent =
	| { type: "appendUser"; message: ChatMessage }
	| { type: "appendAssistantPlaceholder"; placeholder: ChatMessage }
	| { type: "appendToken"; placeholderId: string; chunk: string }
	| { type: "appendThinking"; placeholderId: string; chunk: string }
	| {
			type: "applyToolCall";
			placeholderId: string;
			name: string;
			input: Record<string, unknown>;
			status: "running" | "done";
			details?: StreamToolCallDetails;
	  }
	| {
			type: "applyResponseActivity";
			placeholderId: string;
			entry: ResponseActivityEntry;
	  }
	| {
			type: "setRuntimePhase";
			placeholderId: string;
			phase: NormalChatRuntimePhase;
	  }
	| { type: "remove"; messageId: string }
	| {
			type: "finalize";
			placeholderId: string;
			clientUserMessageId: string | null;
			metadata?: StreamMetadata;
	  };

export type NormalChatClientTurnRuntimeAdapters = {
	streamChat: typeof streamChat;
	checkForOrphanedStream: typeof checkForOrphanedStream;
	getStreamBufferInfo: typeof getStreamBufferInfo;
	submitAtlasTurn: typeof submitAtlasTurn;
	getConversationId: () => string;
	getSelectedModel: () => ModelId;
	getReasoningDepth: () => ReasoningDepth;
	getPersonalityProfileId: () => string | null;
	getActiveDocumentArtifactId: () => string | undefined;
	getMessages: () => ChatMessage[];
	isReadOnly: () => boolean;
	isEditResendPending: () => boolean;
	isBrowserHidden: () => boolean;
	randomId: () => string;
	schedule: (
		callback: () => void,
		delayMs: number,
	) => ReturnType<typeof setTimeout>;
	onStateChange?: (snapshot: NormalChatRuntimeSnapshot) => void;
	onStreamTiming?: (timing: StreamTimingSnapshot) => void;
	setConversationModelSelection: (modelId: ModelId) => void;
	setInitialStreamPending?: (pending: boolean) => void;
	setSuppressHydration?: (suppress: boolean) => void;
	markHasPersistedMessages?: () => void;
	clearDraft: () => void;
	deleteDraft?: () => void;
	clearAttachedArtifacts: () => ArtifactSummary[];
	recordConversationActivity: () => void;
	startPendingSkillSession: (
		payload: NormalChatSendPayload,
	) => Promise<PendingSkillSessionResult>;
	applyMessageListEvent: (event: NormalChatMessageListEvent) => void;
	shouldHydrateFileProductionJobsOnToolCall?: (
		name: string,
		status: "running" | "done",
	) => boolean;
	applyStreamMetadata: (metadata?: StreamMetadata) => void;
	attachFileProductionJobsToAssistantMessage: (
		assistantMessageId: string,
	) => void;
	// Issue 7.5 — called at the same "assistant message id is now known"
	// moment as attachFileProductionJobsToAssistantMessage above, so any
	// pending write proposed this turn picks up its server-backfilled
	// assistantMessageId (see reconcilePendingWritesForAssistantMessage,
	// chat-turn/finalize.ts) before the message transitions out of the
	// "currently streaming" fallback match in MessageArea's
	// getPendingWritesForMessage — without this, the write-confirm card
	// would briefly disappear the instant the turn finishes streaming.
	refreshPendingWrites?: () => void;
	pollMessageEvidence: (assistantMessageId: string) => void;
	refreshMessageCost: (assistantMessageId: string) => void;
	hydrateConversationDetail: () => void;
	pollForCompletion: (
		placeholderId: string,
		clientUserMessageId?: string | null,
	) => void;
	loadPersistedData: () => Promise<void> | void;
	mergeGeneratedFiles?: (
		files: NonNullable<StreamMetadata["generatedFiles"]>,
	) => void;
	mergeFileProductionJobs?: (
		jobs: NonNullable<StreamMetadata["fileProductionJobs"]>,
	) => void;
	setContextCompressionMarkers?: (
		markers: NonNullable<StreamMetadata["contextCompressionSnapshots"]>,
	) => void;
	maybeTriggerTitleGeneration: (
		userMessage: string,
		assistantResponse: string,
	) => void;
	runManualContextCompression: () => Promise<void> | void;
	restorePayloadToDraft: (payload: NormalChatSendPayload) => void;
	markPendingSkillUnavailable: (
		payload: NormalChatSendPayload,
	) => NormalChatSendPayload;
	isPendingSkillUnavailableError: (error: unknown) => boolean;
	isForkedSourceHistoryConfirmationRequired: (error: unknown) => boolean;
	toFriendlySendError: (error: Error) => string;
	setSendError: (message: string | null) => void;
	setSkillSessionError: (message: string | null) => void;
	onBackgroundInterrupted: () => void;
	onBackgroundVisibilityRestore?: () => void;
	onForkedSourceHistoryConfirmationRequired?: () => void;
};

export type BrowserNormalChatClientTurnRuntimeAdapters = Omit<
	NormalChatClientTurnRuntimeAdapters,
	"streamChat" | "checkForOrphanedStream" | "getStreamBufferInfo"
>;

type SendRuntimeOptions = {
	skipUserMessage?: boolean;
	skipPersistUserMessage?: boolean;
	clearDraft?: boolean;
	retryAssistantMessageId?: string;
	retryUserMessageId?: string;
	confirmForkedSourceHistoryMutation?: boolean;
	onForkedSourceHistoryConfirmationRequired?: () => void;
};

type StartStreamParams = {
	message: string;
	placeholderId: string;
	clientUserMessageId: string | null;
	payload?: NormalChatSendPayload;
	streamOptions: StreamChatOptions;
	completedUserMessage: string;
	// R1 (ADR-0060, defect 2) — the conversation this turn was started
	// against, captured once from `adapters.getConversationId()` at the
	// moment the turn began (send/retry/reconnect). Every subsequent write
	// this turn makes is checked against the CURRENT `getConversationId()`
	// before it reaches an adapter; a page navigation away from this
	// conversation makes the check fail and the write is dropped rather than
	// landing on whatever conversation is now displayed.
	turnConversationId: string;
	isReconnect?: boolean;
	reconnectStreamId?: string;
	reconnectRetryCount?: number;
	// D2 (drain + graceful deploy): bounded retry count for a *fresh* send
	// (not a reconnect) that hit a capacity/global_limit rejection — e.g. the
	// server is draining ahead of a deploy restart. Mirrors
	// `reconnectRetryCount`'s backoff idiom below.
	capacityRetryCount?: number;
	// R1 (ADR-0060, defect 1): bounded retry count for a *fresh* send whose
	// connection dropped after content had already streamed. Mirrors
	// `capacityRetryCount`'s backoff idiom, but recovers via the orphaned
	// stream (the server keeps generating independent of this dropped
	// client connection) instead of a brand-new request.
	networkRetryCount?: number;
	onForkedSourceHistoryConfirmationRequired?: () => void;
};

/**
 * Token Display Buffer — requestAnimationFrame-aligned batching layer.
 * Accumulates text chunks and flushes once per animation frame,
 * preventing jank from per-delta Svelte store updates.
 *
 * Falls back to synchronous delivery when requestAnimationFrame is
 * unavailable (SSR or test environments without DOM).
 */
class TokenDisplayBuffer {
	private accumulator = "";
	private rafId: number | null = null;
	private readonly flushCallback: (text: string) => void;
	private readonly rafAvailable: boolean;

	constructor(flushCallback: (text: string) => void) {
		this.flushCallback = flushCallback;
		this.rafAvailable = typeof requestAnimationFrame !== "undefined";
	}

	append(chunk: string): void {
		if (!this.rafAvailable) {
			// Fall back to old behaviour: deliver immediately
			this.flushCallback(chunk);
			return;
		}
		this.accumulator += chunk;
		if (this.rafId === null) {
			this.rafId = requestAnimationFrame(() => {
				this.rafId = null;
				this.flush();
			});
		}
	}

	flush(): void {
		if (this.accumulator === "") return;
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		const text = this.accumulator;
		this.accumulator = "";
		this.flushCallback(text);
	}
}

export type NormalChatClientTurnRuntime = ReturnType<
	typeof createNormalChatClientTurnRuntime
>;

export function createBrowserNormalChatClientTurnRuntime(
	adapters: BrowserNormalChatClientTurnRuntimeAdapters,
) {
	return createNormalChatClientTurnRuntime({
		...adapters,
		streamChat,
		checkForOrphanedStream,
		getStreamBufferInfo,
		submitAtlasTurn,
	});
}

export function createNormalChatClientTurnRuntime(
	adapters: NormalChatClientTurnRuntimeAdapters,
) {
	let activeStream: StreamHandle | null = null;
	let activeTokenBuffer: TokenDisplayBuffer | null = null;
	let activeThinkingBuffer: TokenDisplayBuffer | null = null;
	let activePlaceholderId: string | null = null;
	let phase: NormalChatRuntimePhase = "idle";
	let isSending = false;
	let isPollingForCompletion = false;
	let streamInterruptedByBackground = false;
	let canRetry = false;
	let queuedTurn: NormalChatSendPayload | null = null;
	let queuedContextCompression = false;
	let lastUserMessage = "";
	let lastAssistantResponse = "";
	let lastReasoningDepth: ReasoningDepth = "auto";

	function snapshot(): NormalChatRuntimeSnapshot {
		return {
			phase,
			active: Boolean(activeStream),
			isSending,
			isPollingForCompletion,
			streamInterruptedByBackground,
			canRetry,
			queuedTurn: queuedTurn ? cloneSendPayload(queuedTurn) : null,
			queuedContextCompression,
			lastUserMessage,
			lastAssistantResponse,
		};
	}

	function emitState() {
		adapters.onStateChange?.(snapshot());
	}

	// R1 (ADR-0060, defect 2) — true only while `turnConversationId` (the
	// conversation this turn started against) is still the one the page is
	// currently showing. Every write a turn makes must pass this check
	// immediately before it reaches an adapter.
	function isTurnConversationActive(turnConversationId: string): boolean {
		return adapters.getConversationId() === turnConversationId;
	}

	function setActiveStream(nextStream: StreamHandle | null) {
		activeStream = nextStream;
		emitState();
	}

	function beginTurn() {
		isSending = true;
		phase = "preparing";
		emitState();
	}

	function completeTurn() {
		isSending = false;
		phase = "idle";
		activePlaceholderId = null;
		setActiveStream(null);
		activeTokenBuffer = null;
		activeThinkingBuffer = null;
	}

	function setPhase(
		nextPhase: NormalChatRuntimePhase,
		placeholderId = activePlaceholderId,
	) {
		const changed = phase !== nextPhase;
		phase = nextPhase;
		if (placeholderId && nextPhase !== "idle") {
			adapters.applyMessageListEvent({
				type: "setRuntimePhase",
				placeholderId,
				phase: nextPhase,
			});
		}
		if (changed) {
			emitState();
		}
	}

	function canStopActiveStream() {
		return (
			Boolean(activeStream) && (phase === "preparing" || phase === "generating")
		);
	}

	function createAssistantPlaceholder(
		id: string,
		generationDurationMs?: number,
	): ChatMessage {
		return {
			id,
			renderKey: id,
			role: "assistant",
			content: "",
			timestamp: Date.now(),
			isStreaming: true,
			runtimePhase: "preparing",
			...(generationDurationMs !== undefined ? { generationDurationMs } : {}),
		};
	}

	function createUserMessage(params: {
		id: string;
		text: string;
		attachmentIds: string[];
		attachedArtifacts: ArtifactSummary[];
	}): ChatMessage {
		return {
			id: params.id,
			renderKey: params.id,
			role: "user",
			content: params.text,
			attachments: params.attachedArtifacts
				.filter((artifact) => params.attachmentIds.includes(artifact.id))
				.map((artifact) => ({
					id: artifact.id,
					artifactId: artifact.id,
					name: artifact.name,
					type: artifact.type,
					mimeType: artifact.mimeType,
					sizeBytes: artifact.sizeBytes,
					conversationId: artifact.conversationId,
					messageId: null,
					createdAt: artifact.createdAt,
				})),
			timestamp: Date.now(),
		};
	}

	function applyMetadata(metadata?: StreamMetadata) {
		adapters.applyStreamMetadata(metadata);
		if (metadata?.generatedFiles) {
			adapters.mergeGeneratedFiles?.(metadata.generatedFiles);
		}
		if (metadata?.fileProductionJobs) {
			adapters.mergeFileProductionJobs?.(metadata.fileProductionJobs);
		}
		if (metadata?.contextCompressionSnapshots) {
			adapters.setContextCompressionMarkers?.(
				metadata.contextCompressionSnapshots,
			);
		}
		const serverAssistantId = metadata?.assistantMessageId;
		if (serverAssistantId) {
			adapters.attachFileProductionJobsToAssistantMessage(serverAssistantId);
			adapters.refreshPendingWrites?.();
		}
		return serverAssistantId ?? null;
	}

	function isReceiptOnlyCompletionMetadata(metadata?: StreamMetadata): boolean {
		if (!metadata?.assistantMessageId) return false;
		const projectionFields = [
			metadata.contextStatus,
			metadata.contextSources,
			metadata.activeWorkingSet,
			metadata.taskState,
			metadata.contextDebug,
			metadata.messageEvidence,
			metadata.generatedFiles,
			metadata.fileProductionJobs,
			metadata.contextCompressionSnapshots,
			metadata.totalCostUsdMicros,
			metadata.totalTokens,
		];
		return projectionFields.every((field) => field === undefined);
	}

	function takeQueuedContextCompression() {
		if (!queuedContextCompression) return false;
		queuedContextCompression = false;
		emitState();
		return true;
	}

	async function drainPostTurnQueue() {
		if (takeQueuedContextCompression()) {
			await adapters.runManualContextCompression();
		}

		if (queuedTurn) {
			const nextQueuedTurn = cloneSendPayload(queuedTurn);
			queuedTurn = null;
			emitState();
			// Issue 7.4 — this dispatches a message that was queued (via
			// `handleQueue`/`normalChatRuntime.queue()`) while a previous turn
			// was still streaming, using this runtime's own internal `send()`.
			// It intentionally bypasses the page's Option-C cloud-warning gate
			// (`+page.svelte`'s `ensureCloudWarningAcked`) — this runtime is a
			// plain client module with no access to that page-level UI state,
			// and routing a mid-stream queue-drain through a blocking modal
			// would be confusing UX (the warning appearing disconnected from
			// any direct user action). Known, deliberate scope boundary — see
			// the matching comment at the `handleQueue` call site in
			// +page.svelte.
			void send(nextQueuedTurn, {
				skipUserMessage: false,
				skipPersistUserMessage: false,
				clearDraft: false,
			});
		}
	}

	function restoreQueuedTurnToDraft() {
		if (!queuedTurn) return;
		const nextQueuedTurn = cloneSendPayload(queuedTurn);
		queuedTurn = null;
		emitState();
		adapters.restorePayloadToDraft(nextQueuedTurn);
	}

	function buildCallbacks(params: StartStreamParams): StreamCallbacks {
		// R1 (ADR-0060, defect 2) — the buffer's flush fires from several
		// places (onFinishPart, onEnd, onError all call `.flush()`
		// unconditionally before doing anything else, so buffered text is
		// never lost on a stream transition). The conversation guard belongs
		// on the *delivery* callback itself rather than at each `.flush()`
		// call site — otherwise a flush triggered from one of those
		// unconditional call sites would still deliver a stale turn's
		// buffered text to the current conversation.
		const tokenBuffer = new TokenDisplayBuffer((text) => {
			if (!isTurnConversationActive(params.turnConversationId)) return;
			adapters.applyMessageListEvent({
				type: "appendToken",
				placeholderId: params.placeholderId,
				chunk: text,
			});
		});
		const thinkingBuffer = new TokenDisplayBuffer((text) => {
			if (!isTurnConversationActive(params.turnConversationId)) return;
			adapters.applyMessageListEvent({
				type: "appendThinking",
				placeholderId: params.placeholderId,
				chunk: text,
			});
		});

		activeTokenBuffer = tokenBuffer;
		activeThinkingBuffer = thinkingBuffer;

		// R1 (ADR-0060, defect 1) — tracks whether this specific stream
		// attempt has delivered any visible content yet. Gates the
		// network-drop recovery branch in onError below: a drop before any
		// content exists (e.g. an immediate connection failure) has nothing
		// to preserve and falls through to the existing error surface; a
		// drop after content exists is the case defect 1 names ("after N
		// visible tokens").
		let hasStreamedContent = false;

		return {
			onToken(chunk) {
				hasStreamedContent = true;
				if (!isTurnConversationActive(params.turnConversationId)) return;
				setPhase("generating", params.placeholderId);
				tokenBuffer.append(chunk);
			},
			onThinking(chunk) {
				hasStreamedContent = true;
				if (!isTurnConversationActive(params.turnConversationId)) return;
				setPhase("generating", params.placeholderId);
				thinkingBuffer.append(chunk);
			},
			onToolCall(name, input, status, details) {
				if (!isTurnConversationActive(params.turnConversationId)) return;
				setPhase("generating", params.placeholderId);
				adapters.applyMessageListEvent({
					type: "applyToolCall",
					placeholderId: params.placeholderId,
					name,
					input,
					status,
					details,
				});
				if (
					adapters.shouldHydrateFileProductionJobsOnToolCall?.(name, status)
				) {
					adapters.hydrateConversationDetail();
				}
			},
			onResponseActivity(entry) {
				if (!isTurnConversationActive(params.turnConversationId)) return;
				setPhase("generating", params.placeholderId);
				adapters.applyMessageListEvent({
					type: "applyResponseActivity",
					placeholderId: params.placeholderId,
					entry,
				});
			},
			onFinishPart() {
				if (isPollingForCompletion) {
					return;
				}
				tokenBuffer.flush();
				thinkingBuffer.flush();
				if (!isTurnConversationActive(params.turnConversationId)) return;
				setPhase("finalizing", params.placeholderId);
			},
			onTiming(timing) {
				adapters.onStreamTiming?.(timing);
			},
			onWaiting() {
				activeStream?.detach();
				isPollingForCompletion = true;
				phase = "polling";
				if (isTurnConversationActive(params.turnConversationId)) {
					adapters.applyMessageListEvent({
						type: "setRuntimePhase",
						placeholderId: params.placeholderId,
						phase: "polling",
					});
				}
				setActiveStream(null);
				if (isTurnConversationActive(params.turnConversationId)) {
					adapters.pollForCompletion(
						params.placeholderId,
						params.clientUserMessageId,
					);
				}
			},
			onEnd(fullText, metadata) {
				tokenBuffer.flush();
				thinkingBuffer.flush();

				if (isPollingForCompletion) {
					return;
				}

				lastAssistantResponse = fullText;
				canRetry = false;
				completeTurn();

				if (!isTurnConversationActive(params.turnConversationId)) {
					return;
				}

				const shouldHydrateEventualMetadata =
					isReceiptOnlyCompletionMetadata(metadata);
				const serverAssistantId = applyMetadata(metadata);
				adapters.applyMessageListEvent({
					type: "finalize",
					placeholderId: params.placeholderId,
					clientUserMessageId: params.clientUserMessageId,
					metadata,
				});
				if (serverAssistantId) {
					adapters.pollMessageEvidence(serverAssistantId);
					if (shouldHydrateEventualMetadata) {
						adapters.refreshMessageCost(serverAssistantId);
						adapters.hydrateConversationDetail();
					}
				}

				adapters.maybeTriggerTitleGeneration(
					params.completedUserMessage,
					fullText,
				);

				if (metadata?.wasStopped) {
					if (takeQueuedContextCompression()) {
						void adapters.runManualContextCompression();
					}
					restoreQueuedTurnToDraft();
					return;
				}

				void drainPostTurnQueue();
			},
			onError(error) {
				tokenBuffer.flush();
				thinkingBuffer.flush();

				const err = error instanceof Error ? error : new Error(String(error));
				const isBackgroundAbort =
					err.name === "AbortError" && adapters.isBrowserHidden();

				// R1 (ADR-0060, defect 2) — the conversation this turn belongs to
				// may no longer be the one the page is displaying (the user
				// navigated `/chat/A` -> `/chat/B` while A was still streaming).
				// No further write from an abandoned turn may reach page state —
				// attempting an error surface, a retry, or a reconnect for a
				// conversation nobody is looking at is itself a cross-write. Drop
				// the turn here; the page's own reset effect independently
				// detaches the transport on the same switch (belt and
				// suspenders — this guard holds even if that has not run yet, or
				// a callback was already in flight before it did).
				if (!isTurnConversationActive(params.turnConversationId)) {
					completeTurn();
					return;
				}

				if (!isBackgroundAbort && params.isReconnect && isCapacityError(err)) {
					const retryCount = params.reconnectRetryCount ?? 0;
					if (retryCount < 3 && params.reconnectStreamId) {
						const delay = 2 ** retryCount * 500;
						const reconnectStreamId = params.reconnectStreamId;
						completeTurn();
						adapters.applyMessageListEvent({
							type: "remove",
							messageId: params.placeholderId,
						});
						adapters.schedule(() => {
							void reconnectToOrphanedStream(
								reconnectStreamId,
								params.message,
								retryCount + 1,
								params.streamOptions.reasoningDepth,
								undefined,
								params.turnConversationId,
							);
						}, delay);
						return;
					}
				}

				// D2 (drain + graceful deploy): a *fresh* send (not a reconnect)
				// can also hit a capacity/global_limit rejection — most commonly
				// because the server is draining ahead of a deploy restart.
				// Degrade the same way the reconnect path already does: back off
				// and retry the same stream a bounded number of times instead of
				// surfacing a hard error on the first rejection. The assistant
				// placeholder is left in place (still "preparing") for the
				// duration of the backoff so this reads as "still working on
				// it", not a failure the user has to notice and manually retry.
				if (!isBackgroundAbort && !params.isReconnect && isCapacityError(err)) {
					const retryCount = params.capacityRetryCount ?? 0;
					if (retryCount < 3) {
						const delay = 2 ** retryCount * 500;
						adapters.schedule(() => {
							startStream({ ...params, capacityRetryCount: retryCount + 1 });
						}, delay);
						return;
					}
				}

				const isPendingSkillError = Boolean(
					params.payload && adapters.isPendingSkillUnavailableError(err),
				);
				const isForkedHistoryError = Boolean(
					params.streamOptions.retryAssistantMessageId &&
						!params.streamOptions.confirmForkedSourceHistoryMutation &&
						adapters.isForkedSourceHistoryConfirmationRequired(err),
				);

				// R1 (ADR-0060, defect 1) — a mid-stream network drop (as opposed
				// to a capacity rejection, which is always an admission-time
				// refusal before any content exists) must not simply delete the
				// partial answer. Once at least one visible token or thinking
				// chunk has streamed, the runtime owns that message's lifetime
				// and chooses to preserve it: extend the same bounded
				// reconnect/backoff idiom used above for capacity errors,
				// discovering the server's own orphaned stream (generation
				// continues server-side independent of this dropped client
				// connection — the same mechanism that already recovers a
				// backgrounded tab) instead of deleting the message and
				// requiring the user to notice and manually hit Retry, which
				// would regenerate an entirely different answer from scratch.
				if (
					!isBackgroundAbort &&
					!params.isReconnect &&
					hasStreamedContent &&
					!isCapacityError(err) &&
					!isPendingSkillError &&
					!isForkedHistoryError
				) {
					const retryCount = params.networkRetryCount ?? 0;
					if (retryCount < 3) {
						const delay = 2 ** retryCount * 500;
						completeTurn();
						adapters.schedule(() => {
							void recoverNetworkDroppedStream(params, err, retryCount + 1);
						}, delay);
						return;
					}
				}

				adapters.applyMessageListEvent({
					type: "remove",
					messageId: params.placeholderId,
				});
				completeTurn();

				if (isBackgroundAbort) {
					if (!params.isReconnect) {
						restoreQueuedTurnToDraft();
					}
					streamInterruptedByBackground = true;
					adapters.onBackgroundInterrupted();
					emitState();
					return;
				}

				if (!params.isReconnect) {
					if (takeQueuedContextCompression()) {
						void adapters.runManualContextCompression();
					}
					restoreQueuedTurnToDraft();
				}

				if (isPendingSkillError && params.payload) {
					if (params.clientUserMessageId) {
						adapters.applyMessageListEvent({
							type: "remove",
							messageId: params.clientUserMessageId,
						});
					}
					adapters.restorePayloadToDraft(
						adapters.markPendingSkillUnavailable(params.payload),
					);
					adapters.setSendError("pendingSkill.recoveryError");
					canRetry = false;
					emitState();
					return;
				}

				if (isForkedHistoryError) {
					const confirmationCallback =
						params.onForkedSourceHistoryConfirmationRequired ??
						adapters.onForkedSourceHistoryConfirmationRequired;
					if (confirmationCallback) {
						confirmationCallback();
					} else {
						adapters.setSendError("fork.regenerateWarning");
						canRetry = true;
						emitState();
					}
					return;
				}

				if (params.isReconnect) {
					adapters.loadPersistedData();
					return;
				}

				adapters.setSendError(adapters.toFriendlySendError(err));
				canRetry = true;
				emitState();
			},
		};
	}

	function startStream(params: StartStreamParams) {
		// R1 (ADR-0060, defect 2) — covers the one gap page-level detach can
		// never close: a *scheduled* retry (capacity or network-drop backoff)
		// firing after the user has already navigated to a different
		// conversation. Without this, a bounded retry would blindly dispatch
		// `adapters.streamChat` against whatever conversation is current *at
		// retry time*, cross-posting the original turn's message into it.
		if (!isTurnConversationActive(params.turnConversationId)) {
			completeTurn();
			return;
		}
		const callbacks = buildCallbacks(params);
		activePlaceholderId = params.placeholderId;
		setActiveStream(
			adapters.streamChat(
				params.message,
				adapters.getConversationId(),
				callbacks,
				params.streamOptions,
			),
		);
	}

	// R1 (ADR-0060, defect 1) — bounded recovery attempt for a fresh send's
	// mid-stream network drop. Mirrors the capacity-backoff idiom above
	// (`adapters.schedule`, exponential delay, 3 attempts) but recovers via
	// the orphaned-stream mechanism instead of a brand-new request, since
	// content has already streamed and a brand-new request would generate an
	// unrelated answer that gets appended after the preserved partial text.
	async function recoverNetworkDroppedStream(
		params: StartStreamParams,
		originalError: Error,
		retryCount: number,
	) {
		if (!isTurnConversationActive(params.turnConversationId)) {
			return;
		}

		const streamId = await adapters.checkForOrphanedStream(
			params.turnConversationId,
		);

		if (!streamId) {
			if (retryCount < 3) {
				adapters.schedule(
					() => {
						void recoverNetworkDroppedStream(
							params,
							originalError,
							retryCount + 1,
						);
					},
					2 ** retryCount * 500,
				);
				return;
			}
			if (!isTurnConversationActive(params.turnConversationId)) {
				return;
			}
			adapters.applyMessageListEvent({
				type: "remove",
				messageId: params.placeholderId,
			});
			completeTurn();
			adapters.setSendError(adapters.toFriendlySendError(originalError));
			canRetry = true;
			emitState();
			return;
		}

		const bufferInfo = await adapters.getStreamBufferInfo(
			streamId,
			params.turnConversationId,
		);

		if (!isTurnConversationActive(params.turnConversationId)) {
			return;
		}

		// The reconnect below replays the server's own buffered generation
		// into a fresh placeholder, so the dropped one is superseded rather
		// than lost — there is no window where the answer is simply gone; at
		// worst it swaps out for the replayed (equal or more complete) text.
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		await reconnectToOrphanedStream(
			streamId,
			bufferInfo?.userMessage ?? params.message,
			0,
			bufferInfo?.reasoningDepth ?? params.streamOptions.reasoningDepth,
			bufferInfo?.createdAt ? Date.now() - bufferInfo.createdAt : undefined,
			params.turnConversationId,
		);
	}

	async function startAtlasTurn(params: {
		payload: NormalChatSendPayload;
		placeholderId: string;
		clientUserMessageId: string | null;
		completedUserMessage: string;
		turnConversationId: string;
	}) {
		const clientAtlasTurnId =
			params.payload.clientAtlasTurnId?.trim() || adapters.randomId();
		try {
			const result = await adapters.submitAtlasTurn({
				conversationId:
					params.payload.conversationId ?? params.turnConversationId,
				message: params.payload.message,
				attachmentIds: params.payload.attachmentIds ?? [],
				linkedSources: params.payload.linkedSources ?? [],
				profile: params.payload.atlasProfile ?? "overview",
				action: params.payload.atlasAction ?? "create",
				parentAtlasJobId: params.payload.parentAtlasJobId ?? null,
				clientAtlasTurnId,
			});

			if (!isTurnConversationActive(params.turnConversationId)) {
				completeTurn();
				return;
			}

			lastAssistantResponse = result.message;
			if (result.message) {
				adapters.applyMessageListEvent({
					type: "appendToken",
					placeholderId: params.placeholderId,
					chunk: result.message,
				});
			}
			adapters.applyMessageListEvent({
				type: "finalize",
				placeholderId: params.placeholderId,
				clientUserMessageId: params.clientUserMessageId,
				metadata: {
					assistantMessageId:
						result.atlasJob.assistantMessageId ?? params.placeholderId,
				},
			});
			canRetry = false;
			completeTurn();
			adapters.hydrateConversationDetail();
			adapters.maybeTriggerTitleGeneration(
				params.completedUserMessage,
				result.message,
			);
			void drainPostTurnQueue();
		} catch (error) {
			if (!isTurnConversationActive(params.turnConversationId)) {
				completeTurn();
				return;
			}
			adapters.applyMessageListEvent({
				type: "remove",
				messageId: params.placeholderId,
			});
			if (params.clientUserMessageId) {
				adapters.applyMessageListEvent({
					type: "remove",
					messageId: params.clientUserMessageId,
				});
			}
			completeTurn();
			adapters.restorePayloadToDraft(params.payload);
			adapters.setSendError(
				adapters.toFriendlySendError(
					error instanceof Error ? error : new Error(String(error)),
				),
			);
			canRetry = false;
			emitState();
		}
	}

	async function send(
		payload: NormalChatSendPayload,
		options: SendRuntimeOptions = {},
	) {
		const text = payload.message;
		if (
			!text.trim() ||
			adapters.isReadOnly() ||
			isSending ||
			adapters.isEditResendPending()
		) {
			return;
		}

		// R1 (ADR-0060, defect 2) — the conversation this turn belongs to,
		// captured once, up front. See `StartStreamParams.turnConversationId`.
		const turnConversationId = adapters.getConversationId();

		const modelIdForTurn = payload.modelId ?? adapters.getSelectedModel();
		const reasoningDepthForTurn =
			payload.reasoningDepth ?? adapters.getReasoningDepth();
		adapters.setConversationModelSelection(modelIdForTurn);
		const personalityProfileIdForTurn =
			payload.personalityProfileId !== undefined
				? payload.personalityProfileId
				: adapters.getPersonalityProfileId();

		if (payload.pendingSkill) {
			beginTurn();
			const result = await adapters.startPendingSkillSession(payload);
			if (!result.ok) {
				if (result.restoredPayload) {
					adapters.restorePayloadToDraft(result.restoredPayload);
				}
				adapters.setSkillSessionError(result.errorMessage);
				adapters.setSendError(result.errorMessage);
				canRetry = false;
				completeTurn();
				return;
			}
		}

		adapters.setSendError(null);
		beginTurn();
		adapters.setSuppressHydration?.(true);
		adapters.setInitialStreamPending?.(false);
		lastUserMessage = text;
		lastReasoningDepth = reasoningDepthForTurn;
		canRetry = true;
		adapters.markHasPersistedMessages?.();
		emitState();

		if (options.clearDraft ?? true) {
			adapters.clearDraft();
			adapters.deleteDraft?.();
		}

		const currentAttachedArtifacts = adapters.clearAttachedArtifacts();
		const sentAttachments = mergeAttachedArtifacts(
			currentAttachedArtifacts,
			payload.attachments ?? [],
		);
		adapters.recordConversationActivity();

		let clientUserMessageId: string | null = null;
		if (!options.skipUserMessage) {
			clientUserMessageId = adapters.randomId();
			adapters.applyMessageListEvent({
				type: "appendUser",
				message: createUserMessage({
					id: clientUserMessageId,
					text,
					attachmentIds: payload.attachmentIds ?? [],
					attachedArtifacts: sentAttachments,
				}),
			});
		}

		const placeholderId = adapters.randomId();
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(placeholderId),
		});

		if (payload.atlasMode === true) {
			await startAtlasTurn({
				payload,
				placeholderId,
				clientUserMessageId,
				completedUserMessage: text,
				turnConversationId,
			});
			return;
		}

		startStream({
			message: text,
			placeholderId,
			clientUserMessageId,
			payload,
			completedUserMessage: text,
			turnConversationId,
			onForkedSourceHistoryConfirmationRequired:
				options.onForkedSourceHistoryConfirmationRequired,
			streamOptions: {
				modelId: modelIdForTurn,
				skipPersistUserMessage: options.skipPersistUserMessage ?? false,
				attachmentIds: payload.attachmentIds ?? [],
				linkedSources: payload.linkedSources ?? [],
				pendingSkill: payload.pendingSkill ?? null,
				reasoningDepth: reasoningDepthForTurn,
				forceWebSearch: payload.forceWebSearch === true,
				enabledConnectionCapabilities: payload.enabledConnectionCapabilities,
				activeDocumentArtifactId: adapters.getActiveDocumentArtifactId(),
				personalityProfileId: personalityProfileIdForTurn,
				retryAssistantMessageId: options.retryAssistantMessageId,
				retryUserMessageId: options.retryUserMessageId,
				retryUserMessage: options.retryAssistantMessageId ? text : undefined,
				confirmForkedSourceHistoryMutation:
					options.confirmForkedSourceHistoryMutation,
			},
		});
	}

	function retry() {
		if (adapters.isReadOnly() || !canRetry || !lastUserMessage) {
			return;
		}
		adapters.setSendError(null);
		beginTurn();
		adapters.markHasPersistedMessages?.();

		const turnConversationId = adapters.getConversationId();

		const retryMessages = adapters.getMessages();
		const lastAssistantMsg = retryMessages.findLast(
			(message) => message.role === "assistant",
		);
		const retryAssistantMessageId = lastAssistantMsg?.id;
		const retryAssistantIndex = retryAssistantMessageId
			? retryMessages.findIndex(
					(message) => message.id === retryAssistantMessageId,
				)
			: -1;
		const retryUserMessageId =
			retryAssistantIndex > 0 &&
			retryMessages[retryAssistantIndex - 1]?.role === "user"
				? retryMessages[retryAssistantIndex - 1].id
				: undefined;
		const placeholderId = adapters.randomId();
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(placeholderId),
		});
		if (retryAssistantMessageId) {
			adapters.applyMessageListEvent({
				type: "remove",
				messageId: retryAssistantMessageId,
			});
		}

		startStream({
			message: lastUserMessage,
			placeholderId,
			clientUserMessageId: null,
			completedUserMessage: lastUserMessage,
			turnConversationId,
			streamOptions: {
				modelId: lastAssistantMsg?.modelId ?? adapters.getSelectedModel(),
				reasoningDepth: lastReasoningDepth,
				activeDocumentArtifactId: adapters.getActiveDocumentArtifactId(),
				personalityProfileId: adapters.getPersonalityProfileId(),
				retryAssistantMessageId: retryAssistantMessageId ?? undefined,
				retryUserMessageId,
				retryUserMessage: retryAssistantMessageId ? lastUserMessage : undefined,
			},
		});
	}

	function queue(payload: NormalChatSendPayload) {
		if (
			adapters.isReadOnly() ||
			!isSending ||
			queuedTurn ||
			!payload.message.trim()
		) {
			return;
		}
		queuedTurn = cloneSendPayload(payload);
		adapters.clearDraft();
		adapters.setSendError(null);
		emitState();
	}

	function clearQueuedTurn() {
		queuedTurn = null;
		adapters.setSendError(null);
		emitState();
	}

	function editQueuedTurn() {
		restoreQueuedTurnToDraft();
		adapters.setSendError(null);
	}

	function compact() {
		if (adapters.isReadOnly()) return;
		if (isSending || adapters.isEditResendPending()) {
			queuedContextCompression = true;
			adapters.setSendError(null);
			emitState();
			return;
		}
		void adapters.runManualContextCompression();
	}

	function stop() {
		if (!canStopActiveStream()) return false;
		activeTokenBuffer?.flush();
		activeThinkingBuffer?.flush();
		activeStream?.stop();
		return true;
	}

	function detach() {
		activeTokenBuffer?.flush();
		activeThinkingBuffer?.flush();
		activeTokenBuffer = null;
		activeThinkingBuffer = null;
		activeStream?.detach();
		activeStream = null;
		phase = "idle";
		activePlaceholderId = null;
		emitState();
	}

	function reset() {
		detach();
		isSending = false;
		isPollingForCompletion = false;
		streamInterruptedByBackground = false;
		canRetry = false;
		queuedTurn = null;
		queuedContextCompression = false;
		phase = "idle";
		activePlaceholderId = null;
		lastUserMessage = "";
		lastAssistantResponse = "";
		lastReasoningDepth = "auto";
		emitState();
	}

	function handleVisibilityVisible() {
		if (!streamInterruptedByBackground) return;
		streamInterruptedByBackground = false;
		emitState();
		adapters.onBackgroundVisibilityRestore?.();
		return recoverBackgroundInterruptedStream();
	}

	async function reconnectToOrphanedStream(
		streamId: string,
		userMessage = "",
		retryCount = 0,
		reasoningDepth?: ReasoningDepth,
		replayElapsedMs?: number,
		turnConversationId: string = adapters.getConversationId(),
	) {
		if (isSending || activeStream) return false;
		if (!isTurnConversationActive(turnConversationId)) return false;

		beginTurn();
		adapters.markHasPersistedMessages?.();
		const placeholderId = adapters.randomId();
		let clientUserMessageId = findExistingReconnectUserMessageId(userMessage);
		if (!clientUserMessageId && userMessage.trim()) {
			clientUserMessageId = adapters.randomId();
			adapters.applyMessageListEvent({
				type: "appendUser",
				message: createUserMessage({
					id: clientUserMessageId,
					text: userMessage,
					attachmentIds: [],
					attachedArtifacts: [],
				}),
			});
		}
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(placeholderId, replayElapsedMs),
		});

		startStream({
			message: userMessage || "",
			placeholderId,
			clientUserMessageId,
			completedUserMessage: userMessage,
			turnConversationId,
			isReconnect: true,
			reconnectStreamId: streamId,
			reconnectRetryCount: retryCount,
			streamOptions: {
				reconnectToStreamId: streamId,
				reconnectUserMessage: userMessage,
				reasoningDepth: reasoningDepth ?? adapters.getReasoningDepth(),
			},
		});
		return true;
	}

	function findExistingReconnectUserMessageId(userMessage: string) {
		if (!userMessage.trim()) return null;
		const existingUserMessage = adapters
			.getMessages()
			.findLast(
				(message) => message.role === "user" && message.content === userMessage,
			);
		return existingUserMessage?.id ?? null;
	}

	async function checkForOrphanedStreamOnMount() {
		if (isSending || activeStream) {
			return false;
		}
		const streamId = await adapters.checkForOrphanedStream(
			adapters.getConversationId(),
		);
		if (!streamId) return false;
		const bufferInfo = await adapters.getStreamBufferInfo(
			streamId,
			adapters.getConversationId(),
		);
		return reconnectToOrphanedStream(
			streamId,
			bufferInfo?.userMessage ?? "",
			0,
			bufferInfo?.reasoningDepth,
			bufferInfo?.createdAt ? Date.now() - bufferInfo.createdAt : undefined,
		);
	}

	async function recoverBackgroundInterruptedStream() {
		const reconnected = await checkForOrphanedStreamOnMount();
		if (!reconnected) {
			await adapters.loadPersistedData();
			await drainPostTurnQueue();
		}
	}

	return {
		snapshot,
		send,
		retry,
		queue,
		clearQueuedTurn,
		editQueuedTurn,
		compact,
		stop,
		detach,
		reset,
		completePollingRecovery() {
			isSending = false;
			isPollingForCompletion = false;
			canRetry = false;
			phase = "idle";
			activePlaceholderId = null;
			setActiveStream(null);
		},
		restoreQueuedTurnToDraft,
		drainPostTurnQueue,
		handleVisibilityVisible,
		reconnectToOrphanedStream,
		checkForOrphanedStreamOnMount,
	};
}

function cloneSendPayload(
	payload: NormalChatSendPayload,
): NormalChatSendPayload {
	return {
		message: payload.message,
		attachmentIds: [...(payload.attachmentIds ?? [])],
		attachments: [...(payload.attachments ?? [])],
		pendingAttachments: (payload.pendingAttachments ?? []).map(
			(attachment) => ({
				...attachment,
			}),
		),
		linkedSources: (payload.linkedSources ?? []).map((source) => ({
			...source,
			familyArtifactIds: [...source.familyArtifactIds],
		})),
		pendingSkill: payload.pendingSkill
			? {
					...payload.pendingSkill,
					baseSkillId: payload.pendingSkill.baseSkillId ?? null,
					baseSkillDisplayName:
						payload.pendingSkill.baseSkillDisplayName ?? null,
					unavailable: payload.pendingSkill.unavailable === true,
				}
			: null,
		conversationId: payload.conversationId ?? null,
		modelId: payload.modelId,
		personalityProfileId: payload.personalityProfileId ?? null,
		reasoningDepth: payload.reasoningDepth,
		forceWebSearch: payload.forceWebSearch === true,
		enabledConnectionCapabilities: payload.enabledConnectionCapabilities
			? [...payload.enabledConnectionCapabilities]
			: undefined,
		atlasMode: payload.atlasMode === true,
		atlasProfile: payload.atlasProfile ?? null,
		atlasAction: payload.atlasAction ?? "create",
		parentAtlasJobId: payload.parentAtlasJobId ?? null,
		clientAtlasTurnId: payload.clientAtlasTurnId ?? null,
	};
}

function mergeAttachedArtifacts(
	currentArtifacts: ArtifactSummary[],
	nextArtifacts: ArtifactSummary[],
): ArtifactSummary[] {
	if (nextArtifacts.length === 0) return currentArtifacts;
	const mergedArtifacts = new Map(
		currentArtifacts.map((artifact) => [artifact.id, artifact]),
	);
	for (const artifact of nextArtifacts) {
		mergedArtifacts.set(artifact.id, artifact);
	}
	return Array.from(mergedArtifacts.values());
}

function isCapacityError(error: Error & { code?: unknown }) {
	return (
		error.message?.toLowerCase().includes("capacity") ||
		error.code === "CAPACITY_EXCEEDED" ||
		error.code === "capacity_exceeded"
	);
}
