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
import type { ChatGeneratedFile } from "$lib/server/services/file-production/types";
import { createMessage } from "$lib/server/services/messages";
import type { ThinkingSegment } from "$lib/server/services/messages-types";
import type { InstructionSuggestion } from "$lib/shared/instructions";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
// The ordered post-turn side effects live in ./finalize-steps as their own
// mockable module boundary. finalizeChatTurn is the single fan-out point that
// calls them in one fixed sequence; tests seam by mocking ./finalize-steps
// rather than injecting overrides through the public params.
import {
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
	files?: Array<{ id: string }>;
};

type PendingWriteSummary = { id: string };

export type GeneratedOutputReconciliationParams = {
	fileProductionJobIdsAtStart: Set<string>;
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
	// Issue 7.5 — same "snapshot at turn start, diff at finalize" mechanism
	// as fileProductionJobIdsAtStart above, applied to
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

// The durable identities a completed turn hands back once its user/assistant
// messages are persisted. This is all a stream transport needs to flush its
// terminal receipt — see onDurableReceiptReady below. finalize only invokes
// onDurableReceiptReady after validating the assistant message identity, so
// assistantMessage is guaranteed present here (unlike the send-path result,
// which stays defensively optional — see FinalizeChatTurnResult).
export type FinalizeChatTurnDurableReceipt = {
	userMessage: { id: string } | undefined;
	assistantMessage: { id: string };
};

export type FinalizeChatTurnParams = {
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
	skipAssistantProseMemoryIntake?: boolean;
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
			? createMessageImpl(params.conversationId, params.role, params.content)
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

async function reconcileGeneratedOutputsForAssistantMessage(params: {
	turnKind: ChatTurnRoute;
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	assistantResponse: string;
	reconciliation: GeneratedOutputReconciliationParams;
}): Promise<ChatGeneratedFile[]> {
	const logPrefix = turnLogPrefix(params.turnKind);
	const getFileProductionJobsImpl =
		params.reconciliation.getFileProductionJobs ??
		listConversationFileProductionJobs;
	const assignFileProductionJobsImpl =
		params.reconciliation.assignFileProductionJobsToAssistantMessage ??
		assignFileProductionJobsToAssistantMessage;
	const syncGeneratedFilesToMemoryImpl =
		params.reconciliation.syncGeneratedFilesToMemory ??
		syncGeneratedFilesToMemory;
	const getChatFilesForAssistantMessageImpl =
		params.reconciliation.getChatFilesForAssistantMessage ??
		getChatFilesForAssistantMessage;

	try {
		const fileProductionJobs = await getFileProductionJobsImpl(
			params.userId,
			params.conversationId,
		);
		const newFileProductionJobs = fileProductionJobs.filter(
			(job) => !params.reconciliation.fileProductionJobIdsAtStart.has(job.id),
		);
		const newFileProductionJobIds = newFileProductionJobs.map((job) => job.id);

		if (newFileProductionJobIds.length > 0) {
			await assignFileProductionJobsImpl(
				params.userId,
				params.conversationId,
				params.assistantMessageId,
				newFileProductionJobIds,
			);
		}

		const initialGeneratedFileIds = getUniqueGeneratedFileIds(
			newFileProductionJobs,
		);
		const refreshedJobs = await getFileProductionJobsImpl(
			params.userId,
			params.conversationId,
		);
		const refreshedGeneratedFileIds = getUniqueGeneratedFileIds(
			refreshedJobs.filter(
				(job) => !params.reconciliation.fileProductionJobIdsAtStart.has(job.id),
			),
		);
		const newGeneratedFileIds = Array.from(
			new Set([...initialGeneratedFileIds, ...refreshedGeneratedFileIds]),
		);

		if (newGeneratedFileIds.length > 0) {
			void syncGeneratedFilesToMemoryImpl({
				userId: params.userId,
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				fileIds: newGeneratedFileIds,
				assistantResponse: params.assistantResponse,
			}).catch((error) => {
				console.error(
					`${logPrefix} Background generated-file memory sync failed`,
					{
						conversationId: params.conversationId,
						assistantMessageId: params.assistantMessageId,
						fileIds: newGeneratedFileIds,
						error,
					},
				);
			});
		}

		const generatedFiles = (
			await getChatFilesForAssistantMessageImpl(
				params.conversationId,
				params.assistantMessageId,
			)
		).map(toPublicGeneratedFile);

		await reconcilePendingWritesForAssistantMessage(params);

		return generatedFiles;
	} catch (error) {
		console.error(`${logPrefix} Failed to reconcile generated outputs`, {
			conversationId: params.conversationId,
			assistantMessageId: params.assistantMessageId,
			error,
		});
		return [];
	}
}

// Issue 7.5 — sibling reconciliation to the file-production one above,
// applied to connection_pending_writes. Deliberately its own try/catch so a
// failure here (or above) never suppresses the other's result — this is a
// best-effort backfill for card UI, not a correctness-critical write path
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

function getUniqueGeneratedFileIds(jobs: FileProductionJobSummary[]): string[] {
	return Array.from(
		new Set(jobs.flatMap((job) => (job.files ?? []).map((file) => file.id))),
	);
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
	const logPrefix = turnLogPrefix(params.turnKind);
	const isStream = params.turnKind === "stream";
	// Every former independently-settable mode boolean besides
	// persistTurnState now derives from the turn kind: send persists
	// attachments before the assistant message and runs its post-turn
	// projection eagerly (strict persistence, no deferral); stream persists
	// attachments after (deferred, best-effort) and always defers the full
	// projection until onDurableReceiptReady has run.
	const mode: MessageCreationMode = isStream ? "best_effort" : "strict";
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
				},
				mode,
				createMessage,
			)
		: undefined;

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
	const instructionSuggestions = collectInstructionSuggestions(
		params.toolCalls,
	);
	const assistantMetadata = {
		...params.assistantMetadata,
		depthMetadata,
		...(instructionSuggestions.length > 0 ? { instructionSuggestions } : {}),
	};
	// The assistant message is always persisted — no turn kind or caller ever
	// legitimately skips it, so this is no longer a param to thread.
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
	// evidence → generated-output reconciliation
	// — so a new post-turn side effect is added in exactly one place.
	const runPostTurnProjection = async (): Promise<{
		turnState: PersistAssistantTurnStateResult | null;
		evidenceTask: Promise<void>;
		resolvedAttachedArtifacts: WorkingSetItem[] | undefined;
		generatedFiles: ChatGeneratedFile[];
	}> => {
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

		const generatedFiles =
			assistantMessage && params.generatedOutputReconciliation
				? await reconcileGeneratedOutputsForAssistantMessage({
						turnKind: params.turnKind,
						userId: params.userId,
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage.id,
						assistantResponse: params.assistantResponse,
						reconciliation: params.generatedOutputReconciliation,
					})
				: [];

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
