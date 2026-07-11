import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import {
	assignPendingWritesToAssistantMessage,
	listPendingWritesForConversation,
} from "$lib/server/services/connections/pending-writes";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { createMessage } from "$lib/server/services/messages";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import { getProjectReferenceContext } from "$lib/server/services/task-state";
import type {
	ArtifactSummary,
	ChatGeneratedFile,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	DepthMetadata,
	LinkedContextSource,
	ReasoningDepth,
	SkillControlOperation,
	ThinkingSegment,
	ToolCallEntry,
} from "$lib/types";
import { buildContextSourcesState } from "./context-sources";
import type { LegacyContextTraceSectionInput } from "./context-trace";
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
	runPostTurnTasks,
} from "./finalize-steps";
import type {
	PersistAssistantEvidenceParams,
	PersistAssistantTurnStateParams,
	PersistAssistantTurnStateResult,
	RunPostTurnTasksParams,
	WorkingSetItem,
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

export type FinalizeChatTurnParams = {
	logPrefix: "[SEND]" | "[STREAM]";
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
	skillControlOperations: SkillControlOperation[];
	skillControlSessionId: string | null;
	attachmentIds: string[];
	activeDocumentArtifactId: string | null;
	contextStatus: PersistAssistantTurnStateParams["contextStatus"];
	initialTaskState: PersistAssistantTurnStateParams["initialTaskState"];
	initialContextDebug: PersistAssistantTurnStateParams["initialContextDebug"];
	analytics: PersistAssistantTurnStateParams["analytics"];
	continuitySource: PersistAssistantTurnStateParams["continuitySource"];
	assistantMirrorContent: string;
	maintenanceReason: RunPostTurnTasksParams["maintenanceReason"];
	startedResetGeneration?: number;
	linkedSources?: LinkedContextSource[];
	toolCalls?: PersistAssistantEvidenceParams["toolCalls"];
	contextTraceSections?: PersistAssistantEvidenceParams["contextTraceSections"];
	webCitationAudit?: PersistAssistantEvidenceParams["webCitationAudit"];
	persistenceMode?: MessageCreationMode;
	persistAssistantMessage?: boolean;
	persistTurnState?: boolean;
	persistUserAttachmentsBeforeAssistantMessage?: boolean;
	waitForEvidenceBeforePostTurnTasks?: boolean;
	deferPostTurnProjection?: boolean;
	generatedOutputReconciliation?: GeneratedOutputReconciliationParams;
	skipAssistantProseMemoryIntake?: boolean;
};

function buildSkillControlLogContext(params: {
	conversationId: string;
	assistantMessageId: string;
	streamId?: string | null;
}): Record<string, string> {
	const context: Record<string, string> = {
		conversationId: params.conversationId,
		assistantMessageId: params.assistantMessageId,
	};
	if (params.streamId) {
		context.streamId = params.streamId;
	}
	return context;
}

export type FinalizeChatTurnResult = {
	userMessage: { id: string } | undefined;
	assistantMessage: { id: string } | undefined;
	turnState: PersistAssistantTurnStateResult | null;
	contextSources: ContextSourcesState;
	evidenceTask: Promise<void>;
	createPostTurnTask: () => Promise<void>;
	attachmentTask: Promise<WorkingSetItem[] | undefined>;
	attachedArtifacts?: WorkingSetItem[];
	generatedFiles: ChatGeneratedFile[];
};

export type BuildChatTurnCompletionContextSourcesParams = {
	userId: string;
	conversationId: string;
	contextStatus?: ConversationContextStatus | null;
	contextDebug?: ContextDebugState | null;
	attachedArtifacts?: unknown;
	linkedSources?: LinkedContextSource[];
	activeWorkingSet?: unknown;
	contextTraceSections?: LegacyContextTraceSectionInput[];
	toolCalls?: ToolCallEntry[];
};

function buildEmptyCompletionContextSources(params: {
	userId: string;
	conversationId: string;
}): ContextSourcesState {
	return buildContextSourcesState({
		userId: params.userId,
		conversationId: params.conversationId,
	});
}

export async function buildChatTurnCompletionContextSources(
	params: BuildChatTurnCompletionContextSourcesParams,
): Promise<ContextSourcesState> {
	const projectReference = await getProjectReferenceContext({
		userId: params.userId,
		conversationId: params.conversationId,
	}).catch(() => null);

	return buildContextSourcesState({
		userId: params.userId,
		conversationId: params.conversationId,
		contextStatus: params.contextStatus ?? null,
		contextDebug: params.contextDebug ?? null,
		attachedArtifacts: toArtifactSummaries(params.attachedArtifacts),
		linkedSources: params.linkedSources ?? [],
		activeWorkingSet: toArtifactSummaries(params.activeWorkingSet),
		projectReference,
		contextTraceSections: params.contextTraceSections ?? [],
		toolCalls: (params.toolCalls ?? []).filter(
			(tool) => tool.status === "done",
		),
	});
}

function toArtifactSummaries(value: unknown): ArtifactSummary[] {
	if (!Array.isArray(value)) return [];
	return value.filter(isArtifactSummaryLike) as ArtifactSummary[];
}

function isArtifactSummaryLike(value: unknown): value is ArtifactSummary {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"name" in value &&
		typeof value.name === "string" &&
		"type" in value &&
		typeof value.type === "string"
	);
}

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
	logPrefix: "[SEND]" | "[STREAM]";
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	assistantResponse: string;
	reconciliation: GeneratedOutputReconciliationParams;
}): Promise<ChatGeneratedFile[]> {
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
					`${params.logPrefix} Background generated-file memory sync failed`,
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
		console.error(`${params.logPrefix} Failed to reconcile generated outputs`, {
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
	logPrefix: "[SEND]" | "[STREAM]";
	userId: string;
	conversationId: string;
	assistantMessageId: string;
	reconciliation: GeneratedOutputReconciliationParams;
}): Promise<void> {
	const pendingWriteIdsAtStart = params.reconciliation.pendingWriteIdsAtStart;
	if (!pendingWriteIdsAtStart) {
		return;
	}

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
		console.error(`${params.logPrefix} Failed to reconcile pending writes`, {
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

export async function finalizeChatTurn(
	params: FinalizeChatTurnParams,
): Promise<FinalizeChatTurnResult> {
	const mode = params.persistenceMode ?? "strict";
	const persistUserAttachmentsBeforeAssistantMessage =
		params.persistUserAttachmentsBeforeAssistantMessage ?? true;
	const waitForEvidenceBeforePostTurnTasks =
		params.waitForEvidenceBeforePostTurnTasks ?? true;
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

	const shouldPersistAssistantMessage = params.persistAssistantMessage ?? true;
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
	const assistantMetadata = {
		...params.assistantMetadata,
		depthMetadata,
	};
	const assistantMessage = shouldPersistAssistantMessage
		? await createTurnMessage(
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
			)
		: undefined;

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
	} else if (!persistUserAttachmentsBeforeAssistantMessage) {
		attachmentTask = Promise.resolve(undefined);
	}

	const deferProjection = params.deferPostTurnProjection ?? false;

	// The single ordered post-turn projection, shared by both callers. Each
	// side effect runs exactly once in a fixed order — skill-control ops →
	// assistant turn-state → evidence → completion context sources →
	// generated-output reconciliation — so a new post-turn side effect is added
	// in exactly one place. `runPostTurnTasks` is the deferred tail step,
	// invoked separately through `createPostTurnTask`.
	const runPostTurnProjection = async (): Promise<{
		turnState: PersistAssistantTurnStateResult | null;
		evidenceTask: Promise<void>;
		contextSources: ContextSourcesState;
		resolvedAttachedArtifacts: WorkingSetItem[] | undefined;
		generatedFiles: ChatGeneratedFile[];
	}> => {
		let turnState: PersistAssistantTurnStateResult | null = null;
		if (assistantMessage && shouldPersistTurnState) {
			if (params.skillControlOperations.length > 0) {
				await commitSkillNoteOperationsAfterAssistantMessage({
					userId: params.userId,
					conversationId: params.conversationId,
					sessionId: params.skillControlSessionId,
					assistantMessageId: assistantMessage.id,
					operations: params.skillControlOperations,
				}).catch((error) => {
					console.warn(
						`${params.logPrefix} Failed to apply Skill Note Operations`,
						{
							...buildSkillControlLogContext({
								conversationId: params.conversationId,
								assistantMessageId: assistantMessage.id,
								streamId: params.streamId,
							}),
							error,
						},
					);
				});
				await applySkillControlOperations({
					userId: params.userId,
					conversationId: params.conversationId,
					assistantMessageId: assistantMessage.id,
					operations: params.skillControlOperations,
				}).catch((error) => {
					console.warn(
						`${params.logPrefix} Failed to apply Skill Control Envelope`,
						{
							...buildSkillControlLogContext({
								conversationId: params.conversationId,
								assistantMessageId: assistantMessage.id,
								streamId: params.streamId,
							}),
							error,
						},
					);
				});
			}

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
				continuitySource: params.continuitySource,
			});
		}

		const evidenceTask =
			assistantMessage && turnState
				? persistAssistantEvidence({
						logPrefix: params.logPrefix,
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
		const contextSourcesParams = {
			userId: params.userId,
			conversationId: params.conversationId,
			contextStatus: params.contextStatus ?? null,
			contextDebug:
				turnState?.contextDebug ?? params.initialContextDebug ?? null,
			attachedArtifacts: resolvedAttachedArtifacts,
			linkedSources: params.linkedSources ?? [],
			activeWorkingSet: turnState?.activeWorkingSet,
			contextTraceSections: params.contextTraceSections,
			toolCalls: params.toolCalls,
		};
		// The deferred (stream) caller has already flushed its terminal receipt
		// by the time this projection runs in the background, so a
		// context-source failure there is logged and swallowed. The eager (send)
		// caller needs the real value in its response body, so it lets it throw.
		const contextSources = deferProjection
			? await buildChatTurnCompletionContextSources(contextSourcesParams).catch(
					(error) => {
						console.error(
							`${params.logPrefix} Deferred context-source projection failed`,
							{
								conversationId: params.conversationId,
								assistantMessageId: assistantMessage?.id ?? null,
								error,
							},
						);
						return buildEmptyCompletionContextSources({
							userId: params.userId,
							conversationId: params.conversationId,
						});
					},
				)
			: await buildChatTurnCompletionContextSources(contextSourcesParams);

		const generatedFiles =
			assistantMessage && params.generatedOutputReconciliation
				? await reconcileGeneratedOutputsForAssistantMessage({
						logPrefix: params.logPrefix,
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
			contextSources,
			resolvedAttachedArtifacts,
			generatedFiles,
		};
	};

	// The tail step: post-turn memory/summary/maintenance work. Kept out of the
	// projection so the eager caller can hand back its durable receipt first and
	// let the caller trigger this in the background.
	const runPostTurnTail = (
		turnState: PersistAssistantTurnStateResult | null,
		evidenceTask: Promise<void>,
	): Promise<void> => {
		if (!assistantMessage || !turnState) return Promise.resolve();
		const runTask = () =>
			runPostTurnTasks({
				logPrefix: params.logPrefix,
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
			});
		if (waitForEvidenceBeforePostTurnTasks) {
			return evidenceTask.then(runTask);
		}
		void evidenceTask;
		return runTask();
	};

	if (deferProjection) {
		// Stream path: return the terminal receipt immediately and run the whole
		// ordered projection (plus its tail) in the background when the caller
		// invokes createPostTurnTask.
		const createPostTurnTask = () =>
			(async () => {
				if (!assistantMessage) {
					await attachmentTask.catch(() => undefined);
					return;
				}
				const projection = await runPostTurnProjection();
				await runPostTurnTail(projection.turnState, projection.evidenceTask);
			})().catch((error) => {
				console.error(
					`${params.logPrefix} Deferred post-turn projection failed`,
					{
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage?.id ?? null,
						error,
					},
				);
			});

		return {
			userMessage,
			assistantMessage,
			turnState: null,
			contextSources: buildEmptyCompletionContextSources({
				userId: params.userId,
				conversationId: params.conversationId,
			}),
			evidenceTask: Promise.resolve(),
			createPostTurnTask,
			attachmentTask,
			attachedArtifacts,
			generatedFiles: [],
		};
	}

	// Send path: run the projection eagerly so the durable completion result
	// (turn state, context sources, generated files, evidence) is available in
	// the response, and hand back the tail as createPostTurnTask.
	const projection = await runPostTurnProjection();
	const createPostTurnTask = () =>
		runPostTurnTail(projection.turnState, projection.evidenceTask);

	return {
		userMessage,
		assistantMessage,
		turnState: projection.turnState,
		contextSources: projection.contextSources,
		evidenceTask: projection.evidenceTask,
		createPostTurnTask,
		attachmentTask,
		attachedArtifacts: projection.resolvedAttachedArtifacts,
		generatedFiles: projection.generatedFiles,
	};
}
