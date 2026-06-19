import {
	checkForOrphanedStream,
	getStreamBufferInfo,
	type StreamCallbacks,
	type StreamChatOptions,
	type StreamHandle,
	type StreamMetadata,
	streamChat,
} from "$lib/services/streaming";
import type {
	ArtifactSummary,
	ChatMessage,
	LinkedContextSource,
	ModelId,
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
};

export type NormalChatRuntimeSnapshot = {
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

export type NormalChatClientTurnRuntimeAdapters = {
	streamChat: typeof streamChat;
	checkForOrphanedStream: typeof checkForOrphanedStream;
	getStreamBufferInfo: typeof getStreamBufferInfo;
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
	appendUserMessage: (message: ChatMessage) => void;
	appendAssistantPlaceholder: (placeholder: ChatMessage) => void;
	appendTokenChunk: (placeholderId: string, chunk: string) => void;
	appendThinkingChunk: (placeholderId: string, chunk: string) => void;
	applyToolCallUpdate: (
		placeholderId: string,
		name: string,
		input: Record<string, unknown>,
		status: "running" | "done",
		details?: StreamToolCallDetails,
	) => void;
	applyResponseActivityUpdate?: (
		placeholderId: string,
		entry: ResponseActivityEntry,
	) => void;
	shouldHydrateFileProductionJobsOnToolCall?: (
		name: string,
		status: "running" | "done",
	) => boolean;
	removeMessage: (messageId: string) => void;
	finalizeStreamingMessage: (params: {
		placeholderId: string;
		clientUserMessageId: string | null;
		metadata?: StreamMetadata;
	}) => void;
	applyStreamMetadata: (metadata?: StreamMetadata) => void;
	attachFileProductionJobsToAssistantMessage: (
		assistantMessageId: string,
	) => void;
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
	isReconnect?: boolean;
	reconnectStreamId?: string;
	reconnectRetryCount?: number;
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
	});
}

export function createNormalChatClientTurnRuntime(
	adapters: NormalChatClientTurnRuntimeAdapters,
) {
	let activeStream: StreamHandle | null = null;
	let activeTokenBuffer: TokenDisplayBuffer | null = null;
	let activeThinkingBuffer: TokenDisplayBuffer | null = null;
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

	function setActiveStream(nextStream: StreamHandle | null) {
		activeStream = nextStream;
		emitState();
	}

	function beginTurn() {
		isSending = true;
		emitState();
	}

	function completeTurn() {
		isSending = false;
		setActiveStream(null);
		activeTokenBuffer = null;
		activeThinkingBuffer = null;
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
		}
		return serverAssistantId ?? null;
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
		const tokenBuffer = new TokenDisplayBuffer((text) => {
			adapters.appendTokenChunk(params.placeholderId, text);
		});
		const thinkingBuffer = new TokenDisplayBuffer((text) => {
			adapters.appendThinkingChunk(params.placeholderId, text);
		});

		activeTokenBuffer = tokenBuffer;
		activeThinkingBuffer = thinkingBuffer;

		return {
			onToken(chunk) {
				tokenBuffer.append(chunk);
			},
			onThinking(chunk) {
				thinkingBuffer.append(chunk);
			},
			onToolCall(name, input, status, details) {
				adapters.applyToolCallUpdate(
					params.placeholderId,
					name,
					input,
					status,
					details,
				);
				if (
					adapters.shouldHydrateFileProductionJobsOnToolCall?.(name, status)
				) {
					adapters.hydrateConversationDetail();
				}
			},
			onResponseActivity(entry) {
				adapters.applyResponseActivityUpdate?.(params.placeholderId, entry);
			},
			onWaiting() {
				activeStream?.detach();
				isPollingForCompletion = true;
				setActiveStream(null);
				adapters.pollForCompletion(
					params.placeholderId,
					params.clientUserMessageId,
				);
			},
			onEnd(fullText, metadata) {
				tokenBuffer.flush();
				thinkingBuffer.flush();

				if (isPollingForCompletion) {
					isPollingForCompletion = false;
					emitState();
					return;
				}

				lastAssistantResponse = fullText;
				const serverAssistantId = applyMetadata(metadata);
				adapters.finalizeStreamingMessage({
					placeholderId: params.placeholderId,
					clientUserMessageId: params.clientUserMessageId,
					metadata,
				});
				canRetry = false;
				completeTurn();
				if (serverAssistantId) {
					adapters.pollMessageEvidence(serverAssistantId);
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
				if (!isBackgroundAbort && params.isReconnect && isCapacityError(err)) {
					const retryCount = params.reconnectRetryCount ?? 0;
					if (retryCount < 3 && params.reconnectStreamId) {
						const delay = 2 ** retryCount * 500;
						const reconnectStreamId = params.reconnectStreamId;
						completeTurn();
						adapters.removeMessage(params.placeholderId);
						adapters.schedule(() => {
							void reconnectToOrphanedStream(
								reconnectStreamId,
								params.message,
								retryCount + 1,
								params.streamOptions.reasoningDepth,
							);
						}, delay);
						return;
					}
				}

				adapters.removeMessage(params.placeholderId);
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

				if (params.payload && adapters.isPendingSkillUnavailableError(err)) {
					if (params.clientUserMessageId) {
						adapters.removeMessage(params.clientUserMessageId);
					}
					adapters.restorePayloadToDraft(
						adapters.markPendingSkillUnavailable(params.payload),
					);
					adapters.setSendError("pendingSkill.recoveryError");
					canRetry = false;
					emitState();
					return;
				}

				if (
					params.streamOptions.retryAssistantMessageId &&
					!params.streamOptions.confirmForkedSourceHistoryMutation &&
					adapters.isForkedSourceHistoryConfirmationRequired(err)
				) {
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
		const callbacks = buildCallbacks(params);
		setActiveStream(
			adapters.streamChat(
				params.message,
				adapters.getConversationId(),
				callbacks,
				params.streamOptions,
			),
		);
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
			adapters.appendUserMessage(
				createUserMessage({
					id: clientUserMessageId,
					text,
					attachmentIds: payload.attachmentIds ?? [],
					attachedArtifacts: sentAttachments,
				}),
			);
		}

		const placeholderId = adapters.randomId();
		adapters.appendAssistantPlaceholder(
			createAssistantPlaceholder(placeholderId),
		);

		startStream({
			message: text,
			placeholderId,
			clientUserMessageId,
			payload,
			completedUserMessage: text,
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
		adapters.appendAssistantPlaceholder(
			createAssistantPlaceholder(placeholderId),
		);
		if (retryAssistantMessageId) {
			adapters.removeMessage(retryAssistantMessageId);
		}

		startStream({
			message: lastUserMessage,
			placeholderId,
			clientUserMessageId: null,
			completedUserMessage: lastUserMessage,
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
		activeTokenBuffer?.flush();
		activeThinkingBuffer?.flush();
		activeStream?.stop();
	}

	function detach() {
		activeTokenBuffer?.flush();
		activeThinkingBuffer?.flush();
		activeTokenBuffer = null;
		activeThinkingBuffer = null;
		activeStream?.detach();
		activeStream = null;
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
	) {
		if (isSending || activeStream) return false;

		beginTurn();
		adapters.markHasPersistedMessages?.();
		const placeholderId = adapters.randomId();
		let clientUserMessageId = findExistingReconnectUserMessageId(userMessage);
		if (!clientUserMessageId && userMessage.trim()) {
			clientUserMessageId = adapters.randomId();
			adapters.appendUserMessage(
				createUserMessage({
					id: clientUserMessageId,
					text: userMessage,
					attachmentIds: [],
					attachedArtifacts: [],
				}),
			);
		}
		adapters.appendAssistantPlaceholder(
			createAssistantPlaceholder(placeholderId, replayElapsedMs),
		);

		startStream({
			message: userMessage || "",
			placeholderId,
			clientUserMessageId,
			completedUserMessage: userMessage,
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
