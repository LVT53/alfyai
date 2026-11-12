import type { ChatTurnOrigin } from "$lib/chat-turn-origin";
import type { ReasoningDepth } from "$lib/reasoning-depth-types";
import {
	recordSkillUseActivityEvent,
	recordToolCallActivityEvents,
	recordTurnOriginActivityEvent,
} from "$lib/server/services/activity-events";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import {
	assignPendingWritesToAssistantMessage,
	listPendingWritesForConversation,
} from "$lib/server/services/connections/pending-writes";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import {
	ARTIFACT_EXPORT_JOB_ORIGIN,
	type ChatGeneratedFile,
} from "$lib/server/services/file-production/types";
import type { SupportedLanguage } from "$lib/server/services/language";
import {
	createMessage,
	updateAssistantToolCallResult,
} from "$lib/server/services/messages";
import type {
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/server/services/messages-types";
import type { UserPicturesMetadata } from "$lib/shared/artifacts/image-body";
import { ASK_USER_TOOL_NAME } from "$lib/shared/ask-user";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import type {
	NormalChatCompletion,
	NormalChatFinalizationFailure,
} from "$lib/shared/normal-chat-completion";
import { compactNormalChatOutputEvents } from "$lib/shared/normal-chat-output";
import { isFileProductionToolName } from "$lib/utils/tool-calls";
import { wasActiveChatStreamStopRequested } from "./active-streams";
import type { AskResumeInput } from "./ask-capture";
import {
	type AskResumeCapture,
	settleAskQuestion,
	stampAskQuestion,
} from "./ask-questions";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
// The ordered post-turn side effects live in ./finalize-steps as their own
// mockable module boundary. finalizeChatTurn is the single fan-out point that
// calls them in one fixed sequence; tests seam by mocking ./finalize-steps
// rather than injecting overrides through the public params.
import {
	nameConversationAfterTurn,
	persistAssistantEvidence,
	persistAssistantTurnState,
	persistUserTurnAttachments,
	recordAssistantTurnAnalytics,
	runPostTurnTasks,
} from "./finalize-steps";
import {
	type ChatTurnRoute,
	type PersistAssistantEvidenceParams,
	type PersistAssistantTurnStateParams,
	type PersistAssistantTurnStateResult,
	type RunPostTurnTasksParams,
	turnLogPrefix,
	type WorkingSetItem,
} from "./types";

type MessageCreationMode = "strict" | "best_effort";
type CreateMessageFn = typeof createMessage;

type FileProductionJobSummary = {
	id: string;
	assistantMessageId?: string | null;
	origin?: string;
	files?: Array<{ id: string }>;
};

type PendingWriteSummary = { id: string };

export type GeneratedOutputReconciliationParams = {
	// Raw server-recorded producer receipts for this occurrence only, before
	// evidence filtering. No chronology/global-conversation delta grants ownership.
	fileProductionToolCalls?: ToolCallEntry[];
	getFileProductionJobs?: (
		userId: string,
		conversationId: string,
	) => Promise<FileProductionJobSummary[]>;
	assignFileProductionJobsToAssistantMessage?: (
		userId: string,
		conversationId: string,
		assistantMessageId: string,
		jobIds: string[],
	) => Promise<void>;
	syncGeneratedFilesToMemory?: typeof syncGeneratedFilesToMemory;
	getChatFilesForAssistantMessage?: typeof getChatFilesForAssistantMessage;
	// Pending writes keep their own "snapshot at turn start, diff at finalize"
	// mechanism, applied to
	// connection_pending_writes: a pending write is created synchronously
	// by a write tool mid-turn (createPendingWrite already has
	// conversationId via ctx — see normal-chat-tools/*.ts), but its
	// assistantMessageId is only knowable once THIS turn's assistant
	// message has been persisted, right here. Optional/undefined is a
	// no-op (existing callers that don't pass it skip pending-write
	// reconciliation entirely — no new required param on any caller).
	pendingWriteIdsAtStart?: Set<string>;
	getPendingWrites?: (
		userId: string,
		conversationId: string,
	) => Promise<PendingWriteSummary[]>;
	assignPendingWritesToAssistantMessage?: (
		userId: string,
		conversationId: string,
		assistantMessageId: string,
		pendingWriteIds: string[],
	) => Promise<void>;
};

export class FileAssociationFinalizationError extends Error {
	readonly #finalContent: string;
	get finalContent(): string {
		return this.#finalContent;
	}
	constructor(
		cause: unknown,
		readonly assistantMessageId: string,
		readonly normalChatFinalization: NormalChatFinalizationFailure,
		readonly modelCompletion: NormalChatCompletion | undefined,
		finalContent: string,
	) {
		super(cause instanceof Error ? cause.message : "File association failed", {
			cause,
		});
		// Keep canonical answer bytes available to the authenticated receipt,
		// without exposing them when the error itself is logged.
		this.#finalContent = finalContent;
	}
}

// The durable identities a completed turn hands back once its user/assistant
// messages are persisted. This is all a stream transport needs to flush its
// terminal receipt — see onDurableReceiptReady below. finalize only invokes
// onDurableReceiptReady after validating the assistant identity and linking
// this turn's file jobs and produced files, so
// assistantMessage is guaranteed present here (unlike the send-path result,
// which stays defensively optional — see FinalizeChatTurnResult).
export type FinalizeChatTurnDurableReceipt = {
	userMessage: { id: string } | undefined;
	assistantMessage: { id: string };
	/**
	 * The question this reply paused on, set only when the stamp changed a row:
	 * the terminal frame names it for the page, so it never names one that is not
	 * tied to this message.
	 */
	waitingQuestionId?: string;
};

export type FinalizeChatTurnParams = {
	/** Cancellation fences new writes; an assistant commit already begun must settle its truthful receipt. */
	persistenceSignal?: AbortSignal;
	onPersistenceStarted?: () => void;
	completionTurn?: import("./prepared-normal-chat-turn").CompletionReceipt;
	// The turn kinds that actually exist (F1) — every other former mode
	// boolean (persistAssistantMessage, persistUserAttachmentsBeforeAssistantMessage,
	// waitForEvidenceBeforePostTurnTasks, deferPostTurnProjection, and the
	// strict/best_effort persistence mode) is fully determined by turnKind;
	// see the derivations at the top of finalizeChatTurn below. Only genuine
	// per-turn facts that vary independently of the kind stay as their own
	// params: persistUserMessage (a stream reconnect may have already
	// persisted it), persistTurnState (a stopped stream skips the heavier
	// projection), and skipAssistantProseMemoryIntake (an orthogonal
	// per-turn override).
	turnKind: ChatTurnRoute;
	streamId?: string | null;
	userId: string;
	conversationId: string;
	userMessageContent: string;
	persistUserMessage: boolean;
	normalizedMessage: string;
	upstreamMessage: string;
	assistantResponse: string;
	assistantThinking?: string;
	serverSegments?: ThinkingSegment[];
	assistantMetadata: Record<string, unknown>;
	reasoningDepth?: ReasoningDepth;
	depthMetadata?: DepthMetadata;
	attachmentIds: string[];
	// What the user message keeps of the pictures beside its uploads (card
	// pictures, the open picture, the marked copy): ids and names, never pixels.
	userPictures?: UserPicturesMetadata;
	activeDocumentArtifactId: string | null;
	contextStatus: PersistAssistantTurnStateParams["contextStatus"];
	initialTaskState: PersistAssistantTurnStateParams["initialTaskState"];
	initialContextDebug: PersistAssistantTurnStateParams["initialContextDebug"];
	analytics: PersistAssistantTurnStateParams["analytics"];
	assistantMirrorContent: string;
	maintenanceReason: RunPostTurnTasksParams["maintenanceReason"];
	startedResetGeneration?: number;
	toolCalls?: PersistAssistantEvidenceParams["toolCalls"];
	contextTraceSections?: PersistAssistantEvidenceParams["contextTraceSections"];
	webCitationAudit?: PersistAssistantEvidenceParams["webCitationAudit"];
	// Analytics overhaul (backend half) — the skill this turn force-applied
	// via a `$` composer selection, resolved at preflight into
	// PreflightedChatTurn.appliedSkill (see chat-turn/types.ts). Recorded as
	// an activity_events "skill_use" row, named after the skill, alongside
	// this turn's tool calls; omitted/null when no skill was force-applied
	// (an on-demand `use_skill` tool call is recorded separately, from
	// params.toolCalls, by recordToolCallActivityEvents itself).
	skillUse?: { displayName: string } | null;
	// Gap 2 — the turn's own origin (ParsedChatTurnRequest.turnOrigin, see
	// $lib/chat-turn-origin.ts). A user-chosen "regenerate" and an
	// "edit_resend" are recorded as activity_events rows alongside this turn's
	// tool calls; omitted (the /api/chat/send path) means an ordinary send.
	turnOrigin?: ChatTurnOrigin;
	persistTurnState?: boolean;
	generatedOutputReconciliation?: GeneratedOutputReconciliationParams;
	// A reply that stopped to ask the person ("Ask me first", `ask_user`): the
	// question the tool wrote mid-turn has no message id yet, so it is tied to the
	// assistant row here, with what the resume needs, before the receipt.
	// `resume` is the other direction: this segment carries a reply on from the
	// person's answer, so the question it answers is settled here (with the claim
	// that won the answer) and the answer is written into the ask call of the row
	// that asked, before the receipt and before a question this segment asks again
	// is tied to its row.
	ask?: {
		pause?: { questionId: string; capture: AskResumeCapture };
		resume?: Pick<
			AskResumeInput,
			| "questionId"
			| "claim"
			| "askedMessageId"
			| "askToolCallId"
			| "answerDigest"
		>;
	};
	skipAssistantProseMemoryIntake?: boolean;
	// The language of the conversation for the person, named after the reply
	// (chat-turn/reply-language.ts), handed to the post-turn tail so the rail
	// headline is written in it.
	responseLanguage: SupportedLanguage;
	// Stream-only. finalizeChatTurn owns scheduling every post-turn side
	// effect itself (ADR-0015) — it never hands a caller a promise or a
	// task-starting function to manage. For a deferred (stream) turn, the
	// caller instead supplies this hook: finalize invokes and awaits it
	// exactly once, right after the durable message identities are known and
	// before any background projection begins, so the stream transport can
	// flush its terminal frames at the correct moment. Nothing is returned
	// for the caller to separately await or schedule.
	onDurableReceiptReady?: (
		receipt: FinalizeChatTurnDurableReceipt,
	) => void | Promise<void>;
};

export type FinalizeChatTurnResult = {
	userMessage: { id: string } | undefined;
	assistantMessage: { id: string } | undefined;
	turnState: PersistAssistantTurnStateResult | null;
	attachedArtifacts?: WorkingSetItem[];
	generatedFiles: ChatGeneratedFile[];
};

async function createTurnMessage(
	params: {
		conversationId: string;
		role: "user" | "assistant";
		content: string;
		thinking?: string;
		serverSegments?: ThinkingSegment[];
		metadata?: Record<string, unknown>;
	},
	mode: MessageCreationMode,
	createMessageImpl: CreateMessageFn,
): Promise<{ id: string } | undefined> {
	const create =
		params.role === "user"
			? params.metadata
				? createMessageImpl(
						params.conversationId,
						params.role,
						params.content,
						undefined,
						undefined,
						params.metadata,
					)
				: createMessageImpl(params.conversationId, params.role, params.content)
			: createMessageImpl(
					params.conversationId,
					params.role,
					params.content,
					params.thinking,
					params.serverSegments,
					params.metadata,
				);

	return mode === "best_effort" ? create.catch(() => undefined) : create;
}

// Durable association is part of saving the turn, not a best-effort projection.
// Failures propagate so no successful receipt can outrun the linked file rows.
async function reconcileGeneratedOutputsForAssistantMessage(params: {
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	reconciliation: GeneratedOutputReconciliationParams;
}): Promise<{ generatedFiles: ChatGeneratedFile[]; fileIds: string[] }> {
	const exactIds = new Set<string>();
	for (const call of params.reconciliation.fileProductionToolCalls ?? []) {
		if (!isFileProductionToolName(call.name)) continue;
		const id = call.metadata?.jobId;
		if (typeof id === "string" && id.trim()) exactIds.add(id.trim());
		else if (
			call.metadata?.ok === true ||
			call.metadata?.jobStatus === "succeeded"
		) {
			throw new Error("Successful file production has no trusted job identity");
		}
	}
	if (exactIds.size === 0) return { generatedFiles: [], fileIds: [] };
	const getJobs =
		params.reconciliation.getFileProductionJobs ??
		listConversationFileProductionJobs;
	const assignJobs =
		params.reconciliation.assignFileProductionJobsToAssistantMessage ??
		assignFileProductionJobsToAssistantMessage;
	const getFiles =
		params.reconciliation.getChatFilesForAssistantMessage ??
		getChatFilesForAssistantMessage;
	const jobs = await getJobs(params.userId, params.conversationId);
	const newJobs = jobs.filter(
		(job) =>
			exactIds.has(job.id) &&
			(!("origin" in job) || job.origin !== ARTIFACT_EXPORT_JOB_ORIGIN) &&
			(!job.assistantMessageId ||
				job.assistantMessageId === params.assistantMessageId),
	);
	if (newJobs.length !== exactIds.size)
		throw new Error("Produced job is unavailable for this turn");
	const jobIds = newJobs.map((job) => job.id);
	if (jobIds.length > 0) {
		await assignJobs(
			params.userId,
			params.conversationId,
			params.assistantMessageId,
			jobIds,
		);
	}
	const generatedFiles = (
		await getFiles(params.conversationId, params.assistantMessageId)
	).map(toPublicGeneratedFile);
	return { generatedFiles, fileIds: generatedFiles.map((file) => file.id) };
}

// Issue 7.5 — sibling reconciliation to the file-production one above,
// applied to connection_pending_writes. Its own step, run before the turn's
// receipt goes out and not with the projection: the page reads its pending
// writes the moment the turn ends, and a row still unstamped then belongs to no
// message, so its card is drawn nowhere until a reload. Best-effort all the
// same: this is a backfill for card UI, not a correctness-critical write path
// (the write itself, and its confirm/cancel state, lives entirely in
// connection_pending_writes independent of whether this stamp ever lands).
async function reconcilePendingWritesForAssistantMessage(params: {
	turnKind: ChatTurnRoute;
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	reconciliation: GeneratedOutputReconciliationParams;
}): Promise<void> {
	const pendingWriteIdsAtStart = params.reconciliation.pendingWriteIdsAtStart;
	if (!pendingWriteIdsAtStart) {
		return;
	}

	const logPrefix = turnLogPrefix(params.turnKind);
	const getPendingWritesImpl =
		params.reconciliation.getPendingWrites ?? listPendingWritesForConversation;
	const assignPendingWritesImpl =
		params.reconciliation.assignPendingWritesToAssistantMessage ??
		assignPendingWritesToAssistantMessage;

	try {
		const pendingWrites = await getPendingWritesImpl(
			params.userId,
			params.conversationId,
		);
		const newPendingWriteIds = pendingWrites
			.filter((write) => !pendingWriteIdsAtStart.has(write.id))
			.map((write) => write.id);

		if (newPendingWriteIds.length > 0) {
			await assignPendingWritesImpl(
				params.userId,
				params.conversationId,
				params.assistantMessageId,
				newPendingWriteIds,
			);
		}
	} catch (error) {
		console.error(`${logPrefix} Failed to reconcile pending writes`, {
			conversationId: params.conversationId,
			assistantMessageId: params.assistantMessageId,
			error,
		});
	}
}

// The stamp of a reply that paused to ask: its question (written by the tool
// mid-turn, with no message id) is tied to the assistant row, in the same UPDATE
// that keeps the capture the resume starts from. A step of its own before the
// receipt, beside the pending-write one and for the same reason: the page reads
// its questions the moment the terminal frame lands, and a question without a
// message is drawn on no message. It cannot fail a turn: a stamp that throws is
// logged and names no question, and the turn is saved all the same (the
// orchestrator discards the question it never stamped). Answers the question's id
// only when the stamp changed a row.
async function stampPausedAskQuestion(params: {
	turnKind: ChatTurnRoute;
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	pause: { questionId: string; capture: AskResumeCapture };
}): Promise<string | undefined> {
	try {
		const stamped = await stampAskQuestion({
			userId: params.userId,
			questionId: params.pause.questionId,
			assistantMessageId: params.assistantMessageId,
			capture: params.pause.capture,
		});
		return stamped ? params.pause.questionId : undefined;
	} catch (error) {
		console.error(
			`${turnLogPrefix(params.turnKind)} Failed to stamp the paused question`,
			{
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				questionId: params.pause.questionId,
				error,
			},
		);
		return undefined;
	}
}

// The ending of the question a saved segment answers: the question is settled
// with the claim that won its answer, and the answer goes into the ask call of the
// row that asked (until now it read that the reply paused). A step of its own
// before the receipt, beside the stamp and for the same reason: the page reads its
// questions when the terminal frame lands, and a card must not come back for a
// question the reply has answered. Neither can fail a turn, and neither blocks
// the other: a failure is logged and the turn is saved all the same. A question
// left answering with no live resume reads as waiting (ask-questions.ts), so a
// settle that never happened costs a card the person can answer again, not a chat
// that refuses messages.
async function settleAnsweredAskQuestion(params: {
	turnKind: ChatTurnRoute;
	userId: string;
	conversationId: string;
	resume: NonNullable<NonNullable<FinalizeChatTurnParams["ask"]>["resume"]>;
}): Promise<void> {
	const { resume } = params;
	const logPrefix = turnLogPrefix(params.turnKind);
	try {
		const settled = await settleAskQuestion({
			userId: params.userId,
			questionId: resume.questionId,
			claim: resume.claim,
		});
		if (settled === null) {
			console.warn(
				`${logPrefix} The answered question was not settled: its claim is no longer live`,
				{
					conversationId: params.conversationId,
					questionId: resume.questionId,
				},
			);
		}
	} catch (error) {
		console.error(`${logPrefix} Failed to settle the answered question`, {
			conversationId: params.conversationId,
			questionId: resume.questionId,
			error,
		});
	}
	try {
		// The ask's call is named by its id, its tool and its question: a provider
		// may reuse the id for another tool's call in the same row, or for a card
		// the tool refused, and neither is the call that paused the reply.
		const written = await updateAssistantToolCallResult({
			conversationId: params.conversationId,
			messageId: resume.askedMessageId,
			callId: resume.askToolCallId,
			toolName: ASK_USER_TOOL_NAME,
			questionId: resume.questionId,
			...resume.answerDigest,
		});
		if (!written) {
			console.warn(
				`${logPrefix} The answer was not written into the ask call: the row or the call is gone`,
				{
					conversationId: params.conversationId,
					messageId: resume.askedMessageId,
					callId: resume.askToolCallId,
				},
			);
		}
	} catch (error) {
		console.error(
			`${logPrefix} Failed to write the answer into the ask call of the row that asked`,
			{
				conversationId: params.conversationId,
				messageId: resume.askedMessageId,
				callId: resume.askToolCallId,
				error,
			},
		);
	}
}

function toPublicGeneratedFile(file: ChatGeneratedFile): ChatGeneratedFile {
	return {
		id: file.id,
		conversationId: file.conversationId,
		assistantMessageId: file.assistantMessageId ?? null,
		artifactId: file.artifactId ?? null,
		documentFamilyId: file.documentFamilyId ?? null,
		documentFamilyStatus: file.documentFamilyStatus ?? null,
		documentLabel: file.documentLabel ?? null,
		documentRole: file.documentRole ?? null,
		versionNumber: file.versionNumber ?? null,
		originConversationId: file.originConversationId ?? null,
		originAssistantMessageId: file.originAssistantMessageId ?? null,
		sourceChatFileId: file.sourceChatFileId ?? null,
		filename: file.filename,
		mimeType: file.mimeType,
		sizeBytes: file.sizeBytes,
		createdAt: file.createdAt,
	};
}

// A stream turn's background projection races against a single tick so a
// fast-failing (or fast-succeeding) projection is observable to callers that
// simply `await finalizeChatTurn(...)` without forcing every stream turn to
// block on the full post-turn tail (memory judge, maintenance, ...).
function waitOneTick(): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, 0);
	});
}

/**
 * The instruction offers this turn made, lifted off the tool calls that made
 * them (Slice F). Refusals record `null`, which is why this tests the value
 * rather than the tool's name: only an offer carries one.
 *
 * Exported because the stream's terminal frame has to carry the same offers
 * the message is persisted with (stream-completion.ts), and two collectors
 * would be two chances to disagree about what this turn offered.
 */
export function collectInstructionSuggestions(
	toolCalls: FinalizeChatTurnParams["toolCalls"],
): InstructionSuggestion[] {
	return (toolCalls ?? []).flatMap((toolCall) =>
		toolCall.instructionSuggestion ? [toolCall.instructionSuggestion] : [],
	);
}

export async function finalizeChatTurn(
	params: FinalizeChatTurnParams,
): Promise<FinalizeChatTurnResult> {
	params.persistenceSignal?.throwIfAborted();
	const snapshot = params.completionTurn?.getSnapshot();
	if (params.completionTurn)
		params = {
			...params,
			analytics: params.analytics
				? {
						...params.analytics,
						turnSegmentId: params.completionTurn.segmentId,
					}
				: params.analytics,
			assistantMetadata: {
				...params.assistantMetadata,
				...(snapshot
					? {
							normalChatOutput: {
								version: 1,
								events: compactNormalChatOutputEvents(
									snapshot.events.filter(
										(event) => event.segmentId === snapshot.segmentId,
									),
								),
							},
						}
					: {}),
			},
		};
	const logPrefix = turnLogPrefix(params.turnKind);
	const isStream = params.turnKind === "stream";
	// Every former independently-settable mode boolean besides
	// persistTurnState now derives from the turn kind: send persists
	// attachments before the assistant message and runs its post-turn
	// projection eagerly; stream persists attachments after and defers the full
	// projection until onDurableReceiptReady has run.
	const mode: MessageCreationMode = params.completionTurn
		? "strict"
		: isStream
			? "best_effort"
			: "strict";
	const persistUserAttachmentsBeforeAssistantMessage = !isStream;
	const waitForEvidenceBeforePostTurnTasks = isStream;
	const shouldPersistTurnState = params.persistTurnState ?? true;
	let attachedArtifacts: WorkingSetItem[] | undefined;
	let attachmentTask: Promise<WorkingSetItem[] | undefined> =
		Promise.resolve(undefined);

	const userMessage = params.persistUserMessage
		? await createTurnMessage(
				{
					conversationId: params.conversationId,
					role: "user",
					content: params.userMessageContent,
					...(params.userPictures
						? { metadata: { pictures: params.userPictures } }
						: {}),
				},
				mode,
				createMessage,
			)
		: undefined;

	params.persistenceSignal?.throwIfAborted();
	if (
		persistUserAttachmentsBeforeAssistantMessage &&
		userMessage &&
		params.attachmentIds.length > 0
	) {
		attachedArtifacts = await persistUserTurnAttachments({
			userId: params.userId,
			conversationId: params.conversationId,
			messageId: userMessage.id,
			normalizedMessage: params.normalizedMessage,
			attachmentIds: params.attachmentIds,
		});
	}

	const depthMetadata = withDepthMetadataModelInfo(
		(params.assistantMetadata.depthMetadata as DepthMetadata | undefined) ??
			params.depthMetadata ??
			buildBaselineDepthMetadata({
				reasoningDepth: params.reasoningDepth,
				modelId: params.analytics?.model,
				modelDisplayName:
					typeof params.assistantMetadata.modelDisplayName === "string"
						? params.assistantMetadata.modelDisplayName
						: params.analytics?.modelDisplayName,
				providerDisplayName:
					typeof params.assistantMetadata.providerDisplayName === "string"
						? params.assistantMetadata.providerDisplayName
						: null,
			}),
		{
			modelId: params.analytics?.model,
			modelDisplayName:
				typeof params.assistantMetadata.modelDisplayName === "string"
					? params.assistantMetadata.modelDisplayName
					: params.analytics?.modelDisplayName,
			providerDisplayName:
				typeof params.assistantMetadata.providerDisplayName === "string"
					? params.assistantMetadata.providerDisplayName
					: null,
		},
	);
	// Slice F — the instruction offers this turn made. They ride the turn's
	// tool calls because the assistant message does not exist while
	// `suggest_instruction` runs, so this is the first place that can persist
	// them; deriving them here (rather than in each caller) is what keeps the
	// send, stream and retry paths from having to remember to. A turn that
	// offered nothing gets no key at all — `[]` would be a record saying an
	// offer was made and it was nothing.
	//
	// One turn asks once: when the turn also proposes a skill draft, the Skill
	// Draft Card is the thing to review, so the standing-instruction offer is
	// dropped instead of persisted beside it (or in its place).
	const skillDrafts = params.assistantMetadata.skillDrafts;
	const instructionSuggestions =
		Array.isArray(skillDrafts) && skillDrafts.length > 0
			? []
			: collectInstructionSuggestions(params.toolCalls);
	const assistantMetadata = {
		...params.assistantMetadata,
		depthMetadata,
		...(instructionSuggestions.length > 0 ? { instructionSuggestions } : {}),
	};
	// The assistant message is always persisted — no turn kind or caller ever
	// legitimately skips it, so this is no longer a param to thread.
	params.persistenceSignal?.throwIfAborted();
	params.onPersistenceStarted?.();
	const assistantMessage = await createTurnMessage(
		{
			conversationId: params.conversationId,
			role: "assistant",
			content: params.assistantResponse,
			thinking: params.assistantThinking,
			serverSegments: params.serverSegments,
			metadata: assistantMetadata,
		},
		mode,
		createMessage,
	);

	if (assistantMessage && params.generatedOutputReconciliation) {
		await reconcilePendingWritesForAssistantMessage({
			turnKind: params.turnKind,
			userId: params.userId,
			conversationId: params.conversationId,
			assistantMessageId: assistantMessage.id,
			reconciliation: params.generatedOutputReconciliation,
		});
	}

	if (assistantMessage && params.ask?.resume) {
		await settleAnsweredAskQuestion({
			turnKind: params.turnKind,
			userId: params.userId,
			conversationId: params.conversationId,
			resume: params.ask.resume,
		});
	}

	const waitingQuestionId =
		assistantMessage && params.ask?.pause
			? await stampPausedAskQuestion({
					turnKind: params.turnKind,
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: assistantMessage.id,
					pause: params.ask.pause,
				})
			: undefined;

	if (
		params.completionTurn &&
		snapshot?.completion?.outcome === "paused" &&
		!params.assistantMetadata.wasStopped &&
		!waitingQuestionId
	)
		throw new Error("Paused turn capture could not be persisted");
	let reconciledOutputs: Awaited<
		ReturnType<typeof reconcileGeneratedOutputsForAssistantMessage>
	> | null = null;
	try {
		if (assistantMessage && params.generatedOutputReconciliation) {
			reconciledOutputs = await reconcileGeneratedOutputsForAssistantMessage({
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage.id,
				reconciliation: params.generatedOutputReconciliation,
			});
		}
	} catch (error) {
		if (!assistantMessage) throw error;
		let marker: NormalChatFinalizationFailure;
		try {
			const { recordFileAssociationFailure } = await import("./turn-ledger");
			const trackedSegmentId = params.completionTurn?.segmentId;
			if (
				trackedSegmentId &&
				(!snapshot?.turnId || snapshot.segmentId !== trackedSegmentId)
			) {
				throw new Error("Missing or mismatched tracked finalization snapshot");
			}
			marker = recordFileAssociationFailure({
				userId: params.userId,
				conversationId: params.conversationId,
				messageId: assistantMessage.id,
				wasStopped:
					params.assistantMetadata.wasStopped === true ||
					snapshot?.completion?.outcome === "stopped" ||
					wasActiveChatStreamStopRequested({
						streamId: params.streamId,
						userId: params.userId,
					}),
				...(trackedSegmentId && snapshot
					? {
							mode: "tracked",
							segmentId: trackedSegmentId,
							turnId: snapshot.turnId,
						}
					: { mode: "untracked" }),
			});
		} catch (recordError) {
			// Keep the actual association error primary if storage also fails.
			console.error(`${logPrefix} Could not record file-association failure`, {
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage.id,
				error: recordError,
			});
			throw error;
		}
		throw new FileAssociationFinalizationError(
			error,
			assistantMessage.id,
			marker,
			snapshot?.completion,
			params.assistantResponse,
		);
	}
	await params.completionTurn?.finish(
		assistantMessage?.id,
		params.analytics
			? {
					firstByteMs: params.analytics.firstByteMs,
					firstThinkingMs: params.analytics.firstThinkingMs,
					firstTokenMs: params.analytics.firstTokenMs,
					generationTimeMs: params.analytics.generationTimeMs,
				}
			: undefined,
	);

	if (
		!persistUserAttachmentsBeforeAssistantMessage &&
		userMessage &&
		params.attachmentIds.length > 0
	) {
		attachmentTask = persistUserTurnAttachments({
			userId: params.userId,
			conversationId: params.conversationId,
			messageId: userMessage.id,
			normalizedMessage: params.normalizedMessage,
			attachmentIds: params.attachmentIds,
		})
			.then((artifacts) => {
				attachedArtifacts = artifacts;
				return artifacts;
			})
			.catch(() => undefined);
	}

	// The single ordered post-turn projection, shared by both callers. Each
	// side effect runs exactly once in a fixed order — assistant turn-state →
	// evidence → generated-file memory sync. Durable file association is already
	// complete above, independently of this slower projection.
	// — so a new post-turn side effect is added in exactly one place.
	const runPostTurnProjection = async (): Promise<{
		turnState: PersistAssistantTurnStateResult | null;
		evidenceTask: Promise<void>;
		resolvedAttachedArtifacts: WorkingSetItem[] | undefined;
		generatedFiles: ChatGeneratedFile[];
	}> => {
		// First, so no slower step can hold it up or take it down with it, and
		// before the branch below, so a stopped turn gets its title too.
		if (assistantMessage) {
			nameConversationAfterTurn({
				turnKind: params.turnKind,
				userId: params.userId,
				conversationId: params.conversationId,
			});
		}

		let turnState: PersistAssistantTurnStateResult | null = null;
		if (assistantMessage && shouldPersistTurnState) {
			turnState = await persistAssistantTurnState({
				userId: params.userId,
				conversationId: params.conversationId,
				normalizedMessage: params.normalizedMessage,
				assistantResponse: params.assistantResponse,
				attachmentIds: params.attachmentIds,
				activeDocumentArtifactId: params.activeDocumentArtifactId ?? undefined,
				contextStatus: params.contextStatus,
				initialTaskState: params.initialTaskState,
				initialContextDebug: params.initialContextDebug,
				userMessageId: userMessage?.id ?? null,
				assistantMessageId: assistantMessage.id,
				analytics: params.analytics,
			});
		} else if (assistantMessage) {
			// ADR-0042 amendment — a turn that skips the full turn-state
			// projection (persistTurnState: false, e.g. a stopped stream) still
			// gets whatever stream-timeline marks + usage it reached recorded.
			// This is the same lightweight, side-effect-safe write
			// persistAssistantTurnState uses above, without resurrecting the
			// heavier working-set/task-state/document projection for a turn
			// that was cut short.
			await recordAssistantTurnAnalytics({
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage.id,
				analytics: params.analytics,
			});
		}

		// Analytics overhaul (backend half) — activity_events rows for this
		// turn's tool calls and applied skill, if any. Runs regardless of which
		// branch above ran (a stopped/cut-short turn still recorded whatever
		// tools it actually called). Deliberately NOT awaited: this is
		// best-effort telemetry, never on the critical path — a stream turn
		// races its background projection against a single tick (see
		// waitOneTick below), and blocking here on a real write would just
		// delay persistAssistantEvidence for no benefit.
		if (assistantMessage) {
			void recordToolCallActivityEvents({
				userId: params.userId,
				conversationId: params.conversationId,
				messageId: assistantMessage.id,
				modelId: params.analytics?.model ?? null,
				toolCalls: params.toolCalls,
			}).catch(() => undefined);
			if (params.skillUse?.displayName) {
				void recordSkillUseActivityEvent({
					userId: params.userId,
					conversationId: params.conversationId,
					messageId: assistantMessage.id,
					modelId: params.analytics?.model ?? null,
					displayName: params.skillUse.displayName,
				}).catch(() => undefined);
			}
			// Gap 2 — regenerate and edit-resend are the best proxy this table
			// has for "the answer was wrong". Decided by the turn's own origin,
			// never by persistUserMessage (/api/chat/stream takes
			// skipPersistUserMessage straight from the client body). Recorded
			// here, at completion, so a counted redo always has the assistant
			// message it produced: a regenerate that fails before any answer is
			// persisted is not counted (the user's next Regenerate click is).
			// The row carries the model that answered the redo turn, so the
			// admin model/provider filters attribute it instead of treating it
			// like a model-less client click.
			const turnOriginKind =
				params.turnOrigin === "regenerate" ||
				params.turnOrigin === "edit_resend"
					? params.turnOrigin
					: null;
			if (turnOriginKind) {
				void recordTurnOriginActivityEvent({
					userId: params.userId,
					conversationId: params.conversationId,
					messageId: assistantMessage.id,
					modelId: params.analytics?.model ?? null,
					kind: turnOriginKind,
				}).catch(() => undefined);
			}
		}

		const evidenceTask =
			assistantMessage && turnState
				? persistAssistantEvidence({
						turnKind: params.turnKind,
						userId: params.userId,
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage.id,
						normalizedMessage: params.normalizedMessage,
						assistantResponse: params.assistantResponse,
						attachmentIds: params.attachmentIds,
						taskState: turnState.taskState,
						contextStatus: params.contextStatus ?? null,
						contextDebug: turnState.contextDebug,
						initialTaskState: params.initialTaskState,
						initialContextDebug: params.initialContextDebug,
						contextTraceSections: params.contextTraceSections,
						toolCalls: params.toolCalls,
						webCitationAudit: params.webCitationAudit,
					})
				: Promise.resolve();

		const resolvedAttachedArtifacts =
			attachedArtifacts ?? (await attachmentTask);

		const generatedFiles = reconciledOutputs?.generatedFiles ?? [];
		if (assistantMessage && reconciledOutputs?.fileIds.length) {
			const sync =
				params.generatedOutputReconciliation?.syncGeneratedFilesToMemory ??
				syncGeneratedFilesToMemory;
			void sync({
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage.id,
				assistantResponse: params.assistantResponse,
				fileIds: reconciledOutputs.fileIds,
			}).catch((error) =>
				console.error(
					`${turnLogPrefix(params.turnKind)} Background generated-file memory sync failed`,
					{
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage.id,
						fileIds: reconciledOutputs.fileIds,
						error,
					},
				),
			);
		}

		return {
			turnState,
			evidenceTask,
			resolvedAttachedArtifacts,
			generatedFiles,
		};
	};

	// The tail step: post-turn memory/summary/maintenance work. Kept out of the
	// projection so it can run after the projection's own durable pieces
	// (turn state, evidence) are settled.
	const runPostTurnTail = (
		turnState: PersistAssistantTurnStateResult | null,
		evidenceTask: Promise<void>,
	): Promise<void> => {
		if (!assistantMessage || !turnState) return Promise.resolve();
		const runTask = () =>
			runPostTurnTasks({
				turnKind: params.turnKind,
				userId: params.userId,
				conversationId: params.conversationId,
				upstreamMessage: params.upstreamMessage,
				userMessage: params.normalizedMessage,
				userMessageId: userMessage?.id ?? null,
				assistantResponse: params.assistantResponse,
				assistantMirrorContent: params.assistantMirrorContent,
				assistantMessageId: assistantMessage.id,
				workCapsule: turnState.workCapsule,
				maintenanceReason: params.maintenanceReason,
				startedResetGeneration: params.startedResetGeneration,
				skipAssistantProseMemoryIntake: params.skipAssistantProseMemoryIntake,
				responseLanguage: params.responseLanguage,
				// Fix 1 (data-loss race) — hand the in-flight evidence write to the
				// tail so the rail-summary metadata write awaits it (both share the
				// same unsynchronized metadataJson RMW). On the stream path below the
				// whole tail already runs after evidence resolves, so this is already
				// settled; on the send path the tail runs concurrently, so this
				// barrier is what keeps the rail write from clobbering evidence.
				evidenceWriteBarrier: evidenceTask,
			});
		if (waitForEvidenceBeforePostTurnTasks) {
			return evidenceTask.then(runTask);
		}
		void evidenceTask;
		return runTask();
	};

	if (isStream) {
		// Stream path: finalize owns scheduling the background projection
		// itself. It never hands the caller a promise or a task-starting
		// function — it invokes the caller's onDurableReceiptReady hook once
		// the durable identities are known (so the transport can flush its
		// terminal frames), then races its own background projection against
		// a single tick before resolving, so a fast failure or completion is
		// still observable to a plain `await finalizeChatTurn(...)`.
		if (
			!assistantMessage?.id ||
			(params.persistUserMessage && !userMessage?.id)
		) {
			throw new Error(
				"Stream finalization completed without required message identities",
			);
		}

		const receipt: FinalizeChatTurnDurableReceipt = {
			userMessage,
			assistantMessage,
			...(waitingQuestionId ? { waitingQuestionId } : {}),
		};
		await params.onDurableReceiptReady?.(receipt);

		const deferredProjection = (async () => {
			const projection = await runPostTurnProjection();
			await runPostTurnTail(projection.turnState, projection.evidenceTask);
		})().catch((error) => {
			console.error(`${logPrefix} Deferred post-turn projection failed`, {
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage?.id ?? null,
				error,
			});
		});
		await Promise.race([deferredProjection, waitOneTick()]);

		return {
			userMessage,
			assistantMessage,
			turnState: null,
			attachedArtifacts,
			generatedFiles: [],
		};
	}

	// Send path: run the projection eagerly so the durable completion result
	// (turn state, generated files, evidence) is available in
	// the response, then let the tail (memory/summary/maintenance) continue in
	// the background — finalize starts it itself rather than handing the
	// caller anything to schedule.
	const projection = await runPostTurnProjection();
	runPostTurnTail(projection.turnState, projection.evidenceTask).catch(
		(error) => {
			console.error(`${logPrefix} Deferred post-turn projection failed`, {
				conversationId: params.conversationId,
				assistantMessageId: assistantMessage?.id ?? null,
				error,
			});
		},
	);

	return {
		userMessage,
		assistantMessage,
		turnState: projection.turnState,
		attachedArtifacts: projection.resolvedAttachedArtifacts,
		generatedFiles: projection.generatedFiles,
	};
}
