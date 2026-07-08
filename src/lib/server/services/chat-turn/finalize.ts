import { recordMessageAnalytics } from "$lib/server/services/analytics";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { clearConversationDraft } from "$lib/server/services/conversation-drafts";
import { refreshConversationSummary } from "$lib/server/services/conversation-summaries";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import {
	attachArtifactsToMessage,
	createGeneratedOutputArtifact,
	getArtifactsForUser,
	getConversationWorkingSet,
	listConversationSourceArtifactIds,
	refreshConversationWorkingSet,
	upsertWorkCapsule,
} from "$lib/server/services/knowledge";
import { parseWorkingDocumentMetadata } from "$lib/server/services/knowledge/store";
import { recordMemoryEvent } from "$lib/server/services/memory-events";
import { runUserMemoryMaintenance } from "$lib/server/services/memory-maintenance";
import { buildAssistantEvidenceSummary } from "$lib/server/services/message-evidence";
import {
	createMessage,
	updateMessageEvidence,
	updateMessageWebCitationAudit,
} from "$lib/server/services/messages";
import { commitSkillNoteOperationsAfterAssistantMessage } from "$lib/server/services/skills/notes";
import { applySkillControlOperations } from "$lib/server/services/skills/sessions";
import {
	applyProjectContinuitySignalFromMessage,
	attachContinuityToTaskState,
	getContextDebugState,
	getConversationTaskState,
	getProjectReferenceContext,
	shouldTrackTaskContinuityFromTurn,
	syncTaskContinuityFromTaskState,
	updateTaskStateCheckpoint,
} from "$lib/server/services/task-state";
import { buildWebCitationAudit } from "$lib/server/services/web-citation-audit";
import { resolveWorkingDocumentSelection } from "$lib/server/services/working-document-selection";
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
import type {
	PersistAssistantEvidenceParams,
	PersistAssistantTurnStateParams,
	PersistAssistantTurnStateResult,
	RunPostTurnTasksParams,
	WorkCapsuleSummary,
	WorkingSetItem,
} from "./types";

async function refreshWorkingSetWithAttachments(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	normalizedMessage: string;
	attachmentIds: string[];
}): Promise<WorkingSetItem[] | undefined> {
	if (params.attachmentIds.length === 0) return undefined;

	await attachArtifactsToMessage({
		userId: params.userId,
		conversationId: params.conversationId,
		messageId: params.messageId,
		artifactIds: params.attachmentIds,
	});

	return refreshConversationWorkingSet({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.normalizedMessage,
		attachmentIds: params.attachmentIds,
	});
}

export async function persistUserTurnAttachments(params: {
	userId: string;
	conversationId: string;
	messageId: string;
	normalizedMessage: string;
	attachmentIds: string[];
}): Promise<WorkingSetItem[] | undefined> {
	return refreshWorkingSetWithAttachments(params);
}

type MessageCreationMode = "strict" | "best_effort";
type CreateMessageFn = typeof createMessage;

type FileProductionJobSummary = {
	id: string;
	files?: Array<{ id: string }>;
};

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
	createMessage?: CreateMessageFn;
	persistUserTurnAttachments?: typeof persistUserTurnAttachments;
	persistAssistantTurnState?: typeof persistAssistantTurnState;
	persistAssistantEvidence?: typeof persistAssistantEvidence;
	runPostTurnTasks?: typeof runPostTurnTasks;
	buildCompletionContextSources?: typeof buildChatTurnCompletionContextSources;
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

		return (
			await getChatFilesForAssistantMessageImpl(
				params.conversationId,
				params.assistantMessageId,
			)
		).map(toPublicGeneratedFile);
	} catch (error) {
		console.error(`${params.logPrefix} Failed to reconcile generated outputs`, {
			conversationId: params.conversationId,
			assistantMessageId: params.assistantMessageId,
			error,
		});
		return [];
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
	const createMessageImpl = params.createMessage ?? createMessage;
	const persistUserTurnAttachmentsImpl =
		params.persistUserTurnAttachments ?? persistUserTurnAttachments;
	const persistAssistantTurnStateImpl =
		params.persistAssistantTurnState ?? persistAssistantTurnState;
	const persistAssistantEvidenceImpl =
		params.persistAssistantEvidence ?? persistAssistantEvidence;
	const runPostTurnTasksImpl = params.runPostTurnTasks ?? runPostTurnTasks;
	const buildCompletionContextSourcesImpl =
		params.buildCompletionContextSources ??
		buildChatTurnCompletionContextSources;
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
				createMessageImpl,
			)
		: undefined;

	if (
		persistUserAttachmentsBeforeAssistantMessage &&
		userMessage &&
		params.attachmentIds.length > 0
	) {
		attachedArtifacts = await persistUserTurnAttachmentsImpl({
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
				createMessageImpl,
			)
		: undefined;

	if (
		!persistUserAttachmentsBeforeAssistantMessage &&
		userMessage &&
		params.attachmentIds.length > 0
	) {
		attachmentTask = persistUserTurnAttachmentsImpl({
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

	if (params.deferPostTurnProjection) {
		const createPostTurnTask = () =>
			(async () => {
				if (!assistantMessage) {
					await attachmentTask.catch(() => undefined);
					return;
				}

				let turnState: PersistAssistantTurnStateResult | null = null;
				if (shouldPersistTurnState) {
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

					turnState = await persistAssistantTurnStateImpl({
						userId: params.userId,
						conversationId: params.conversationId,
						normalizedMessage: params.normalizedMessage,
						assistantResponse: params.assistantResponse,
						attachmentIds: params.attachmentIds,
						activeDocumentArtifactId:
							params.activeDocumentArtifactId ?? undefined,
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
					turnState && shouldPersistTurnState
						? persistAssistantEvidenceImpl({
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
				await buildCompletionContextSourcesImpl({
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
				}).catch((error) => {
					console.error(
						`${params.logPrefix} Deferred context-source projection failed`,
						{
							conversationId: params.conversationId,
							assistantMessageId: assistantMessage.id,
							error,
						},
					);
				});

				if (params.generatedOutputReconciliation) {
					await reconcileGeneratedOutputsForAssistantMessage({
						logPrefix: params.logPrefix,
						userId: params.userId,
						conversationId: params.conversationId,
						assistantMessageId: assistantMessage.id,
						assistantResponse: params.assistantResponse,
						reconciliation: params.generatedOutputReconciliation,
					});
				}

				if (turnState && shouldPersistTurnState) {
					const runTask = () =>
						runPostTurnTasksImpl({
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
							skipAssistantProseMemoryIntake:
								params.skipAssistantProseMemoryIntake,
						});

					if (waitForEvidenceBeforePostTurnTasks) {
						await evidenceTask;
						await runTask();
					} else {
						void evidenceTask;
						await runTask();
					}
				}
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

		turnState = await persistAssistantTurnStateImpl({
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
			? persistAssistantEvidenceImpl({
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

	const createPostTurnTask = () =>
		assistantMessage && turnState
			? waitForEvidenceBeforePostTurnTasks
				? evidenceTask.then(() =>
						runPostTurnTasksImpl({
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
							skipAssistantProseMemoryIntake:
								params.skipAssistantProseMemoryIntake,
						}),
					)
				: runPostTurnTasksImpl({
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
						skipAssistantProseMemoryIntake:
							params.skipAssistantProseMemoryIntake,
					})
			: Promise.resolve();

	const resolvedAttachedArtifacts = attachedArtifacts ?? (await attachmentTask);
	const contextSources = await buildCompletionContextSourcesImpl({
		userId: params.userId,
		conversationId: params.conversationId,
		contextStatus: params.contextStatus ?? null,
		contextDebug: turnState?.contextDebug ?? params.initialContextDebug ?? null,
		attachedArtifacts: resolvedAttachedArtifacts,
		linkedSources: params.linkedSources ?? [],
		activeWorkingSet: turnState?.activeWorkingSet,
		contextTraceSections: params.contextTraceSections,
		toolCalls: params.toolCalls,
	});
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
		userMessage,
		assistantMessage,
		turnState,
		contextSources,
		evidenceTask,
		createPostTurnTask,
		attachmentTask,
		attachedArtifacts: resolvedAttachedArtifacts,
		generatedFiles,
	};
}

export async function persistAssistantTurnState(
	params: PersistAssistantTurnStateParams,
): Promise<PersistAssistantTurnStateResult> {
	const analytics = params.analytics ?? null;
	if (analytics) {
		await recordMessageAnalytics({
			messageId: params.assistantMessageId,
			conversationId: params.conversationId,
			userId: params.userId,
			model: analytics.model,
			modelDisplayName: analytics.modelDisplayName,
			promptTokens: analytics.promptTokens,
			completionTokens: analytics.completionTokens,
			reasoningTokens: analytics.reasoningTokens,
			generationTimeMs: analytics.generationTimeMs,
			providerUsage: analytics.providerUsage,
		}).catch((err) => {
			console.error("[ANALYTICS] Failed to record message analytics:", err);
		});
	}

	const sourceArtifactIds =
		params.attachmentIds.length > 0
			? params.attachmentIds
			: await listConversationSourceArtifactIds(
					params.userId,
					params.conversationId,
				);
	const outputArtifact = await createGeneratedOutputArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		messageId: params.assistantMessageId,
		content: params.assistantResponse,
		sourceArtifactIds,
	});
	const workCapsule = (await upsertWorkCapsule({
		userId: params.userId,
		conversationId: params.conversationId,
	})) as WorkCapsuleSummary;
	const activeDocumentArtifact = params.activeDocumentArtifactId
		? ((
				await getArtifactsForUser(params.userId, [
					params.activeDocumentArtifactId,
				]).catch(() => [])
			)[0] ?? null)
		: null;
	const documentRefinementSelection = activeDocumentArtifact
		? resolveWorkingDocumentSelection({
				artifacts: [activeDocumentArtifact],
				message: params.normalizedMessage,
				attachmentIds: params.attachmentIds,
				activeDocumentArtifactId: activeDocumentArtifact.id,
				currentConversationId: params.conversationId,
			})
		: null;
	const activeWorkingSet = await refreshConversationWorkingSet({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.normalizedMessage,
		activeDocumentArtifactId: params.activeDocumentArtifactId,
		selectedGeneratedArtifactId: outputArtifact?.id ?? null,
	}).catch(async () =>
		getConversationWorkingSet(params.userId, params.conversationId),
	);
	let taskState = await updateTaskStateCheckpoint({
		userId: params.userId,
		conversationId: params.conversationId,
		message: params.normalizedMessage,
		assistantResponse: params.assistantResponse,
		attachmentIds: params.attachmentIds,
		promptArtifactIds: params.contextStatus?.workingSetArtifactIds ?? [],
		userMessageId: params.userMessageId ?? null,
		assistantMessageId: params.assistantMessageId,
	}).catch(async () =>
		getConversationTaskState(params.userId, params.conversationId),
	);

	if (
		taskState &&
		shouldTrackTaskContinuityFromTurn({
			message: params.normalizedMessage,
			assistantResponse: params.assistantResponse,
			taskState,
			attachmentIds: params.attachmentIds,
		})
	) {
		await syncTaskContinuityFromTaskState({
			userId: params.userId,
			taskState,
		}).catch((error) =>
			console.error(
				`[CONTINUITY] Failed to sync focus continuity from ${params.continuitySource}:`,
				error,
			),
		);
		await applyProjectContinuitySignalFromMessage({
			userId: params.userId,
			taskState,
			message: params.normalizedMessage,
		}).catch((error) =>
			console.error(
				`[CONTINUITY] Failed to apply project continuity signal from ${params.continuitySource}:`,
				error,
			),
		);
	}

	taskState = await attachContinuityToTaskState(
		params.userId,
		taskState ?? null,
	).catch(() => taskState ?? null);
	const shouldRecordDocumentRefinement = activeDocumentArtifact
		? !documentRefinementSelection?.reset.hasSignal &&
			documentRefinementSelection?.currentDocument?.artifactId ===
				activeDocumentArtifact.id &&
			documentRefinementSelection.taskEvidence.workingDocumentProtectedArtifactIds.includes(
				activeDocumentArtifact.id,
			)
		: false;
	if (activeDocumentArtifact && shouldRecordDocumentRefinement) {
		const documentMetadata = parseWorkingDocumentMetadata(
			activeDocumentArtifact.metadata,
		);
		const behaviorSubjectId =
			documentMetadata.documentFamilyId ?? activeDocumentArtifact.id;
		await recordMemoryEvent({
			eventKey: `document_refined:${behaviorSubjectId}:${params.assistantMessageId}`,
			userId: params.userId,
			conversationId: params.conversationId,
			messageId: params.assistantMessageId,
			domain: "document",
			eventType: "document_refined",
			subjectId: behaviorSubjectId,
			relatedId: activeDocumentArtifact.id,
			payload: {
				artifactId: activeDocumentArtifact.id,
				documentFamilyId: documentMetadata.documentFamilyId ?? null,
				documentLabel:
					documentMetadata.documentLabel ?? activeDocumentArtifact.name,
				documentRole: documentMetadata.documentRole ?? null,
				explicitCorrection:
					documentRefinementSelection?.correction.hasSignal ?? false,
				generatedOutputArtifactId: outputArtifact?.id ?? null,
			},
		}).catch((error) =>
			console.error(
				"[MEMORY_EVENTS] Failed to record document refinement event:",
				error,
			),
		);
	}
	const contextDebug = await getContextDebugState(
		params.userId,
		params.conversationId,
	).catch(() => null);
	await clearConversationDraft(params.userId, params.conversationId).catch(
		() => undefined,
	);

	return {
		activeWorkingSet,
		taskState,
		contextDebug,
		workCapsule,
	};
}

export async function persistAssistantEvidence(
	params: PersistAssistantEvidenceParams,
): Promise<void> {
	try {
		const doneToolCalls =
			params.toolCalls?.filter((tool) => tool.status === "done") ?? [];
		const currentAttachments =
			params.attachmentIds.length > 0
				? await getArtifactsForUser(params.userId, params.attachmentIds)
				: [];
		const messageEvidence = await buildAssistantEvidenceSummary({
			userId: params.userId,
			message: params.normalizedMessage,
			taskState: params.taskState ?? params.initialTaskState ?? null,
			contextStatus: params.contextStatus ?? null,
			contextDebug: params.contextDebug ?? params.initialContextDebug ?? null,
			contextTraceSections: params.contextTraceSections,
			toolCalls: doneToolCalls,
			currentAttachments,
		});
		const webCitationAudit =
			params.webCitationAudit === undefined
				? buildWebCitationAudit({
						assistantResponse: params.assistantResponse,
						toolCalls: doneToolCalls,
					})
				: params.webCitationAudit;
		await updateMessageEvidence(params.assistantMessageId, {
			evidenceSummary: messageEvidence,
			evidenceStatus: messageEvidence ? "ready" : "none",
		});
		await updateMessageWebCitationAudit(
			params.assistantMessageId,
			webCitationAudit,
		);
		if (
			webCitationAudit &&
			webCitationAudit.status !== "passed" &&
			webCitationAudit.status !== "none"
		) {
			console.warn(`${params.logPrefix} Web citation audit warning`, {
				conversationId: params.conversationId,
				assistantMessageId: params.assistantMessageId,
				status: webCitationAudit.status,
				retrievedSourceCount: webCitationAudit.retrievedSourceCount,
				citedUrlCount: webCitationAudit.citedUrlCount,
				unsupportedCitationCount: webCitationAudit.unsupportedCitationCount,
			});
		}
	} catch (error) {
		console.error(
			`${params.logPrefix} Failed to persist assistant evidence summary:`,
			error,
		);
		await updateMessageEvidence(params.assistantMessageId, {
			evidenceStatus: "failed",
		}).catch(() => undefined);
	}
}

export async function runPostTurnTasks(
	params: RunPostTurnTasksParams,
): Promise<void> {
	const postTurnTasks: Promise<unknown>[] = [];
	if (!params.skipAssistantProseMemoryIntake) {
		postTurnTasks.push(
			(async () => {
				const { detectExplicitMemoryRequest, scheduleConversationJudge } =
					await import("../memory-judge/runner");
				const { markMemoryDirty } = await import(
					"../memory-profile/dirty-ledger"
				);
				const { countUnjudgedMessages } = await import(
					"../memory-judge/segment"
				);
				if (detectExplicitMemoryRequest(params.userMessage)) {
					const { runMemoryJudgeOnSegment } = await import("../memory-judge");
					await runMemoryJudgeOnSegment({
						userId: params.userId,
						conversationId: params.conversationId,
						trigger: "explicit",
						segmentOverride: [
							{ role: "user", content: params.userMessage },
							{
								role: "assistant",
								content:
									params.assistantMirrorContent ?? params.assistantResponse,
							},
						],
					});
					return;
				}
				await markMemoryDirty({
					userId: params.userId,
					reason: "deferred_intake",
					scope: { type: "conversation", id: params.conversationId },
				});
				if (
					(await countUnjudgedMessages({
						userId: params.userId,
						conversationId: params.conversationId,
					})) >= 25
				) {
					const { runMemoryJudgeOnSegment } = await import("../memory-judge");
					await runMemoryJudgeOnSegment({
						userId: params.userId,
						conversationId: params.conversationId,
						trigger: "marathon",
					});
					return;
				}
				scheduleConversationJudge({
					userId: params.userId,
					conversationId: params.conversationId,
				});
			})().catch((err) =>
				console.error("[MEMORY_JUDGE] Post-turn trigger failed:", err),
			),
		);
	}

	const summaryRefreshTask =
		params.userMessage.trim() && params.assistantResponse.trim()
			? refreshConversationSummary({
					userId: params.userId,
					conversationId: params.conversationId,
					userMessage: params.userMessage,
					assistantResponse: params.assistantResponse,
					startedResetGeneration: params.startedResetGeneration,
				}).catch((error) =>
					console.error(
						`${params.logPrefix} Conversation summary refresh failed:`,
						error,
					),
				)
			: Promise.resolve();

	try {
		await Promise.allSettled([...postTurnTasks, summaryRefreshTask]);
		void runUserMemoryMaintenance(
			params.userId,
			params.maintenanceReason,
		).catch((error) =>
			console.error(
				`${params.logPrefix} Post-turn memory maintenance failed:`,
				error,
			),
		);
	} catch (error) {
		console.error(
			`${params.logPrefix} Post-turn memory maintenance failed:`,
			error,
		);
	}
}
