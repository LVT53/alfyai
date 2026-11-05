import type { RetryOrigin } from "$lib/chat-turn-origin";
import { submitAtlasTurn } from "$lib/client/api/atlas";
import type { ServerHealth } from "$lib/client/api/health";
import {
	SERVER_UPDATE_WATCH_MAX_MS,
	SERVER_UPDATE_WATCH_POLL_MS,
	type ServerUpdateKind,
} from "$lib/client/server-update-watch";
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
	isServerUpdateRefusal,
	isStreamTransportFailure,
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
import { type AskAnswer, isAskToolName } from "$lib/shared/ask-user";
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

/**
 * What the runtime tells the page about "Ask me first": Alfy can stop a reply to
 * ask the person questions, and the person's answer carries the same reply on as a
 * new segment (`answerQuestion`). An answer is told as `answerAccepted` (then
 * `paused` too, if the resume asks again), or as `answerNotSent`, or as
 * `alreadyAnswered`; `paused` and `refusedWhileWaiting` are about any turn.
 *
 * - `paused`: a turn ended with a question waiting (`waitingQuestionId`), whichever
 *   turn it was: a send, a reconnect, or a resume that asks again.
 *   `assistantMessageId` is the saved asking row as this end knows it: the terminal
 *   metadata names it, else the row the placeholder became. Null when the list no
 *   longer holds it, and then nothing can be stamped locally.
 * - `answerAccepted`: the resume runs on the server, so the answer was taken up. The
 *   first event of its stream says so, or the stream joined after the connection
 *   died (or after the browser cut a hidden tab off), or a stream that ended before
 *   it said anything. Reported once per answer.
 * - `answerNotSent`: the answer is not on its way, and the card comes back with it:
 *   it was refused, its request died, the waits ran out, or the resume's stream
 *   could not be found after a drop. It can follow `answerAccepted` (a resume that
 *   began and was then lost): the page then reads the questions and the chat to
 *   learn whether the resume finished. `quiet` is for a Stop, for a tab the
 *   browser cut off whose resume the recovery did not find, and for an answer the
 *   runtime turned away at once (a turn it still runs, an edit, a sealed chat, where
 *   its checks and the page's disagreed): none is a failure, so no error line.
 * - `alreadyAnswered`: another answer won the claim (a second device, a double tap).
 * - `refusedWhileWaiting`: a message, a Retry or a regenerate was turned away
 *   because a question waits; the page was stale and reads the questions and the
 *   chat again.
 */
export type AskRuntimeEvent =
	| { type: "paused"; questionId: string; assistantMessageId: string | null }
	| { type: "answerAccepted"; questionId: string }
	| { type: "answerNotSent"; questionId: string; quiet: boolean }
	| { type: "alreadyAnswered"; questionId: string }
	| { type: "refusedWhileWaiting" };

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
	/**
	 * The connection capabilities the composer has switched on, as a send of it would
	 * carry them (`enabledConnectionCapabilities`), for the turn an answer starts.
	 * Undefined when there is no selection to send, and the server then falls back to
	 * the person's defaults, as for any client that sends none. The selection lives in
	 * the composer, not in the runtime, so only the page can say.
	 */
	getEnabledConnectionCapabilities?: () => string[] | undefined;
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
	/**
	 * "Ask me first": the page reads the chat's questions again. Called when an
	 * `ask_user` call is done or failed, the way `refreshPendingWrites` follows a
	 * connector call: the question rows are what the card is drawn from.
	 */
	refreshQuestions?: () => void;
	/** The runtime's word to the page about an answer, a pause or a refusal because a question waits (`AskRuntimeEvent`). */
	onAskEvent?: (event: AskRuntimeEvent) => void;
	/**
	 * The asking row of the question whose answer is on its way, if the page knows of
	 * one. A reconnect that joins a stream then is that question's resume, and its
	 * placeholder continues that row (`continuesMessageId`) instead of drawing as a
	 * reply of its own.
	 */
	getAnsweringQuestionMessageId?: () => string | null;
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
	/**
	 * The server's `/api/health` as far as an update goes (`client/api/health.ts`):
	 * up, draining for a deploy restart, the proxy answering instead of the app (the
	 * restart), or unreachable (nothing says what it is doing). A message waiting for
	 * an update asks it every few seconds and goes when it says `up`.
	 */
	fetchServerHealth: () => Promise<ServerHealth>;
	/**
	 * Whether a newer version of the app is live, as the page knows it right now: a
	 * synchronous read (SvelteKit's `updated.current`). The runtime reads it the
	 * moment a reply's connection fails, before it awaits anything, and hands it to
	 * `askServerUpdate`: a version that was already live then is not this reply's
	 * update (a tab that missed a deploy has one for ever).
	 */
	isNewVersionLive: () => boolean;
	/**
	 * Whether the server is being updated, and how (`judgeServerUpdate`): draining,
	 * the proxy answering instead of the app, a version that went live since
	 * `versionWasLive` was read, or none of those, which a lost connection is. Asked
	 * when a reply was cut by a connection that failed, before the failure is put
	 * down to the provider.
	 */
	askServerUpdate: (versionWasLive: boolean) => Promise<ServerUpdateKind>;
	/**
	 * A turn waits for an update: the shell watches the server while it does (the
	 * draining banner, the Refresh notice), so it is told once per wait.
	 */
	onServerUpdateSign?: () => void;
	/**
	 * Whether a message is waiting for the update to finish. It has not reached the
	 * server, so the shell holds back its Refresh notice while this is true: a
	 * reload then would lose the message.
	 */
	setTurnWaitingForUpdate?: (waiting: boolean) => void;
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

/**
 * The person's answer to a question Alfy asked, while it is on its way
 * (`answerQuestion`). It rides on the params of every stream attempt of that
 * answer (a backoff or a wait sends the same params again, and a join of the
 * resume's stream takes it over), so what is learned on one attempt is known to the
 * next.
 */
type AnswerInFlight = {
	questionId: string;
	/** `answerAccepted` has been reported: it is said once per answer, whichever stream carried the resume. */
	accepted: boolean;
};

type StartStreamParams = {
	message: string;
	placeholderId: string;
	clientUserMessageId: string | null;
	payload?: NormalChatSendPayload;
	streamOptions: StreamChatOptions;
	/**
	 * The asking row this stream's reply continues. Set on a stream that carries the
	 * resume of a question's answer, whether this runtime sent that answer (`answer`)
	 * or only joined the resume (a reload during it): such a stream is no message, and
	 * a failure of it must not be taken for one.
	 */
	continuesMessageId?: string;
	/** Set when this runtime sent the person's answer and this stream carries it or its resume: the answer fails differently from a message, and tells the page how it ended. */
	answer?: AnswerInFlight;
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
	// ADR-0054 (an update during a turn): how many times this request has been
	// sent again after waiting for the server to come back from an update. A
	// request the server keeps turning away as an update while its health says it
	// is well is not an update, and fails like any other once it reaches
	// `AWAIT_UPDATE_MAX_RESENDS`.
	updateResendCount?: number;
	// R1 (ADR-0060, defect 1): bounded retry count for a *fresh* send whose
	// connection dropped after content had already streamed. Mirrors
	// `capacityRetryCount`'s backoff idiom, but recovers via the orphaned
	// stream (the server keeps generating independent of this dropped
	// client connection) instead of a brand-new request.
	networkRetryCount?: number;
	onForkedSourceHistoryConfirmationRequired?: () => void;
};

/**
 * What a stream that carries a resume hands on to the stream that takes over from
 * it (a rejoin after a drop, the recovery of a tab the browser cut off): the answer
 * and the row, so the new stream is still the resume, not a reply of its own.
 */
type ResumeContext = Pick<StartStreamParams, "answer" | "continuesMessageId">;

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

/** How long Retry waits for the server to say whether it still runs the turn before it goes on without an answer. */
const STREAM_QUESTION_MAX_MS = 5000;

// A turn that waits for a server update (ADR-0054, "An Update During A Turn"):

/** How often it asks whether the server is back; the shell's watch looks as often. */
const AWAIT_UPDATE_POLL_MS = SERVER_UPDATE_WATCH_POLL_MS;

/**
 * How long it waits before it gives up, 8 minutes: the deploy's drain (3
 * minutes), a stop of up to 2 minutes (the unit's TimeoutStopSec=120), then the
 * health wait after the cutover and some slack. One number with the shell's watch
 * and the draft save that is sent again (`conversation-session.ts`).
 */
const AWAIT_UPDATE_MAX_MS = SERVER_UPDATE_WATCH_MAX_MS;

/** A health question that has not answered by now is taken for "the server is away"; the poll goes on. */
const AWAIT_UPDATE_QUESTION_MAX_MS = 5000;

/** A request sent again this many times and turned away as an update each time, while health says the server is well, fails like any other request. */
const AWAIT_UPDATE_MAX_RESENDS = 3;

/** A reply that was cut off is rejoined at most this many times over while the server answers (a stream that keeps failing on a server that keeps answering is not an update). */
const MAX_REJOINS_OF_A_CUT_REPLY = 3;

/** What the poll takes for the answer of a health question that did not come: the server cannot be told from it, and the wait goes on. */
const NO_ANSWER: ServerHealth = { state: "unreachable" };

/**
 * A cut reply the runtime is deciding about (what is the server doing? is its
 * stream still running?). The stream that failed is gone, so a Stop pressed
 * meanwhile has nothing to stop: it is recorded here, and the decision honours it.
 */
type CutReplyQuestion = {
	stopped: boolean;
	/** The handle of the stream that failed; Stop still asks the server to stop the run it may have. */
	deadStream: StreamHandle | null;
};

/**
 * How a hold on a cut reply ends (`holdTurnWhileServerUpdates`).
 * - `none`: nothing says an update; the failure is what it always was.
 * - `draining`: the old process is alive and finishes the replies it runs, so the
 *   reply is probably still running there: look for its stream, do not wait.
 * - `new_version`: the server answers and runs a version that went live during this
 *   turn. The restart is over and probably cut the reply, but whatever answers may
 *   still run it, so its stream is looked for first, as when the server drains, and
 *   only a reply with no stream left is put down to the update. The turn state is
 *   held for the caller.
 * - `cut`: the restart cut the reply and the server is back (or the wait passed its
 *   cap). The turn state is held for the caller.
 * - `stopped`: Stop was pressed while the page was asked; nothing is waited for and
 *   the turn ends.
 * - `abandoned`: the chat on screen changed, or the page was left; the caller does
 *   nothing more.
 */
type CutReplyVerdict =
	| "none"
	| "draining"
	| "new_version"
	| "cut"
	| "stopped"
	| "abandoned";

/** How a wait for an update ends (a page that is left ends it without one). */
type UpdateWaitEnd = "back" | "timeout" | "stopped";

/**
 * The one turn that waits for the server to come back. `onEnd` runs once, when
 * the server is back, the cap passes or Stop is pressed; a wait that is dropped
 * (`reset`) or taken (`takeWaitingRequest`) does not run it.
 */
type UpdateWait = {
	placeholderId: string;
	turnConversationId: string;
	/** The words of a message the server never got, for a page that is left to keep. Null when the server holds the message (a regenerate) or the wait is for a reply it was reading. */
	unsentPayload: NormalChatSendPayload | null;
	/** `detach` was called: the page is going away, so the wait does nothing more, but it can still be taken. */
	detached: boolean;
	onEnd: (end: UpdateWaitEnd) => void;
};

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
	// The turn that waits for the server to come back from an update, if any.
	let updateWait: UpdateWait | null = null;
	// True from `detach()` (the page is going away, or the chat is switched) until the
	// page calls an entry point again: `send` (a regenerate and an edit's resend are
	// sends), `retry`, or `checkForOrphanedStreamOnMount`, each of which clears it
	// synchronously, before it awaits anything. Nothing else clears it. A turn's
	// work that was out when the page went (a refusal, a cut reply, a question, a
	// backoff or recovery timer, a Retry's reads) gets back to a runtime that is
	// still set, and while it is set it starts nothing: no stream, no resend, no
	// wait, no sign for the shell. `isTurnConversationActive` alone cannot say so: a
	// destroyed page keeps its chat id.
	let detached = false;
	// The cut reply being asked about, if any (`CutReplyQuestion`).
	let cutReplyQuestion: CutReplyQuestion | null = null;
	// A resume the browser cut off while the tab was in the background. Its answer is
	// pending, not failed: the server may still run it. It is kept until the tab is
	// visible and the recovery has looked (`recoverBackgroundInterruptedStream`), which
	// joins the resume with its answer and its row, or tells the page it is gone.
	let interruptedResume: ResumeContext | null = null;

	function snapshot(): NormalChatRuntimeSnapshot {
		return {
			phase,
			active: Boolean(activeStream) || cutReplyQuestion !== null,
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

	/**
	 * Whether a turn can start in `turnConversationId` now: the page is there (it was
	 * not left, `detached`), the chat is on screen and no turn holds the turn state.
	 */
	function canStartTurnIn(turnConversationId: string): boolean {
		return (
			!detached &&
			!isSending &&
			!activeStream &&
			isTurnConversationActive(turnConversationId)
		);
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

	// ---- A turn that waits for the server to come back from an update ----------
	//
	// A deploy drains the server (new messages are turned away, with the reason
	// "draining") and then restarts it (the reverse proxy answers a maintenance
	// page). A request refused for that ran nothing, so it waits and is sent again
	// when the server is back; a reply the restart cut is asked about instead
	// (`holdTurnWhileServerUpdates`), never sent again by itself.

	function dropUpdateWait() {
		if (!updateWait) return;
		updateWait = null;
		adapters.setTurnWaitingForUpdate?.(false);
	}

	function endUpdateWait(wait: UpdateWait, end: UpdateWaitEnd) {
		if (updateWait !== wait) return;
		dropUpdateWait();
		wait.onEnd(end);
	}

	/**
	 * Starts the wait: the bubble says it (`awaiting_update`), the shell is told and
	 * watches the server too, and every few seconds the server is asked whether it is
	 * back, until it answers and is not draining, the cap passes or Stop is pressed.
	 * Each tick checks that the wait is still this one and the chat is still on
	 * screen, so nothing is sent from a chat the person has left.
	 */
	function beginUpdateWait(init: Omit<UpdateWait, "detached">): boolean {
		// A page that was left starts no wait: nothing could be sent from it, and the
		// shell must not hold its Refresh notice back for words nobody will send.
		if (detached) return false;
		const wait: UpdateWait = { ...init, detached: false };
		updateWait = wait;
		// The shell first: its Refresh notice is held before the bubble says why.
		adapters.setTurnWaitingForUpdate?.(true);
		adapters.onServerUpdateSign?.();
		setPhase("awaiting_update", wait.placeholderId);

		const live = (): boolean => {
			if (updateWait !== wait || wait.detached) return false;
			if (isTurnConversationActive(wait.turnConversationId)) return true;
			dropUpdateWait();
			completeStaleTurn(wait.placeholderId);
			return false;
		};
		const askHealth = async () =>
			(await answerWithin(
				adapters.fetchServerHealth(),
				AWAIT_UPDATE_QUESTION_MAX_MS,
			)) ?? NO_ANSWER;
		const poll = () => {
			if (!live()) return;
			void (async () => {
				const health = await askHealth();
				if (!live()) return;
				// Only `up` ends it. Draining and the restart wait, and so does a server
				// that cannot be reached: a wait cannot tell it from the restart.
				if (health.state === "up") {
					endUpdateWait(wait, "back");
					return;
				}
				adapters.schedule(poll, AWAIT_UPDATE_POLL_MS);
			})();
		};
		adapters.schedule(poll, AWAIT_UPDATE_POLL_MS);
		adapters.schedule(() => {
			if (!live()) return;
			// A tab that slept through the wait wakes to find the cap passed, and the
			// poll that would have noticed the server was back never ran: the server may
			// have been up for minutes. So it is asked once more before the wait is given
			// up, and only a server that is still not back ends it as a timeout.
			void (async () => {
				const health = await askHealth();
				if (!live()) return;
				endUpdateWait(wait, health.state === "up" ? "back" : "timeout");
			})();
		}, AWAIT_UPDATE_MAX_MS);
		return true;
	}

	/**
	 * A request the server turned away because it is being updated (it is draining
	 * for a deploy, or the proxy answers its maintenance page for the restart). The
	 * turn never began, so the same request is sent again when the server is back;
	 * meanwhile the placeholder stays, saying so. The give-up and Stop mirror what a
	 * request that fails does, without the provider's error sentence.
	 */
	function holdRefusedRequestForUpdate(params: StartStreamParams) {
		// The refused request has no stream, and nothing to stop.
		setActiveStream(null);
		const unsentWords = payloadTheServerNeverGot(params);
		const waiting = beginUpdateWait({
			placeholderId: params.placeholderId,
			turnConversationId: params.turnConversationId,
			unsentPayload: unsentWords,
			onEnd: (end) => {
				if (end === "back") {
					if (detached) return;
					setPhase("preparing", params.placeholderId);
					startStream({
						...params,
						capacityRetryCount: 0,
						updateResendCount: (params.updateResendCount ?? 0) + 1,
					});
					return;
				}
				// An answer the server never got: nothing but the placeholder is on screen
				// and nothing of it failed, so no sentence and no Retry. The card comes
				// back with the answer in it; a give-up says why, and Stop does not.
				if (params.answer) {
					endAnswer(params, {
						type: "answerNotSent",
						questionId: params.answer.questionId,
						quiet: end === "stopped",
					});
					return;
				}
				if (end === "timeout") {
					endTurnWithError(params, "chat.updateStillRunning");
					return;
				}
				// Stop. The placeholder goes. A message the server never got goes too,
				// with its bubble, and its words return to the composer (joined to what
				// it holds, as for any restore).
				if (unsentWords) {
					giveBackUnsentRequest({
						placeholderId: params.placeholderId,
						clientUserMessageId: params.clientUserMessageId,
						words: unsentWords,
					});
					return;
				}
				adapters.applyMessageListEvent({
					type: "remove",
					messageId: params.placeholderId,
				});
				// A request the server knows (a regenerate, a Retry of a message it holds
				// without a reply): it never ran, but the page took the reply it replaces
				// off the screen when the request began, so the chat is read back.
				if (takeQueuedContextCompression()) {
					void adapters.runManualContextCompression();
				}
				restoreQueuedTurnToDraft();
				void settleStoppedRequestTheServerKnows(params);
			},
		});
		// A page that was left starts no wait (its words are the page's to keep).
		if (!waiting) completeStaleTurn(params.placeholderId);
	}

	/**
	 * Stop on a wait for a request the server knows. The old reply is gone from the
	 * screen (the page removed it when the regenerate began) and the request never
	 * ran, so the chat is read back, and the reply the server holds returns. The turn
	 * state is held through the read (the composer queues what is sent meanwhile),
	 * which is bounded; a chat that cannot be read (the restart is still on) leaves
	 * the question with the sentence for a wait that did not end, and Retry: Retry
	 * renders only beside a sentence, and asks the server before it sends anything.
	 */
	async function settleStoppedRequestTheServerKnows(params: StartStreamParams) {
		activePlaceholderId = null;
		phase = "preparing";
		canRetry = true;
		emitState();
		const read = adapters.readChatMessages;
		const held = read
			? await answerWithin(read(), STREAM_QUESTION_MAX_MS)
			: undefined;
		if (detached || !isTurnConversationActive(params.turnConversationId)) {
			// The page was left or moved on; its own reset has ended the turn state.
			return;
		}
		if (held === null) {
			completeTurn();
			// What was queued behind it while the chat was being read goes back to the
			// composer, as for any turn that ends in an error (`settleCutReply`).
			if (takeQueuedContextCompression()) {
				void adapters.runManualContextCompression();
			}
			restoreQueuedTurnToDraft();
			adapters.setSendError("chat.updateStillRunning");
			canRetry = true;
			emitState();
			return;
		}
		await loadChatHoldingTheTurn();
		await drainPostTurnQueue();
	}

	/**
	 * The turn ends with a sentence and a Retry, as a request that failed does:
	 * the placeholder goes, the user's bubble stays, a message queued behind it
	 * returns to the composer.
	 */
	function endTurnWithError(params: StartStreamParams, message: string) {
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		completeTurn();
		if (!params.isReconnect) {
			if (takeQueuedContextCompression()) {
				void adapters.runManualContextCompression();
			}
			restoreQueuedTurnToDraft();
		}
		adapters.setSendError(message);
		canRetry = true;
		emitState();
	}

	/**
	 * A request that ends with no reply and nothing to retry: the placeholder goes. A
	 * message the server never got goes too, with its bubble, and its `words` return to
	 * the composer (joined to what it holds, as for any restore), then what was queued
	 * behind it (nothing drains the queue after this). Retry has nothing to send. The
	 * sentence, if there is one, says why. A request the server knows (`words` null: a
	 * regenerate, a Retry of a message it holds) has no words to give back and keeps
	 * its bubble; the page reads the chat again for what it took off the screen.
	 *
	 * Where it ends: Stop on a wait for an update, an Atlas kickoff that did not start,
	 * and a message a stale page sent while a question waits.
	 */
	function giveBackUnsentRequest(unsent: {
		placeholderId: string;
		clientUserMessageId: string | null;
		words: NormalChatSendPayload | null;
		sentence?: string | null;
	}) {
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: unsent.placeholderId,
		});
		if (unsent.words && unsent.clientUserMessageId) {
			adapters.applyMessageListEvent({
				type: "remove",
				messageId: unsent.clientUserMessageId,
			});
		}
		lastSend = null;
		canRetry = false;
		completeTurn();
		if (takeQueuedContextCompression()) {
			void adapters.runManualContextCompression();
		}
		if (unsent.words) adapters.restorePayloadToDraft(unsent.words);
		restoreQueuedTurnToDraft();
		if (unsent.sentence) adapters.setSendError(unsent.sentence);
		emitState();
	}

	// ---- "Ask me first": the person's answer is a turn that is not a message -----
	//
	// An answer meets what a send meets (an update, a busy server, a connection that
	// drops), but nothing of it is on screen except a placeholder under the asking
	// row, and nothing of it is the person's words to put back: the card holds the
	// answer. So where a send ends with a sentence and a Retry, an answer ends with
	// an event, and `lastSend`, `canRetry` and the send error are never touched.

	/** `answerAccepted`, once per answer: the resume runs on the server. */
	function reportAnswerAccepted(answer: AnswerInFlight) {
		if (answer.accepted) return;
		answer.accepted = true;
		adapters.onAskEvent?.({
			type: "answerAccepted",
			questionId: answer.questionId,
		});
	}

	/**
	 * An answer that ends without carrying the reply on in this tab: the placeholder
	 * goes, the turn ends, what was queued behind it returns to the composer (nothing
	 * drains the queue after this), and the page is told how it ended. With `ownsTurn`
	 * false the turn state may belong to a turn that started since (the composer is
	 * free after a drop), and is left alone.
	 */
	function endAnswer(
		params: StartStreamParams,
		event: AskRuntimeEvent,
		ownsTurn = true,
	) {
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		if (ownsTurn || !isSending) {
			completeTurn();
			if (takeQueuedContextCompression()) {
				void adapters.runManualContextCompression();
			}
			restoreQueuedTurnToDraft();
		}
		adapters.onAskEvent?.(event);
	}

	/**
	 * An answer the server did not take up as a running resume: it was refused, its
	 * request died before the resume streamed, or the update wait and the capacity
	 * backoff ran out. The server may still run it (the connection died, not the
	 * reply), so the chat's running stream is looked for and joined, under a new
	 * placeholder that continues the same row. Otherwise the card comes back with the
	 * answer in it, and the server has the question as waiting again.
	 *
	 * This is not `settleCutReply`, which asks the server whether a message got a
	 * reply: a resume's reply is not a reply right after a user message but a new
	 * assistant row that continues the asking one.
	 */
	async function settleAnswerThatDidNotLand(
		params: StartStreamParams,
		answer: AnswerInFlight,
		options: { ownsTurn: boolean },
	) {
		const joined = await joinRunningStreamOfCutReply(params, options.ownsTurn);
		if (joined === "abandoned") {
			completeStaleTurn(params.placeholderId);
			return;
		}
		if (joined === "joined") {
			// A stream of the chat is running its resume, so the server has the answer.
			reportAnswerAccepted(answer);
			return;
		}
		endAnswer(
			params,
			{ type: "answerNotSent", questionId: answer.questionId, quiet: false },
			options.ownsTurn,
		);
	}

	/**
	 * A new message, a Retry or a regenerate that the server turned away because a
	 * question of Alfy's waits for its answer (409 `QUESTION_WAITING`): this page was
	 * stale (another device asked, or this tab missed the pause), and nothing ran. It
	 * is given back with no sentence and no Retry (`giveBackUnsentRequest`: a message
	 * the server never got returns to the composer with its bubble gone, a request it
	 * knows only loses its placeholder), and the page is told to read the questions
	 * and the chat again and show the card.
	 */
	function settleRefusedWhileQuestionWaits(params: StartStreamParams) {
		giveBackUnsentRequest({
			placeholderId: params.placeholderId,
			clientUserMessageId: params.clientUserMessageId,
			words: payloadTheServerNeverGot(params),
		});
		adapters.onAskEvent?.({ type: "refusedWhileWaiting" });
	}

	/** What the page says the server is doing; no answer in time is none. */
	async function askServerUpdate(
		versionWasLive: boolean,
	): Promise<ServerUpdateKind> {
		return (
			(await answerWithin(
				adapters.askServerUpdate(versionWasLive),
				AWAIT_UPDATE_QUESTION_MAX_MS,
			)) ?? "none"
		);
	}

	/**
	 * A reply was cut by a connection that failed (no status, no code of the
	 * server's own, or the proxy answering instead of the app). A restart looks like
	 * that from a reply that was running, and so does a phone that lost its signal, so
	 * before the failure is put down to the provider the page is asked what the server
	 * is doing (`versionWasLive` is what the page knew of the version when the failure
	 * was handled):
	 *
	 * - the proxy answers instead of the app (`cut`): the restart cut the reply. The
	 *   turn is held in `awaiting_update` (the placeholder keeps any text it has) until
	 *   the server is back or the cap passes, and the caller then asks the server what
	 *   it holds: it may have finished the turn while the browser was cut off. The reply
	 *   is never sent again by itself: tools may have run (a produced file, a
	 *   Document), and sending it again is the person's choice, through Retry.
	 * - the server is draining (`draining`): the old process is alive and finishes
	 *   the replies it runs, so this one is probably still running there. Nothing is
	 *   waited for; the caller looks for its stream and joins it.
	 * - a version went live during this turn and the server answers (`new_version`):
	 *   the restart is over. Nothing is waited for either, and the caller looks for the
	 *   stream first and joins it, as when the server drains.
	 * - nothing says an update (`none`), which is what a lost connection looks like.
	 *
	 * `ownsTurn` is false when the stream's error already let the turn go (the
	 * composer was free meanwhile): the turn is taken back for a `cut`, unless another
	 * turn has started since.
	 */
	async function holdTurnWhileServerUpdates(held: {
		placeholderId: string;
		turnConversationId: string;
		ownsTurn: boolean;
		versionWasLive: boolean;
		/** Open while the page is asked, for a turn that still holds the turn state: a Stop pressed meanwhile lands here. */
		question?: CutReplyQuestion;
	}): Promise<CutReplyVerdict> {
		const kind = await askServerUpdate(held.versionWasLive);
		const stopped = held.question?.stopped === true;
		if (held.question) closeCutReplyQuestion(held.question);
		// The page may have been left while it was asked: nothing is started from it.
		if (detached || !isTurnConversationActive(held.turnConversationId)) {
			return "abandoned";
		}
		// Stop was pressed meanwhile: no wait, the turn ends.
		if (stopped) return "stopped";
		if (kind === "none") return "none";
		if (kind === "draining") {
			adapters.onServerUpdateSign?.();
			return "draining";
		}
		if (!held.ownsTurn) {
			if (isSending) return "none";
			isSending = true;
			activePlaceholderId = held.placeholderId;
			emitState();
		}
		if (kind === "new_version") {
			// The restart is over and the server answers: nothing to wait for.
			adapters.onServerUpdateSign?.();
			return "new_version";
		}
		return new Promise((resolve) => {
			const waiting = beginUpdateWait({
				placeholderId: held.placeholderId,
				turnConversationId: held.turnConversationId,
				// A cut reply has no words to keep: the server may well hold the message.
				unsentPayload: null,
				onEnd: () => resolve("cut"),
			});
			if (!waiting) resolve("abandoned");
		});
	}

	/**
	 * Opens the question a cut reply's turn is asking: its stream is gone, so Stop has
	 * nothing to stop but the run the server may still have, and is recorded
	 * (`stop()`). While it is open the turn counts as active, so Stop stays within
	 * reach for the moment the page is asked.
	 */
	function openCutReplyQuestion(deadStream: StreamHandle | null) {
		const question: CutReplyQuestion = { stopped: false, deadStream };
		cutReplyQuestion = question;
		emitState();
		return question;
	}

	function closeCutReplyQuestion(question: CutReplyQuestion) {
		if (cutReplyQuestion !== question) return;
		cutReplyQuestion = null;
		emitState();
	}

	/**
	 * The server answers (it is draining, or a new version went live) and a reply of
	 * this chat was cut by a connection that failed: the old process may be alive and
	 * has probably not stopped this reply. So its stream is looked for again and
	 * joined (the replay goes into a fresh placeholder under the bubble on screen,
	 * which supersedes this one). Nothing is waited for. At most three times over, so
	 * a stream that keeps failing on a server that keeps answering is not followed
	 * for ever.
	 *
	 * "none" says nothing was joined and nothing was taken off the screen: no stream,
	 * the stream of another message, the limit, or a turn that holds the turn state (a
	 * join needs it free; the composer is free after a drop, so a message sent since is
	 * a turn). The caller then settles the reply like any other that cannot be joined
	 * (`settleCutReply`), which leaves that turn alone.
	 */
	async function joinRunningStreamOfCutReply(
		params: StartStreamParams,
		ownsTurn: boolean,
	): Promise<"joined" | "none" | "abandoned"> {
		if (
			params.isReconnect &&
			(params.reconnectRetryCount ?? 0) >= MAX_REJOINS_OF_A_CUT_REPLY
		) {
			return "none";
		}
		if (!ownsTurn && isSending) return "none";
		const running = await findRunningStream(
			params.turnConversationId,
			STREAM_QUESTION_MAX_MS,
		);
		if (detached || !isTurnConversationActive(params.turnConversationId)) {
			return "abandoned";
		}
		if (!running || isForAnotherMessage(running.bufferInfo, params.message)) {
			return "none";
		}
		// A reconnect needs the turn state free, and nothing can start between this and
		// it. (For a reply that does not own it, a turn can have started while the page
		// asked.)
		if (ownsTurn) completeTurn();
		if (!canStartTurnIn(params.turnConversationId)) return "none";
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		await reconnectToOrphanedStream(
			running.streamId,
			params.message,
			params.isReconnect ? (params.reconnectRetryCount ?? 0) + 1 : 0,
			running.bufferInfo?.reasoningDepth ?? params.streamOptions.reasoningDepth,
			running.bufferInfo?.createdAt
				? Date.now() - running.bufferInfo.createdAt
				: undefined,
			params.turnConversationId,
			// A resume that is joined stays one: its answer and its row go on, so a
			// failure of the joined stream is the answer's, not a message's.
			params,
		);
		return "joined";
	}

	/**
	 * A reply that was cut and has no stream left to join. No stream does not mean
	 * the turn failed: it may have finished meanwhile. The page asks before it shows
	 * an error and a Retry for a message the server has answered. A reply an update
	 * cut (`cutByUpdate`) says so (`chat.updateCutReply`), not "the provider failed".
	 * `ownsTurn` is whether this turn holds the turn state: false for a recovery that
	 * let it go while it looked, which then leaves a turn that started since alone.
	 */
	async function settleCutReply(
		params: StartStreamParams,
		originalError: Error,
		options: { ownsTurn: boolean; cutByUpdate: boolean },
	) {
		// An answer has no message to ask the server about: the resume's stream is
		// looked for, or the card comes back with the answer.
		if (params.answer) {
			await settleAnswerThatDidNotLand(params, params.answer, {
				ownsTurn: options.ownsTurn,
			});
			return;
		}
		const outcome = await askWhatTheServerHolds(
			params.message,
			params.streamOptions.retryAssistantMessageId,
		);
		if (detached || !isTurnConversationActive(params.turnConversationId)) {
			return;
		}
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		// A new turn can have started while the page asked: it owns the state. (A
		// turn that holds the state is this one's own: nothing else could start.)
		if (isSending && !options.ownsTurn) return;
		completeTurn();
		if (outcome.kind === "landed") {
			lastSend = null;
			canRetry = false;
			emitState();
			await loadChatHoldingTheTurn();
			await drainPostTurnQueue();
			return;
		}
		if (options.ownsTurn) {
			// What was queued behind the reply goes back to the composer, as for any
			// turn that ends in an error.
			if (takeQueuedContextCompression()) {
				void adapters.runManualContextCompression();
			}
			restoreQueuedTurnToDraft();
		}
		adapters.setSendError(
			options.cutByUpdate
				? "chat.updateCutReply"
				: adapters.toFriendlySendError(originalError),
		);
		canRetry = true;
		emitState();
	}

	/**
	 * A stream died before any text with a failed connection. What the server is
	 * doing decides: an update cut it (waited for, then the server is asked what it
	 * holds), the old process still runs it (its stream is joined, or the server is
	 * asked what it holds), or nothing says an update, and it is the failure it
	 * always was.
	 */
	async function settleReplyThatDiedBeforeContent(
		params: StartStreamParams,
		error: Error,
		versionWasLive: boolean,
		deadStream: StreamHandle | null,
	) {
		const hold = await holdTurnWhileServerUpdates({
			placeholderId: params.placeholderId,
			turnConversationId: params.turnConversationId,
			ownsTurn: true,
			versionWasLive,
			question: openCutReplyQuestion(deadStream),
		});
		if (hold === "abandoned") {
			completeStaleTurn(params.placeholderId);
			return;
		}
		if (hold === "none") {
			endTurnWithError(params, adapters.toFriendlySendError(error));
			return;
		}
		if (hold === "stopped") {
			// Stop was pressed while the page was asked: no wait, and nothing is joined.
			// The turn ends, after the server has said whether it holds the message.
			await settleCutReply(params, error, {
				ownsTurn: true,
				cutByUpdate: false,
			});
			return;
		}
		if (hold === "draining" || hold === "new_version") {
			const joined = await joinRunningStreamOfCutReply(params, true);
			if (joined === "abandoned") {
				completeStaleTurn(params.placeholderId);
				return;
			}
			if (joined === "joined") return;
		}
		await settleCutReply(params, error, {
			ownsTurn: true,
			cutByUpdate: hold === "cut" || hold === "new_version",
		});
	}

	/**
	 * A reconnect (a reload, a tab back from the background) ended on a failed
	 * connection. Same question: what is the server doing? An update cut it: the
	 * reply is waited for and, once the server is back, the chat is read for the turn
	 * (`showFailedReconnectedTurn`). The old process still runs it: its stream is
	 * joined again.
	 */
	async function settleReconnectThatFailed(
		params: StartStreamParams,
		error: Error,
		versionWasLive: boolean,
		deadStream: StreamHandle | null,
	) {
		const hold = await holdTurnWhileServerUpdates({
			placeholderId: params.placeholderId,
			turnConversationId: params.turnConversationId,
			ownsTurn: true,
			versionWasLive,
			question: openCutReplyQuestion(deadStream),
		});
		if (hold === "abandoned") {
			completeStaleTurn(params.placeholderId);
			return;
		}
		if (hold === "draining" || hold === "new_version") {
			const joined = await joinRunningStreamOfCutReply(params, true);
			if (joined === "abandoned") {
				completeStaleTurn(params.placeholderId);
				return;
			}
			if (joined === "joined") return;
		}
		adapters.applyMessageListEvent({
			type: "remove",
			messageId: params.placeholderId,
		});
		completeTurn();
		await showFailedReconnectedTurn(params, error, {
			cutByUpdate: hold === "cut" || hold === "new_version",
		});
	}

	function createAssistantPlaceholder(
		id: string,
		generationDurationMs?: number,
		userIntent?: MessageUserIntent,
		continuesMessageId?: string,
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
			// A resume's reply is a segment that continues the row that asked.
			...(continuesMessageId ? { continuesMessageId } : {}),
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

		// A page that was left sends nothing: the queue went with it (`takeQueuedTurn`).
		if (queuedTurn && !detached) {
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
	 * Retry, as for a failure they watched. When an update cut the reconnect
	 * (`cutByUpdate`: the turn was held until the server came back) the sentence says
	 * that, not that the provider failed.
	 */
	async function showFailedReconnectedTurn(
		params: StartStreamParams,
		error: Error,
		options: { cutByUpdate?: boolean } = {},
	) {
		// A resume the page joined with no answer in hand (a reload during it) is no
		// message that failed. Its reply follows the asking row, never the person's
		// message, so the send's judge below could not read it as landed even when the
		// server finished it, and the message already on screen would be drawn a second
		// time, with a Retry that the server refuses while a question waits. The chat is
		// read back, and the page reads the question again: the server has it back as
		// waiting (the card returns with its error line) or as answered. What was queued
		// returns to the composer, since no new turn may start under a question that may
		// be open. (A resume whose answer this runtime holds never gets here: it is
		// settled as the answer's, `settleAnswerThatDidNotLand`.)
		if (params.continuesMessageId) {
			await loadChatHoldingTheTurn();
			if (detached || !isTurnConversationActive(params.turnConversationId)) {
				return;
			}
			adapters.refreshQuestions?.();
			if (takeQueuedContextCompression()) {
				void adapters.runManualContextCompression();
			}
			restoreQueuedTurnToDraft();
			return;
		}
		// What the page holds now is what the chat it is about to load is compared with.
		const heldIds = new Set(
			adapters.getMessages().map((message) => message.id),
		);
		await loadChatHoldingTheTurn();
		if (detached || !isTurnConversationActive(params.turnConversationId))
			return;
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
		adapters.setSendError(
			options.cutByUpdate
				? "chat.updateCutReply"
				: adapters.toFriendlySendError(error),
		);
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

		// The first event of an answer's stream is the resume running: the server took
		// the answer up (`answerAccepted`, once).
		const noteResumeRunning = () => {
			if (params.answer) reportAnswerAccepted(params.answer);
		};

		return {
			onToken(chunk) {
				hasStreamedContent = true;
				if (!isTurnConversationActive(params.turnConversationId)) return;
				noteResumeRunning();
				setPhase("generating", params.placeholderId);
				tokenBuffer.append(chunk);
			},
			onThinking(chunk) {
				hasStreamedContent = true;
				if (!isTurnConversationActive(params.turnConversationId)) return;
				noteResumeRunning();
				setPhase("generating", params.placeholderId);
				thinkingBuffer.append(chunk);
			},
			onToolCall(name, input, status, details) {
				if (!isTurnConversationActive(params.turnConversationId)) return;
				noteResumeRunning();
				setPhase("generating", params.placeholderId);
				adapters.applyMessageListEvent({
					type: "applyToolCall",
					placeholderId: params.placeholderId,
					name,
					input,
					status,
					details,
				});
				// An ask is recorded as a question on the server when its call is done:
				// the card is drawn from those rows, so the page reads them again.
				if (isAskToolName(name) && status !== "running") {
					adapters.refreshQuestions?.();
				}
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
				noteResumeRunning();
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

				// An answer stopped before its resume said anything (the transport ends
				// a Stop with no message id, and does not wait for the server's own end):
				// there is no segment to show, and the card has not folded, so the
				// placeholder goes instead of turning into a "Stopped" row. The server is
				// asked to stop the run; the page reads the questions to see where the
				// question stands.
				if (
					params.answer &&
					!params.answer.accepted &&
					metadata?.wasStopped &&
					!metadata.assistantMessageId
				) {
					if (isTurnConversationActive(params.turnConversationId)) {
						endAnswer(params, {
							type: "answerNotSent",
							questionId: params.answer.questionId,
							quiet: true,
						});
					} else {
						completeStaleTurn(params.placeholderId);
					}
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

				// A stream that reached its end ran the resume, even if it said nothing
				// before the end.
				noteResumeRunning();

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

				// "Ask me first": the reply paused to ask the person something, whichever
				// turn this was (a send, a reconnect, a resume that asks again). The
				// segment is finalized above like any turn's end; the reply is not over.
				// What was queued behind it is given back, as when a Stop ends the turn:
				// no new turn starts under an open question.
				const pausedFor = metadata?.waitingQuestionId;
				if (pausedFor) {
					adapters.onAskEvent?.({
						type: "paused",
						questionId: pausedFor,
						// The saved row's id, as the terminal metadata names it, else the id the
						// placeholder's row has now.
						assistantMessageId:
							serverAssistantId ??
							(adapters
								.getMessages()
								.some((message) => message.id === params.placeholderId)
								? params.placeholderId
								: null),
					});
				}

				if (metadata?.wasStopped || pausedFor) {
					if (takeQueuedContextCompression()) {
						void adapters.runManualContextCompression();
					}
					restoreQueuedTurnToDraft();
					return;
				}

				void drainPostTurnQueue();
			},
			onError(error) {
				// Read before anything is awaited: it is what the page knew of the
				// version when this failure was handled (`isNewVersionLive`).
				const versionWasLive = adapters.isNewVersionLive();
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
				if (detached || !isTurnConversationActive(params.turnConversationId)) {
					completeStaleTurn(params.placeholderId);
					return;
				}

				// "Ask me first": a question waits. A new message, a Retry or a regenerate
				// is turned away (a stale page), and an answer that lost the claim to
				// another answer is told so. Neither is a failure to put a sentence on.
				// (An answer is not a message: if its route ever said a question waits, it
				// would be settled below, with an outcome for its card.)
				if (
					!params.isReconnect &&
					!params.answer &&
					isQuestionWaitingRefusal(err)
				) {
					settleRefusedWhileQuestionWaits(params);
					return;
				}
				if (params.answer && isQuestionAlreadyAnswered(err)) {
					endAnswer(params, {
						type: "alreadyAnswered",
						questionId: params.answer.questionId,
					});
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
								params,
							);
						}, delay);
						return;
					}
				}

				// An update, not a full server (ADR-0054): the server is draining
				// for a deploy (its refusal says "draining"), or the proxy answers
				// its maintenance page for the restart. A fresh request refused for
				// that ran nothing, so it waits for the server to come back and is
				// sent again, instead of counting down the three tries below and
				// blaming the capacity or the provider. The bounded count keeps a
				// request the server refuses as an update while its health says it
				// is well from being sent again for ever.
				if (
					!isBackgroundAbort &&
					!params.isReconnect &&
					isServerUpdateRefusal(err) &&
					(params.updateResendCount ?? 0) < AWAIT_UPDATE_MAX_RESENDS
				) {
					holdRefusedRequestForUpdate(params);
					return;
				}

				// D2 (drain + graceful deploy): a *fresh* send (not a reconnect)
				// can also hit a capacity/global_limit rejection — a full server.
				// (A server that is draining ahead of a deploy restart used to land
				// here too; it is an update and waits, above.)
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
							void recoverNetworkDroppedStream(
								params,
								err,
								retryCount + 1,
								versionWasLive,
							);
						}, delay);
						return;
					}
				}

				// "Ask me first": an answer the server did not take up as a running
				// resume: refused, or its request died before the resume streamed, or the
				// update wait and the capacity backoff above ran out. Never the send's
				// judge of what the server holds (a reply after a user message): the
				// resume's stream is joined if one runs, else the card gets the answer
				// back. (A drop after text was recovered above, as a send's is.)
				if (params.answer && !isBackgroundAbort) {
					void settleAnswerThatDidNotLand(params, params.answer, {
						ownsTurn: true,
					});
					return;
				}

				// ADR-0054 — a reply that died before any text, with a failed
				// connection (no status, no code of the server's own): a restart
				// looks like that too, and so does a phone that lost its signal.
				// Before it is put down to the provider the page is asked what the
				// server is doing: if an update cut it, the turn waits for the server
				// and then asks what it holds; if the old process still runs it, its
				// stream is joined; if nothing says an update, this is the failure it
				// always was.
				if (
					!isBackgroundAbort &&
					!params.isReconnect &&
					!hasStreamedContent &&
					!isPendingSkillError &&
					!isForkedHistoryError &&
					isStreamTransportFailure(err)
				) {
					// The stream that failed is nothing to stop: it is let go before the
					// page is asked, and a Stop pressed meanwhile is the question's.
					const deadStream = activeStream;
					activeStream = null;
					void settleReplyThatDiedBeforeContent(
						params,
						err,
						versionWasLive,
						deadStream,
					);
					return;
				}

				// The same for a reconnect that ended on a failed connection, or on
				// the proxy's page: the reload that found the turn running met the
				// restart.
				if (
					!isBackgroundAbort &&
					params.isReconnect &&
					(isStreamTransportFailure(err) || isServerUpdateRefusal(err))
				) {
					const deadStream = activeStream;
					activeStream = null;
					void settleReconnectThatFailed(
						params,
						err,
						versionWasLive,
						deadStream,
					);
					return;
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
					// A resume cut like this may be running on the server, and nothing is
					// known of its answer yet (a look from a hidden tab says little): the
					// answer stays pending, with its row, and the visibility recovery tells
					// the page how it went (`recoverBackgroundInterruptedStream`). It is the
					// latest cut-off stream's: one that is no resume leaves nothing behind.
					// Stashed BEFORE the page is told: a callback that runs the recovery at
					// once reads it in that very call.
					interruptedResume =
						params.answer || params.continuesMessageId
							? {
									answer: params.answer,
									continuesMessageId: params.continuesMessageId,
								}
							: null;
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
		// The same for a page that was left (`detached`): a capacity backoff that was
		// scheduled before it, or a resend that waited for the update, goes nowhere.
		if (detached || !isTurnConversationActive(params.turnConversationId)) {
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
		versionWasLive: boolean,
	) {
		// A recovery that was scheduled before the page was left reconnects nothing
		// from it, and asks nothing of the server.
		if (detached || !isTurnConversationActive(params.turnConversationId)) {
			return;
		}

		const streamId = await adapters.checkForOrphanedStream(
			params.turnConversationId,
		);
		if (detached) return;

		if (!streamId) {
			if (retryCount < 3) {
				adapters.schedule(
					() => {
						void recoverNetworkDroppedStream(
							params,
							originalError,
							retryCount + 1,
							versionWasLive,
						);
					},
					2 ** retryCount * 500,
				);
				return;
			}
			if (!isTurnConversationActive(params.turnConversationId)) {
				return;
			}
			// ADR-0054 — three looks over 3.5 seconds find no stream when the server
			// is restarting, and then the reply would be put down to the provider.
			// If an update cut it the turn waits for the server first, and only then
			// asks what the server holds. If the server is draining its old process
			// is alive and probably still runs the reply: its stream is looked for
			// once more and joined, with nothing waited for.
			let cutByUpdate = false;
			if (isStreamTransportFailure(originalError)) {
				const hold = await holdTurnWhileServerUpdates({
					placeholderId: params.placeholderId,
					turnConversationId: params.turnConversationId,
					ownsTurn: false,
					versionWasLive,
				});
				if (hold === "abandoned") return;
				if (hold === "draining" || hold === "new_version") {
					// A drain leaves the turn state alone; a new version took it back for
					// this reply (unless a turn has started since: `none`).
					const joined = await joinRunningStreamOfCutReply(
						params,
						hold === "new_version",
					);
					if (joined === "abandoned") {
						completeStaleTurn(params.placeholderId);
						return;
					}
					if (joined === "joined") return;
				}
				cutByUpdate = hold === "cut" || hold === "new_version";
			}
			// No stream to reconnect to does not mean the turn failed: it may have
			// finished meanwhile. The page asks before it shows an error and a Retry
			// for a message the server has answered.
			await settleCutReply(params, originalError, {
				ownsTurn: cutByUpdate,
				cutByUpdate,
			});
			return;
		}

		const bufferInfo = await adapters.getStreamBufferInfo(
			streamId,
			params.turnConversationId,
		);

		if (detached || !isTurnConversationActive(params.turnConversationId)) {
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
			params,
		);
	}

	/** What an Atlas turn is asked with, and how many times it has been sent again after an update. */
	type AtlasTurnParams = {
		payload: NormalChatSendPayload;
		placeholderId: string;
		clientUserMessageId: string | null;
		turnConversationId: string;
		/** The id the server de-duplicates the kickoff by: a turn sent again keeps it, so the job is made once. */
		clientAtlasTurnId?: string;
		updateResendCount?: number;
	};

	async function startAtlasTurn(params: AtlasTurnParams) {
		const clientAtlasTurnId =
			params.clientAtlasTurnId ??
			(params.payload.clientAtlasTurnId?.trim() || adapters.randomId());
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
			// "Ask me first": `/api/chat/send` turns a kickoff away while a question
			// waits, as the stream route turns a message away. A stale page: the words
			// return to the composer with no sentence, and the page reads the questions
			// and the chat again.
			if (isQuestionWaitingRefusal(error)) {
				failAtlasTurn(params, null);
				adapters.onAskEvent?.({ type: "refusedWhileWaiting" });
				return;
			}
			// ADR-0054 — a deploy drains the server, and `/api/chat/send` takes an Atlas
			// turn through that (its job is recovered after the restart); the restart
			// itself is where the proxy answers its own page. The kickoff is
			// de-duplicated by `clientAtlasTurnId`, so a request that waits and is sent
			// again makes the job once, whether or not the first one got through.
			if (
				!detached &&
				isServerUpdateRefusal(error) &&
				(params.updateResendCount ?? 0) < AWAIT_UPDATE_MAX_RESENDS
			) {
				holdAtlasTurnForUpdate({ ...params, clientAtlasTurnId });
				return;
			}
			failAtlasTurn(
				params,
				adapters.toFriendlySendError(
					error instanceof Error ? error : new Error(String(error)),
				),
			);
		}
	}

	/**
	 * An Atlas kickoff that did not start: both bubbles go, the words return to the
	 * composer (with the Atlas mode they were sent in), a message queued behind it
	 * follows them, and the sentence says why, if there is one. There is no Retry: it
	 * would send the words as a plain turn.
	 */
	function failAtlasTurn(params: AtlasTurnParams, sentence: string | null) {
		// A message queued behind the kickoff (the composer queues while it is out, and
		// while it waits for an update) goes back to the composer behind its words.
		giveBackUnsentRequest({
			placeholderId: params.placeholderId,
			clientUserMessageId: params.clientUserMessageId,
			words: params.payload,
			sentence,
		});
	}

	/**
	 * The Atlas kickoff was turned away for the update. It waits like a refused
	 * message and is submitted again, under the same `clientAtlasTurnId`, once the
	 * server says it is up. At the cap, and on Stop, it ends like a kickoff that did
	 * not start (`failAtlasTurn`): the words return to the composer, with the
	 * sentence for the cap and none for Stop.
	 */
	function holdAtlasTurnForUpdate(
		params: AtlasTurnParams & { clientAtlasTurnId: string },
	) {
		const waiting = beginUpdateWait({
			placeholderId: params.placeholderId,
			turnConversationId: params.turnConversationId,
			// The proxy's page is no answer from the app: the kickoff never got through.
			unsentPayload: params.payload,
			onEnd: (end) => {
				if (end === "back") {
					if (detached) return;
					setPhase("preparing", params.placeholderId);
					void startAtlasTurn({
						...params,
						updateResendCount: (params.updateResendCount ?? 0) + 1,
					});
					return;
				}
				failAtlasTurn(
					params,
					end === "timeout" ? "chat.updateStillRunning" : null,
				);
			},
		});
		if (!waiting) completeStaleTurn(params.placeholderId);
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

		// An entry point the page calls: a page that sends is there, and what a
		// `detach()` left behind is over. (The queue's own sends, `drainPostTurnQueue`,
		// are not entry points: they check `detached` and never clear it.)
		detached = false;

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
	 *
	 * Only `retry` calls it, right after it looked at `detached` for the last time:
	 * a resend is not an entry point, and clears nothing.
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
		// An entry point the page calls: it clears `detached` here, before it awaits
		// anything, and looks at it again after the reads.
		detached = false;
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
			running = await findRunningStream(
				turnConversationId,
				STREAM_QUESTION_MAX_MS,
			);
			// The stream says whose message it runs. Another device's message in this
			// chat is not this turn: joining it would clear the error with this message
			// unsent. Retry goes on, to the chat and to the resend, whose capacity
			// backoff handles the rest.
			if (running && isForAnotherMessage(running.bufferInfo, text)) {
				running = null;
			}
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
		// page asked, which can take seconds with the page live, or the page been left.
		if (
			detached ||
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

	/**
	 * The person's answer to a question Alfy asked in the middle of a reply (the card's
	 * pick, its own words, "Up to you", or the X). The server carries the same reply
	 * on from it as a new segment, so the answer streams under a placeholder that
	 * continues the asking row (`continuesMessageId`) and goes to the question's own
	 * route. It runs on what the composer has selected now (model, depth, personality,
	 * connections, the open item), not on what the reply began with.
	 *
	 * A turn like any other while it runs (the composer queues behind it), but not a
	 * send: it adds no bubble, clears no draft, and never touches Retry's memory
	 * (`lastSend`, `canRetry`) or the page's sentence. How it ends is told to the page
	 * as an `AskRuntimeEvent`. An entry point the page calls: it clears `detached`
	 * here, before anything is awaited.
	 */
	async function answerQuestion(p: {
		questionId: string;
		answer: AskAnswer;
		continuesMessageId: string;
		userMessage: string;
	}): Promise<void> {
		if (
			adapters.isReadOnly() ||
			adapters.isEditOpen() ||
			isSending ||
			adapters.isEditResendPending()
		) {
			// The page raised its card to busy before it handed the answer over, and its
			// own checks passed. A runtime that turns the answer away (a turn it has not
			// let go of, an edit, a sealed chat: the two can disagree for a moment) says
			// so, or the card stays busy until a reload. Quiet: nothing failed, and
			// nothing was sent, so there is no error line.
			adapters.onAskEvent?.({
				type: "answerNotSent",
				questionId: p.questionId,
				quiet: true,
			});
			return;
		}
		detached = false;

		const turnConversationId = adapters.getConversationId();
		beginTurn();
		const placeholderId = adapters.randomId();
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(
				placeholderId,
				undefined,
				undefined,
				p.continuesMessageId,
			),
		});
		startStream({
			// The server finds the person's message by the rows' own links; this is the
			// text the stream is known by, to join it after a drop.
			message: p.userMessage,
			placeholderId,
			clientUserMessageId: null,
			turnConversationId,
			continuesMessageId: p.continuesMessageId,
			answer: { questionId: p.questionId, accepted: false },
			streamOptions: {
				modelId: adapters.getSelectedModel(),
				reasoningDepth: adapters.getReasoningDepth(),
				personalityProfileId: adapters.getPersonalityProfileId(),
				enabledConnectionCapabilities:
					adapters.getEnabledConnectionCapabilities?.(),
				activeDocumentArtifactId: adapters.getActiveDocumentArtifactId(),
				questionAnswer: { questionId: p.questionId, answer: p.answer },
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
		// A turn that waits for an update has no stream: Stop ends the wait, and the
		// turn ends the way the wait's own give-up decides.
		if (updateWait && !updateWait.detached) {
			endUpdateWait(updateWait, "stopped");
			return true;
		}
		// A cut reply whose page is being asked what the server is doing: its stream
		// is gone, so the Stop is recorded for the question to honour, and the run the
		// server may still have is asked to stop.
		if (cutReplyQuestion && !detached) {
			cutReplyQuestion.stopped = true;
			cutReplyQuestion.deadStream?.stop();
			return true;
		}
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
		// A wait does nothing more once the page is going away, but the page may
		// still take its words (`takeWaitingRequest`).
		if (updateWait) updateWait.detached = true;
		// And nothing that is still out (a refusal, a cut reply, a question) starts a
		// wait, a resend or a sign for the shell from here.
		detached = true;
		cutReplyQuestion = null;
		phase = "idle";
		activePlaceholderId = null;
		emitState();
	}

	/**
	 * Hands the request that waits for an update to the caller and ends the wait:
	 * nothing is sent. For a page that is being left, whose words would otherwise go
	 * with the wait (`reset`, a page that is destroyed); the caller saves them in the
	 * draft of the chat they were typed in, ahead of the queued message
	 * (`takeQueuedTurn`), which was typed after them. Null when nothing waits, and
	 * when what waits is a request the server holds (a regenerate) or a reply that an
	 * update cut: there are no words to keep.
	 */
	function takeWaitingRequest(): NormalChatSendPayload | null {
		const wait = updateWait;
		if (!wait) return null;
		dropUpdateWait();
		return wait.unsentPayload ? cloneSendPayload(wait.unsentPayload) : null;
	}

	function reset() {
		dropUpdateWait();
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
		interruptedResume = null;
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
		// The stream this one takes over from, when that one carried a resume: its
		// answer and its row go on. With none, the reply still continues the row the
		// page says it is answering (a reload during a resume joins its stream with no
		// answer in hand).
		takenOverFrom?: ResumeContext,
	) {
		// Not an entry point: the page's reconnect is `checkForOrphanedStreamOnMount`,
		// and everything else that gets here (the recoveries, a Retry that joins, the
		// capacity backoff) is a turn's own work, which starts nothing for a page that
		// was left.
		if (!canStartTurnIn(turnConversationId)) return false;

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
		const continuesMessageId =
			takenOverFrom?.continuesMessageId ??
			adapters.getAnsweringQuestionMessageId?.() ??
			undefined;
		adapters.applyMessageListEvent({
			type: "appendAssistantPlaceholder",
			placeholder: createAssistantPlaceholder(
				placeholderId,
				replayElapsedMs,
				undefined,
				continuesMessageId,
			),
		});

		startStream({
			message: userMessage || "",
			placeholderId,
			clientUserMessageId,
			turnConversationId,
			continuesMessageId,
			answer: takenOverFrom?.answer,
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
		maxMs?: number,
	): Promise<{ streamId: string; bufferInfo: StreamBufferInfo | null } | null> {
		// With `maxMs` each question is bounded, and no answer is no answer: no stream,
		// or, once a stream is known, no word about its message.
		const ask = <T>(question: Promise<T>) =>
			maxMs === undefined ? question : answerWithin(question, maxMs);
		const streamId = await ask(adapters.checkForOrphanedStream(conversationId));
		if (!streamId) return null;
		return {
			streamId,
			bufferInfo: await ask(
				adapters.getStreamBufferInfo(streamId, conversationId),
			),
		};
	}

	/**
	 * What `question` answers, or null when it fails or has not answered within
	 * `maxMs`: a stalled connection must not hold a press for as long as the browser
	 * takes to give up. The clock is the runtime's own (`adapters.schedule`), and the
	 * question is left to finish.
	 */
	function answerWithin<T>(
		question: Promise<T>,
		maxMs: number,
	): Promise<T | null> {
		return new Promise<T | null>((resolve) => {
			adapters.schedule(() => resolve(null), maxMs);
			question.then(resolve, () => resolve(null));
		});
	}

	/**
	 * Joins a running stream: its replay goes into a placeholder, under the bubble that
	 * is on screen, which is the one whose text is `userMessage`. `takenOverFrom` is
	 * the resume it takes over from, if the one that was cut off carried one.
	 */
	function joinRunningStream(
		running: { streamId: string; bufferInfo: StreamBufferInfo | null },
		userMessage: string,
		turnConversationId: string = adapters.getConversationId(),
		takenOverFrom?: ResumeContext,
	) {
		const { streamId, bufferInfo } = running;
		return reconnectToOrphanedStream(
			streamId,
			userMessage,
			0,
			bufferInfo?.reasoningDepth,
			bufferInfo?.createdAt ? Date.now() - bufferInfo.createdAt : undefined,
			turnConversationId,
			takenOverFrom,
		);
	}

	/**
	 * The page's reconnect on mount: an entry point, so it clears `detached` before
	 * it awaits anything (the page has just been built; `joinRunningStreamOfChat`
	 * is the same look for the runtime's own callers, which do not).
	 */
	async function checkForOrphanedStreamOnMount() {
		if (isSending || activeStream) {
			return false;
		}
		detached = false;
		return joinRunningStreamOfChat();
	}

	async function joinRunningStreamOfChat(takenOverFrom?: ResumeContext) {
		if (isSending || activeStream) {
			return false;
		}
		const running = await findRunningStream(adapters.getConversationId());
		if (!running) return false;
		return joinRunningStream(
			running,
			running.bufferInfo?.userMessage ?? "",
			undefined,
			takenOverFrom,
		);
	}

	async function recoverBackgroundInterruptedStream() {
		// A resume the browser cut off is still its question's: if the server runs it
		// the stream is joined as that resume (its row goes on, and the answer was
		// taken up); if it does not, the page is told so, quietly, and reads the
		// questions and the chat to learn whether it finished.
		const cutOff = interruptedResume;
		interruptedResume = null;
		const reconnected = await joinRunningStreamOfChat(cutOff ?? undefined);
		if (reconnected) {
			if (cutOff?.answer) reportAnswerAccepted(cutOff.answer);
			return;
		}
		if (cutOff?.answer) {
			adapters.onAskEvent?.({
				type: "answerNotSent",
				questionId: cutOff.answer.questionId,
				quiet: true,
			});
		}
		await adapters.loadPersistedData();
		await drainPostTurnQueue();
	}

	return {
		snapshot,
		send,
		retry,
		answerQuestion,
		queue,
		clearQueuedTurn,
		takeQueuedTurn,
		takeWaitingRequest,
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

/**
 * Whether a running stream is for a message other than `text` (trimmed). A stream
 * that says nothing of its message is taken for this one: the status said a turn
 * runs for this chat, and one the person's own connection dropped over is the likely
 * one.
 */
function isForAnotherMessage(
	bufferInfo: StreamBufferInfo | null,
	text: string,
): boolean {
	const streamMessage = bufferInfo?.userMessage?.trim();
	return Boolean(streamMessage) && streamMessage !== text.trim();
}

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

/**
 * The words of a new message the server never got, or null for a request it knows
 * (a regenerate, a Retry of a message it holds without a reply) and for an answer,
 * which carries no message. They are the page's to give back when the request is
 * turned away or stopped.
 */
function payloadTheServerNeverGot(
	params: StartStreamParams,
): NormalChatSendPayload | null {
	return !params.streamOptions.retryAssistantMessageId
		? (params.payload ?? null)
		: null;
}

/** Whether the server turned the request away with this status and code (a refusal reaches `onError` with both: `streamChat`'s error, and an `ApiError`). */
function isRefusedWith(error: unknown, status: number, code: string): boolean {
	if (!error || typeof error !== "object") return false;
	const refusal = error as { status?: unknown; code?: unknown };
	return refusal.status === status && refusal.code === code;
}

/** A new message, a Retry or a regenerate, turned away because a question waits for its answer. */
function isQuestionWaitingRefusal(error: unknown): boolean {
	return isRefusedWith(error, 409, "QUESTION_WAITING");
}

/** An answer that lost the claim on its question to another answer. */
function isQuestionAlreadyAnswered(error: unknown): boolean {
	return isRefusedWith(error, 409, "QUESTION_ALREADY_ANSWERED");
}
