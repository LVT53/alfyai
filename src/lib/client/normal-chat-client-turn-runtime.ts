import type { RetryOrigin } from "$lib/chat-turn-origin";
import { submitAtlasTurn } from "$lib/client/api/atlas";
import { PENDING_FILE_PRODUCTION_JOB_ID_PREFIX } from "$lib/components/chat/file-production-helpers";
import {
	buildMessageUserIntent,
	type MessageUserIntent,
} from "$lib/message-user-intent";
import type { ModelId } from "$lib/model-types";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import type { ResponseActivityEntry } from "$lib/response-activity-types";
import type {
	AtlasAction,
	AtlasProfile,
} from "$lib/server/services/atlas/public-types";
import type {
	ArtifactSummary,
	PendingAttachment,
} from "$lib/server/services/knowledge/types";
import type { LinkedContextSource } from "$lib/server/services/linked-context-sources";
import type {
	ChatMessage,
	NormalChatRuntimePhase,
} from "$lib/server/services/messages-types";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import {
	checkForOrphanedStream,
	getStreamBufferInfo,
	type StreamBufferInfo,
	type StreamCallbacks,
	type StreamChatOptions,
	type StreamHandle,
	type StreamMetadata,
	type StreamTimingSnapshot,
	streamChat,
} from "$lib/services/streaming";
import type {
	ImageMarksRequest,
	PictureRef,
	UserPicturesMetadata,
} from "$lib/shared/artifacts/image-body";
import {
	isFileProductionToolName,
	toolCallInputKey,
} from "$lib/utils/tool-calls";

type StreamToolCallDetails = Parameters<
	NonNullable<StreamCallbacks["onToolCall"]>
>[3];

export type NormalChatSendPayload = {
	message: string;
	attachmentIds: string[];
	attachments: ArtifactSummary[];
	pendingAttachments: PendingAttachment[];
	linkedSources?: LinkedContextSource[];
	// Card pictures attached to this message (Attach) under the numbers the
	// person saw, and the marks drawn on one picture. Sent in the stream body;
	// the server numbers them with the uploads and the open picture.
	pictureRefs?: PictureRef[];
	// The same pictures with their names, and the numbers the uploads went by
	// (the composer's numbering): the optimistic user message draws its numbered
	// thumbnails from it from the first paint (F13), and a queued turn put back
	// in the composer gets its chips and their names from it. The server's
	// record replaces it with the same numbers. CLIENT-ONLY: it is never sent on
	// the wire (`streamChat` builds the request body field by field and only
	// `pictureRefs` goes out); the server takes the numbers from `pictureRefs` and
	// the uploads, never from this.
	pictures?: UserPicturesMetadata;
	imageMarks?: ImageMarksRequest | null;
	// The item the marks were drawn on and whether the send added its picture as
	// a ref (plan 2b T6): a queued or failed turn put back in the composer gets
	// its marks chip back, and only the pictures the person attached as chips.
	// CLIENT-ONLY, like `pictures`: `streamChat` never sends it.
	markedPicture?: {
		artifactId: string;
		name: string;
		addedRef: boolean;
		version: number | null;
	};
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
	// Gap 2 — set by handleEdit's edit-and-resend flow (chat/[conversationId]/
	// +page.svelte) so the server can record an activity_events "edit_resend"
	// row at turn completion and drop a picture deleted since instead of
	// refusing it (preflight.ts). Never set by a plain composer send.
	isEditResend?: boolean;
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
			status: "running" | "done" | "failed";
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
	/**
	 * An edit of a message is open in the composer. Retry sends nothing then: the
	 * edit deletes what a turn makes, and the failed bubble the edit is of takes the
	 * server's id when the turn lands, so the edit's submit would find no message and
	 * close with what was typed.
	 */
	isEditOpen: () => boolean;
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
	applyMessageListEvent: (event: NormalChatMessageListEvent) => void;
	shouldHydrateFileProductionJobsOnToolCall?: (
		name: string,
		status: "running" | "done" | "failed",
	) => boolean;
	// Wave 2.5 review (F2): a second, separately-named hydrate gate for the
	// SAME onToolCall hook — a create_artifact/edit_artifact call's fresh
	// version/review state needs the identical conversation-detail refresh,
	// for a different reason than file-production/connection writes do. See
	// _helpers.ts's shouldHydrateArtifactsOnToolCall for the reasoning.
	shouldHydrateArtifactsOnToolCall?: (
		name: string,
		status: "running" | "done" | "failed",
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
	/**
	 * The chat's messages as the server holds them now, or null when they could not
	 * be read in time. A dropped connection never reads the chat, and the server
	 * keeps running the turn: it can save the message and its reply while the page
	 * shows an error and a Retry. The runtime asks before it believes a message
	 * failed (`askWhatTheServerHolds`).
	 */
	readChatMessages?: () => Promise<ChatMessage[] | null>;
	mergeGeneratedFiles?: (
		files: NonNullable<StreamMetadata["generatedFiles"]>,
	) => void;
	mergeFileProductionJobs?: (
		jobs: NonNullable<StreamMetadata["fileProductionJobs"]>,
	) => void;
	// Item 6 (UX-speed plan) — shows a "queued" FileProductionCard the
	// instant a produce_file tool call starts, instead of waiting for the
	// call to finish and the conversation to re-hydrate. addFileProduction-
	// JobPlaceholder adds the client-only stand-in (see
	// buildPendingFileProductionJobPlaceholder, ./chat/[conversationId]/
	// _helpers.ts); failFileProductionJobPlaceholder turns it into a failed
	// card if the tool call itself fails before any real job is merged in.
	// Both are optional so tests/hosts that don't care about this can omit
	// them (a no-op just means no placeholder appears — the existing
	// post-hoc hydration path still works).
	addFileProductionJobPlaceholder?: (params: {
		id: string;
		conversationId: string;
		input: Record<string, unknown>;
	}) => void;
	failFileProductionJobPlaceholder?: (params: {
		id: string;
		message?: string | null;
	}) => void;
	setContextCompressionMarkers?: (
		markers: NonNullable<StreamMetadata["contextCompressionSnapshots"]>,
	) => void;
	maybeTriggerTitleGeneration: () => void;
	runManualContextCompression: () => Promise<void> | void;
	restorePayloadToDraft: (payload: NormalChatSendPayload) => void;
	markPendingSkillUnavailable: (
		payload: NormalChatSendPayload,
	) => NormalChatSendPayload;
	isPendingSkillUnavailableError: (error: unknown) => boolean;
	isForkedSourceHistoryConfirmationRequired: (error: unknown) => boolean;
	toFriendlySendError: (error: Error) => string;
	setSendError: (message: string | null) => void;
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
	// The `userIntent` of the assistant message this regenerate replaces, so
	// its provenance chip does not blink off and back on: the caller has
	// already removed that message from the timeline by the time send() runs,
	// and the server re-reads the same record for the turn anyway (see
	// services/chat-turn/retry.ts). Optimistic only — the terminal frame's
	// record wins, including when the recorded skill no longer resolves and the
	// server regenerates without it.
	retryUserIntent?: MessageUserIntent;
	// Which regenerate this is when retryAssistantMessageId is set: the plain
	// Regenerate button (the default) or "Answer now". See
	// $lib/chat-turn-origin.ts. retry() below sends "error_retry" itself.
	retryOrigin?: Exclude<RetryOrigin, "error_retry">;
	confirmForkedSourceHistoryMutation?: boolean;
	onForkedSourceHistoryConfirmationRequired?: () => void;
};

type StartStreamParams = {
	message: string;
	placeholderId: string;
	clientUserMessageId: string | null;
	payload?: NormalChatSendPayload;
	streamOptions: StreamChatOptions;
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
 * The last send, as Retry needs it again. The server keeps nothing of a turn that
 * fails (it saves the reader's message with the reply, at the end), so after a
 * failure the page's list ends in a message the server does not have, and Retry
 * sends that message again with everything it was sent with: the files, the
 * pictures and their marks, the model and the rest.
 */
type RememberedSend = {
	payload: NormalChatSendPayload;
	options: SendRuntimeOptions;
	conversationId: string;
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
	let lastReasoningDepth: ReasoningDepth = "thorough";
	// What Retry sends again when the list ends in the message that failed. It goes
	// with the chat (`reset`), and a turn that was not a send of this page holds none.
	let lastSend: RememberedSend | null = null;
	// True while Retry reads the chat from the server: a second press is the same press.
	let retryReading = false;

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

	// R1 (ADR-0060, defect 2 amendment) — a stale-turn guard (this turn's
	// `turnConversationId` is no longer the one displayed) must not blindly
	// call completeTurn(): completeTurn() resets SHARED runtime state
	// (isSending/activeStream/activePlaceholderId/buffers), and a different,
	// currently-active turn may already own that shared state by the time
	// this stale branch runs — e.g. a raw `adapters.schedule` timer nothing
	// cancels, firing after the user navigated away and a genuinely new turn
	// already started. Only reset shared state when this turn (identified by
	// its own placeholderId) still actually owns it; otherwise this turn's
	// work is simply dropped, leaving the current turn's state untouched.
	function completeStaleTurn(placeholderId: string) {
		if (activePlaceholderId !== placeholderId) return;
		completeTurn();
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
		userIntent?: MessageUserIntent,
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
			...(userIntent ? { userIntent } : {}),
		};
	}

	// What the user chose for the turn being sent, stamped on the optimistic
	// assistant placeholder so its provenance line is right the moment the turn
	// lands — the composer's chips are gone by then. The server writes the same
	// record with the persisted message and repeats it on the terminal stream
	// frame, which wins when it arrives (its skill name is the resolved one).
	// An Atlas turn carries neither choice: the server drops both for
	// `atlasMode` (chat-turn/request.ts), and so does this.
	function userIntentForPayload(
		payload: NormalChatSendPayload,
	): MessageUserIntent | undefined {
		if (payload.atlasMode === true) return undefined;
		return buildMessageUserIntent({
			skill: payload.pendingSkill ?? null,
			forceWebSearch: payload.forceWebSearch === true,
		});
	}

	// What a turn asks of the model: the payload's own choice, else the page's
	// choice at the moment it goes. A send and a Retry of it ask the same way.
	function turnChoicesFor(payload: NormalChatSendPayload) {
		return {
			modelId: payload.modelId ?? adapters.getSelectedModel(),
			reasoningDepth: payload.reasoningDepth ?? adapters.getReasoningDepth(),
			personalityProfileId:
				payload.personalityProfileId !== undefined
					? payload.personalityProfileId
					: adapters.getPersonalityProfileId(),
		};
	}

	// The request a send makes of the stream (or, for a regenerate, of the retry
	// route). One place for a send and for the Retry that sends it again.
	function streamOptionsFor(
		payload: NormalChatSendPayload,
		options: SendRuntimeOptions,
		choices: ReturnType<typeof turnChoicesFor>,
	): StreamChatOptions {
		return {
			modelId: choices.modelId,
			skipPersistUserMessage: options.skipPersistUserMessage ?? false,
			attachmentIds: payload.attachmentIds ?? [],
			linkedSources: payload.linkedSources ?? [],
			pendingSkill: payload.pendingSkill ?? null,
			reasoningDepth: choices.reasoningDepth,
			forceWebSearch: payload.forceWebSearch === true,
			enabledConnectionCapabilities: payload.enabledConnectionCapabilities,
			activeDocumentArtifactId: adapters.getActiveDocumentArtifactId(),
			pictureRefs: payload.pictureRefs,
			imageMarks: payload.imageMarks ?? null,
			personalityProfileId: choices.personalityProfileId,
			retryAssistantMessageId: options.retryAssistantMessageId,
			retryUserMessageId: options.retryUserMessageId,
			retryUserMessage: options.retryAssistantMessageId
				? payload.message
				: undefined,
			confirmForkedSourceHistoryMutation:
				options.confirmForkedSourceHistoryMutation,
			isEditResend: payload.isEditResend === true,
			retryOrigin: options.retryAssistantMessageId
				? (options.retryOrigin ?? "regenerate")
				: undefined,
			// What the person chose for the turn (a skill, a forced web search): the
			// server reads it off the reply it replaces, and says it from here only
			// when that reply is already gone.
			retryUserIntent: options.retryAssistantMessageId
				? options.retryUserIntent
				: undefined,
		};
	}

	function createUserMessage(params: {
		id: string;
		text: string;
		attachmentIds: string[];
		attachedArtifacts: ArtifactSummary[];
		pictures?: UserPicturesMetadata;
	}): ChatMessage {
		return {
			id: params.id,
			renderKey: params.id,
			role: "user",
			content: params.text,
			...(params.pictures ? { pictures: params.pictures } : {}),
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
					// Long-document comfort fields ride along so the optimistic
					// bubble matches what the server projects on reload: the chip
					// row draws "24 pp · 18k tok" from them, and a quote chip picked
					// from the outline is recognised in the sent text ONLY against
					// this message's own outline headings (see
					// splitUserMessageQuotes). Without them the quote would render
					// as prose until the next refresh.
					...(artifact.tokenEstimate !== undefined
						? { tokenEstimate: artifact.tokenEstimate }
						: {}),
					...(artifact.pageCount !== undefined
						? { pageCount: artifact.pageCount }
						: {}),
					// Without the kind the optimistic bubble would print "N pp" for a
					// deck and the refresh would replace it with "N slides".
					...(artifact.pageCountKind !== undefined
						? { pageCountKind: artifact.pageCountKind }
						: {}),
					...(artifact.outline && artifact.outline.length > 0
						? { outline: artifact.outline }
						: {}),
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

	/**
	 * Asks the server what it holds of a message the page thinks failed. The page's
	 * list is read before the answer is waited for: it is what the answer is compared
	 * with. A read that fails or runs out says nothing (`unknown`), and the caller
	 * goes on as it always did: if the network is really gone the resend fails by
	 * itself.
	 *
	 * `replacedReplyId` is the reply a regenerate was replacing. The page took it off
	 * its list, so when the regenerate never reached the server (the network) the
	 * server still has it and it reads as a new reply: it is counted as held, and is
	 * never the reply that says a turn landed.
	 */
	async function askWhatTheServerHolds(
		text: string,
		replacedReplyId?: string,
	): Promise<ServerOutcome> {
		const read = adapters.readChatMessages;
		if (!read || !text.trim()) return { kind: "unknown" };
		const heldIds = new Set(
			adapters.getMessages().map((message) => message.id),
		);
		if (replacedReplyId) heldIds.add(replacedReplyId);
		let serverMessages: ChatMessage[] | null = null;
		try {
			serverMessages = await read();
		} catch {
			serverMessages = null;
		}
		return judgeServerMessages(serverMessages, text, heldIds);
	}

	/**
	 * Reads the chat back from the server (`loadPersistedData`) and holds the turn
	 * state while it does, the way polling recovery holds it. The load replaces the
	 * page's list, and its last step (`completePollingRecovery`) ends the turn state:
	 * a message sent while it is out would lose its bubble to the new list and its
	 * turn would lose `isSending` under the live stream. Held, the composer queues
	 * what is sent instead (`drainPostTurnQueue` sends it after). A load that throws
	 * before it ended the hold ends it here.
	 */
	async function loadChatHoldingTheTurn() {
		beginTurn();
		try {
			await adapters.loadPersistedData();
		} finally {
			if (isSending && !activeStream && activePlaceholderId === null) {
				completeTurn();
			}
		}
	}

	function restoreQueuedTurnToDraft() {
		if (!queuedTurn) return;
		const nextQueuedTurn = cloneSendPayload(queuedTurn);
		queuedTurn = null;
		emitState();
		adapters.restorePayloadToDraft(nextQueuedTurn);
	}

	/**
	 * A reload put the reader back into a turn that then failed: the reconnect ended
	 * on the server's error. The server keeps nothing of a failed turn (it saves the
	 * reader's message with the reply, at the end), so what it has now is an empty
	 * chat or a chat without this message, and the reader saw nothing say it failed
	 * (FB-8's note). Their message goes back where it was, with the error and a
	 * Retry, as for a failure they watched.
	 */
	async function showFailedReconnectedTurn(
		params: StartStreamParams,
		error: Error,
	) {
		// What the page holds now is what the chat it is about to load is compared with.
		const heldIds = new Set(
			adapters.getMessages().map((message) => message.id),
		);
		await loadChatHoldingTheTurn();
		if (!isTurnConversationActive(params.turnConversationId)) return;
		// After the load, which ends the page's own recovery state: set this one last.
		const text = params.message;
		// The reconnect only lost the end of a turn the server finished: the chat
		// just loaded holds it, so there is nothing to put back and nothing failed.
		if (
			judgeServerMessages(adapters.getMessages(), text, heldIds).kind ===
			"landed"
		) {
			lastSend = null;
			canRetry = false;
			emitState();
			await drainPostTurnQueue();
			return;
		}
		// After a reload this page did not send the turn that failed, so there is no
		// payload to send again, only the text. After a dropped connection on the
		// page that did send it, the remembered send is this very message and Retry
		// still carries its files and pictures. Any other send's payload is not
		// this message's.
		if (lastSend && lastSend.payload.message.trim() !== text.trim()) {
			lastSend = null;
		}
		if (text.trim()) {
			const tail = adapters.getMessages().at(-1);
			if (tail?.role !== "user" || tail.content !== text) {
				adapters.applyMessageListEvent({
					type: "appendUser",
					message: createUserMessage({
						id: adapters.randomId(),
						text,
						attachmentIds: [],
						attachedArtifacts: [],
					}),
				});
			}
			lastUserMessage = text;
			canRetry = true;
		}
		adapters.setSendError(adapters.toFriendlySendError(error));
		emitState();
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

		// Item 6 (UX-speed plan) — maps a produce_file tool call (keyed by its
		// callId, falling back to a name+input key when the server doesn't
		// send one — same fallback `applyToolCallUpdateToMessageList` uses to
		// pair a "running" call with its eventual "done"/"failed") to the
		// placeholder job id created for it on "running", so the matching
		// "failed" event can address that same placeholder. Scoped to this
		// stream attempt: a fresh attempt (capacity retry, reconnect) starts
		// with no in-flight produce_file calls to track.
		const fileProductionPlaceholderIds = new Map<string, string>();

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
				if (isFileProductionToolName(name)) {
					const callKey = details?.callId ?? toolCallInputKey(input);
					if (status === "running") {
						if (!fileProductionPlaceholderIds.has(callKey)) {
							const placeholderId = `${PENDING_FILE_PRODUCTION_JOB_ID_PREFIX}${details?.callId ?? `${callKey}:${Date.now()}`}`;
							fileProductionPlaceholderIds.set(callKey, placeholderId);
							adapters.addFileProductionJobPlaceholder?.({
								id: placeholderId,
								conversationId: params.turnConversationId,
								input,
							});
						}
					} else {
						const placeholderId = fileProductionPlaceholderIds.get(callKey);
						if (placeholderId) {
							fileProductionPlaceholderIds.delete(callKey);
							if (status === "failed") {
								adapters.failFileProductionJobPlaceholder?.({
									id: placeholderId,
									message: details?.outputSummary ?? null,
								});
							}
						}
					}
				}
				if (
					adapters.shouldHydrateFileProductionJobsOnToolCall?.(name, status) ||
					adapters.shouldHydrateArtifactsOnToolCall?.(name, status)
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

				// Finding 4 (web-citation auto-repair) — prefer the server's final
				// persisted text over the raw streamed text whenever the two
				// differ, so retry/title-generation see what the conversation
				// actually stored (the message list itself is swapped in
				// finalizeStreamingMessageList).
				const finalText = metadata?.finalContent ?? fullText;
				lastAssistantResponse = finalText;
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

				adapters.maybeTriggerTitleGeneration();

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
				// a callback was already in flight before it did). Uses the
				// ownership-checked completeStaleTurn (not completeTurn) — a
				// different, currently-active turn may already own the shared
				// runtime state by the time this fires.
				if (!isTurnConversationActive(params.turnConversationId)) {
					completeStaleTurn(params.placeholderId);
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
					void showFailedReconnectedTurn(params, err);
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
		// This is a raw timer nothing cancels, so by the time it fires a
		// genuinely new turn may already own the shared runtime state —
		// completeStaleTurn only resets that state if this (stale) turn still
		// owns it, never clobbering a different turn's live stream.
		if (!isTurnConversationActive(params.turnConversationId)) {
			completeStaleTurn(params.placeholderId);
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
			// No stream to reconnect to does not mean the turn failed: it may have
			// finished meanwhile. The page asks before it shows an error and a Retry
			// for a message the server has answered.
			const outcome = await askWhatTheServerHolds(
				params.message,
				params.streamOptions.retryAssistantMessageId,
			);
			if (!isTurnConversationActive(params.turnConversationId)) {
				return;
			}
			adapters.applyMessageListEvent({
				type: "remove",
				messageId: params.placeholderId,
			});
			// A new turn can have started while the page asked: it owns the state.
			if (isSending) return;
			completeTurn();
			if (outcome.kind === "landed") {
				lastSend = null;
				canRetry = false;
				emitState();
				await loadChatHoldingTheTurn();
				await drainPostTurnQueue();
				return;
			}
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
				completeStaleTurn(params.placeholderId);
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
			adapters.maybeTriggerTitleGeneration();
			void drainPostTurnQueue();
		} catch (error) {
			if (!isTurnConversationActive(params.turnConversationId)) {
				completeStaleTurn(params.placeholderId);
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

		const choices = turnChoicesFor(payload);
		const reasoningDepthForTurn = choices.reasoningDepth;
		adapters.setConversationModelSelection(choices.modelId);

		adapters.setSendError(null);
		beginTurn();
		adapters.setSuppressHydration?.(true);
		adapters.setInitialStreamPending?.(false);
		lastUserMessage = text;
		lastReasoningDepth = reasoningDepthForTurn;
		canRetry = true;
		lastSend = {
			payload: copySendPayload(payload),
			options: { ...options },
			conversationId: turnConversationId,
		};
		adapters.markHasPersistedMessages?.();
		emitState();

		if (options.clearDraft) {
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
					pictures: payload.pictures,
				}),
			});
		}

		const placeholderId = adapters.randomId();
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(
				placeholderId,
				undefined,
				options.retryUserIntent ?? userIntentForPayload(payload),
			),
		});

		if (payload.atlasMode === true) {
			await startAtlasTurn({
				payload,
				placeholderId,
				clientUserMessageId,
				turnConversationId,
			});
			return;
		}

		startStream({
			message: text,
			placeholderId,
			clientUserMessageId,
			payload,
			turnConversationId,
			onForkedSourceHistoryConfirmationRequired:
				options.onForkedSourceHistoryConfirmationRequired,
			streamOptions: streamOptionsFor(payload, options, choices),
		});
	}

	/**
	 * The list ends in the message that failed, which the server does not have, or
	 * whose reply a failed regenerate was replacing. Retry sends that message again
	 * and touches nothing above it: not an earlier reply, which is another turn's,
	 * and not a second bubble, since this one is on screen already and takes the
	 * server's id when the turn lands (the pencil and later edits need it).
	 *
	 * It is the last send again, with its payload and its options (`lastSend`): the
	 * files, the pictures and their marks, the model and the rest; an edit's resend
	 * stays one, and a regenerate stays a request for the reply it was replacing.
	 * After a reload there is no send to repeat, only the text. A Retry clears no
	 * draft and none of the files waiting in the composer: they belong to whatever
	 * the person has started since.
	 */
	function resendFailedMessage(bubble: ChatMessage, outcome: ServerOutcome) {
		const turnConversationId = adapters.getConversationId();
		// A send of another chat is never sent into this one (the page resets the
		// runtime on a switch; this holds if it did not).
		if (lastSend && lastSend.conversationId !== turnConversationId) return;
		const payload: NormalChatSendPayload = lastSend?.payload ?? {
			message: lastUserMessage,
			attachmentIds: [],
			attachments: [],
			pendingAttachments: [],
		};
		const remembered: SendRuntimeOptions = lastSend?.options ?? {};

		adapters.setSendError(null);
		beginTurn();
		adapters.markHasPersistedMessages?.();

		const placeholderId = adapters.randomId();
		// The server holds this message and no reply (a regenerate that failed in the
		// model left it so): sent as a new message it would be saved twice. It goes
		// through the retry route as a retry whose reply is gone, named by the new
		// placeholder's id, which no reply of the chat has; the server rebuilds the
		// files and pictures from the message's record. A remembered regenerate
		// already is such a request and keeps its own ids.
		const options: SendRuntimeOptions =
			outcome.kind === "unanswered" && !remembered.retryAssistantMessageId
				? {
						...remembered,
						retryAssistantMessageId: placeholderId,
						retryUserMessageId: outcome.userMessageId,
						retryUserIntent:
							remembered.retryUserIntent ?? userIntentForPayload(payload),
					}
				: remembered;
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(
				placeholderId,
				undefined,
				options.retryUserIntent ?? userIntentForPayload(payload),
			),
		});

		startStream({
			message: payload.message,
			placeholderId,
			clientUserMessageId: bubble.id,
			payload,
			turnConversationId,
			onForkedSourceHistoryConfirmationRequired:
				options.onForkedSourceHistoryConfirmationRequired,
			streamOptions: {
				...streamOptionsFor(payload, options, turnChoicesFor(payload)),
				// The Retry button only appears after a failed turn: a verdict on the
				// failure, not on the answer, so not a counted regenerate.
				retryOrigin: "error_retry",
			},
		});
	}

	async function retry() {
		// A turn is running (a second press while the first waits in the page's gate
		// would otherwise take the first press's placeholder for a reply), or the first
		// press is still reading the chat.
		if (
			adapters.isReadOnly() ||
			adapters.isEditOpen() ||
			isSending ||
			retryReading ||
			!canRetry ||
			!lastUserMessage
		) {
			return;
		}
		const text = lastUserMessage;
		const turnConversationId = adapters.getConversationId();

		// Before the message is sent again the server is asked two things, the stream
		// first. Whether it is still running the turn: it saves the message at the end,
		// and a resend then is turned away for the person's one reply at a time and
		// tried again by the backoff, so a turn that ends meanwhile runs twice. And,
		// when it is not, whether the chat has the turn: a dropped connection does not
		// mean the turn failed. That order is the one that cannot miss: the server
		// saves a turn's message before it unregisters its stream, so a turn that ends
		// between the two questions is found by the second. An answer that does not
		// come says nothing, and Retry goes on as it always did.
		let outcome: ServerOutcome = { kind: "unknown" };
		let running: Awaited<ReturnType<typeof findRunningStream>> = null;
		retryReading = true;
		try {
			running = await findRunningStream(turnConversationId);
			if (!running && adapters.readChatMessages) {
				outcome = await askWhatTheServerHolds(
					text,
					lastSend?.options.retryAssistantMessageId,
				);
			}
		} finally {
			retryReading = false;
		}
		// A turn can have started, an edit been opened or the chat changed while the
		// page asked, which can take seconds with the page live.
		if (
			adapters.isReadOnly() ||
			adapters.isEditOpen() ||
			isSending ||
			!canRetry ||
			lastUserMessage !== text ||
			!isTurnConversationActive(turnConversationId)
		) {
			return;
		}
		if (outcome.kind === "landed") {
			// The server finished the turn: the chat it holds is the page's now, and
			// there is nothing to send, no error to show and nothing to retry.
			lastSend = null;
			canRetry = false;
			adapters.setSendError(null);
			emitState();
			await loadChatHoldingTheTurn();
			await drainPostTurnQueue();
			return;
		}
		if (running) {
			// The turn is still running on the server: Retry joins it and sends nothing,
			// the way a reload and a tab back from the background do.
			if (await joinRunningStream(running, text, turnConversationId)) {
				adapters.setSendError(null);
			}
			return;
		}
		const tail = adapters.getMessages().at(-1);
		if (tail?.role === "user") {
			resendFailedMessage(tail, outcome);
			return;
		}

		// The list really ends in an assistant message: Retry regenerates it.
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
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			// Same optimistic carry-over as a regenerate through send() — see
			// SendRuntimeOptions.retryUserIntent.
			placeholder: createAssistantPlaceholder(
				placeholderId,
				undefined,
				lastAssistantMsg?.userIntent,
			),
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
			turnConversationId,
			streamOptions: {
				modelId: lastAssistantMsg?.modelId ?? adapters.getSelectedModel(),
				reasoningDepth: lastReasoningDepth,
				activeDocumentArtifactId: adapters.getActiveDocumentArtifactId(),
				personalityProfileId: adapters.getPersonalityProfileId(),
				retryAssistantMessageId: retryAssistantMessageId ?? undefined,
				retryUserMessageId,
				retryUserMessage: retryAssistantMessageId ? lastUserMessage : undefined,
				// The Retry button only appears after a failed turn: a verdict on
				// the failure, not on the answer, so not a counted regenerate.
				retryOrigin: "error_retry",
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

	/**
	 * Hands the queued turn to the caller and empties the queue: nothing is sent and
	 * nothing is put back in the composer. For a page that is being left, where the
	 * words would go with the queue (`reset`, a page that is destroyed), and the
	 * caller saves them in the draft of the chat they were queued in.
	 */
	function takeQueuedTurn(): NormalChatSendPayload | null {
		if (!queuedTurn) return null;
		const taken = cloneSendPayload(queuedTurn);
		queuedTurn = null;
		emitState();
		return taken;
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
		lastReasoningDepth = "thorough";
		lastSend = null;
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

	/**
	 * The stream the server is still running for a chat (`checkForOrphanedStream`: a
	 * generation goes on after the connection that asked for it dropped), with what
	 * it says of it. A reload, a tab that was in the background and Retry all find it
	 * this way.
	 */
	async function findRunningStream(
		conversationId: string,
	): Promise<{ streamId: string; bufferInfo: StreamBufferInfo | null } | null> {
		const streamId = await adapters.checkForOrphanedStream(conversationId);
		if (!streamId) return null;
		return {
			streamId,
			bufferInfo: await adapters.getStreamBufferInfo(streamId, conversationId),
		};
	}

	/** Joins a running stream: its replay goes into a placeholder, under the bubble that is on screen. */
	function joinRunningStream(
		running: { streamId: string; bufferInfo: StreamBufferInfo | null },
		fallbackMessage: string,
		turnConversationId: string = adapters.getConversationId(),
	) {
		const { streamId, bufferInfo } = running;
		return reconnectToOrphanedStream(
			streamId,
			bufferInfo?.userMessage ?? fallbackMessage,
			0,
			bufferInfo?.reasoningDepth,
			bufferInfo?.createdAt ? Date.now() - bufferInfo.createdAt : undefined,
			turnConversationId,
		);
	}

	async function checkForOrphanedStreamOnMount() {
		if (isSending || activeStream) {
			return false;
		}
		const running = await findRunningStream(adapters.getConversationId());
		if (!running) return false;
		return joinRunningStream(running, "");
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
		takeQueuedTurn,
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
		pictureRefs: payload.pictureRefs
			? payload.pictureRefs.map((ref) => ({ ...ref }))
			: undefined,
		pictures: payload.pictures
			? {
					...payload.pictures,
					refs: payload.pictures.refs.map((ref) => ({ ...ref })),
					...(payload.pictures.uploads
						? {
								uploads: payload.pictures.uploads.map((upload) => ({
									...upload,
								})),
							}
						: {}),
				}
			: undefined,
		imageMarks: payload.imageMarks
			? {
					...payload.imageMarks,
					marks: payload.imageMarks.marks.map((mark) => ({ ...mark })),
				}
			: null,
		markedPicture: payload.markedPicture
			? { ...payload.markedPicture }
			: undefined,
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

/**
 * What the server holds of a message the page thinks failed.
 *
 * - `landed`: the server finished the turn. Its list ends in an assistant message
 *   the page's list does not hold (the ids tell it from an earlier turn with the
 *   same words), right after a user message with these words, trimmed.
 * - `unanswered`: its list ends in a user message with these words and no reply,
 *   the state a regenerate leaves when the model fails (the retry deleted the
 *   reply first). Sending the words as a new message would save them twice.
 * - `unknown`: anything else, and a list that could not be read.
 */
type ServerOutcome =
	| { kind: "landed" }
	| { kind: "unanswered"; userMessageId: string }
	| { kind: "unknown" };

function judgeServerMessages(
	serverMessages: readonly ChatMessage[] | null,
	text: string,
	heldIds: ReadonlySet<string>,
): ServerOutcome {
	const words = text.trim();
	const last = serverMessages?.at(-1);
	if (!serverMessages || !last || !words) return { kind: "unknown" };
	if (last.role === "assistant") {
		const before = serverMessages.at(-2);
		return !heldIds.has(last.id) &&
			before?.role === "user" &&
			before.content.trim() === words
			? { kind: "landed" }
			: { kind: "unknown" };
	}
	return last.role === "user" && last.content.trim() === words
		? { kind: "unanswered", userMessageId: last.id }
		: { kind: "unknown" };
}

/**
 * A send as Retry sends it again: a copy, so that nothing its caller does later
 * reaches it. `cloneSendPayload` fills in a queued turn's open choices; a Retry
 * asks the page again for what the payload left open, as the send did, and an
 * edit's resend stays one.
 */
function copySendPayload(
	payload: NormalChatSendPayload,
): NormalChatSendPayload {
	return {
		...cloneSendPayload(payload),
		personalityProfileId: payload.personalityProfileId,
		isEditResend: payload.isEditResend,
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
