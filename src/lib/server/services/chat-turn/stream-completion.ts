import type { FinishReason } from "ai";
import { getConfig } from "$lib/server/config-store";
import {
	buildChatTurnCompletionContextSources,
	finalizeChatTurn,
} from "$lib/server/services/chat-turn/finalize";
import {
	listContextCompressionSnapshots,
	serializeContextCompressionSnapshot,
} from "$lib/server/services/context-compression";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import type {
	ChatGeneratedFile,
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	DepthMetadata,
	LinkedContextSource,
	ReasoningDepth,
	ToolCallEntry,
	WebCitationAudit,
} from "$lib/types";
import { isFileProductionToolName } from "$lib/utils/tool-calls";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import {
	buildBaselineDepthMetadata,
	withDepthMetadataModelInfo,
} from "./depth-metadata";
import { parseSkillControlEnvelopePayloads } from "./skill-control-envelope";
import {
	createUiMessageStreamDoneFrame,
	streamDataPartEvent,
	streamFinishEvent,
	streamReasoningEndEvent,
	streamTextDeltaEvent,
	streamTextEndEvent,
	streamTextStartEvent,
} from "./stream";
import type { WorkCapsuleSummary } from "./types";

type PersistedStreamTurnState = {
	activeWorkingSet: unknown;
	taskState: unknown;
	contextDebug: unknown;
	workCapsule: WorkCapsuleSummary;
	attachedArtifacts?: unknown;
};

export interface CompleteStreamTurnParams {
	wasStopped: boolean;
	conversationId: string;
	streamId: string | null;
	modelId: string | null;
	modelDisplayName: string | null;
	providerDisplayName?: string | null;
	providerIconUrl?: string | null;
	reasoningDepth?: ReasoningDepth;
	depthMetadata?: DepthMetadata;
	userId: string;
	normalizedMessage: string;
	upstreamMessage: string;
	skipPersistUserMessage: boolean;
	isReconnect: boolean | undefined;
	thinkingContent: string;
	fullResponse: string;
	toolCallRecords: ToolCallEntry[];
	skillControlEnvelopePayloads: string[];
	skillControlEnabled?: boolean;
	serverSegments: Array<unknown>;
	attachmentIds: string[];
	linkedSources: LinkedContextSource[];
	activeSkillSessionId?: string | null;
	activeDocumentArtifactId: string | null;
	requestStartTime: number;
	fileProductionJobIdsAtStart: Set<string>;
	latestContextStatus: unknown;
	latestActiveWorkingSet: unknown;
	latestTaskState: unknown;
	latestContextDebug: unknown;
	latestHonchoContext: unknown;
	latestHonchoSnapshot: unknown;
	latestContextTraceSections?: LegacyContextTraceSectionInput[];
	latestProviderUsage: unknown;
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
	initialContextStatus: unknown;
	initialTaskState: unknown;
	initialContextDebug: unknown;
	initialContextTraceSections?: LegacyContextTraceSectionInput[];
	createMessage: (
		conversationId: string,
		role: "user" | "assistant",
		content: string,
		thinking?: string,
		serverSegments?: Array<unknown>,
		metadata?: Record<string, unknown>,
	) => Promise<{ id: string } | undefined>;
	persistUserTurnAttachments: (params: {
		userId: string;
		conversationId: string;
		messageId: string;
		normalizedMessage: string;
		attachmentIds: string[];
	}) => Promise<unknown>;
	persistAssistantTurnState: (params: {
		userId: string;
		conversationId: string;
		normalizedMessage: string;
		assistantResponse: string;
		attachmentIds: string[];
		activeDocumentArtifactId: string | null;
		contextStatus: unknown;
		initialTaskState: unknown;
		initialContextDebug: unknown;
		userMessageId: string | null;
		assistantMessageId: string;
		analytics: {
			model: string;
			modelDisplayName: string | null;
			providerDisplayName?: string | null;
			providerIconUrl?: string | null;
			promptTokens: number;
			completionTokens: number;
			reasoningTokens: number;
			generationTimeMs: number;
			providerUsage: unknown;
		};
		continuitySource: string;
		honchoContext: unknown;
		honchoSnapshot: unknown;
	}) => Promise<{
		activeWorkingSet: unknown;
		taskState: unknown;
		contextDebug: unknown;
		workCapsule: WorkCapsuleSummary;
		attachedArtifacts?: unknown;
	}>;
	persistAssistantEvidence: (params: {
		logPrefix: string;
		userId: string;
		conversationId: string;
		assistantMessageId: string;
		normalizedMessage: string;
		assistantResponse: string;
		attachmentIds: string[];
		taskState: unknown;
		contextStatus: unknown;
		contextDebug: unknown;
		initialTaskState: unknown;
		initialContextDebug: unknown;
		contextTraceSections?: LegacyContextTraceSectionInput[];
		toolCalls: ToolCallEntry[];
		webCitationAudit?: WebCitationAudit | null;
	}) => Promise<void>;
	runPostTurnTasks: (params: {
		logPrefix: string;
		userId: string;
		conversationId: string;
		upstreamMessage: string;
		assistantMirrorContent: string;
		workCapsule: WorkCapsuleSummary;
		maintenanceReason: string;
	}) => Promise<void>;
	touchConversation: (
		userId: string,
		conversationId: string,
	) => Promise<unknown>;
	enqueueChunk: (chunk: string) => boolean;
	closeDownstream: () => void;
	clearStreamBuffer: (streamId: string) => void;
	getStreamBuffer: (params: {
		streamId: string;
		userId: string;
		conversationId: string;
	}) => { userMessage?: string } | null;
	syncGeneratedFilesToMemory: (params: {
		userId: string;
		conversationId: string;
		assistantMessageId: string;
		fileIds: string[];
		assistantResponse: string;
	}) => Promise<void>;
	getChatFilesForAssistantMessage: (
		conversationId: string,
		assistantMessageId: string,
	) => Promise<ChatGeneratedFile[]>;
	getFileProductionJobs: (
		userId: string,
		conversationId: string,
	) => Promise<Array<{ id: string; files?: Array<{ id: string }> }>>;
	assignFileProductionJobsToAssistantMessage: (
		userId: string,
		conversationId: string,
		assistantMessageId: string,
		jobIds: string[],
	) => Promise<void>;
	estimateTokenCount: (text: string) => number;
}

export async function completeStreamTurn(
	params: CompleteStreamTurnParams,
): Promise<void> {
	const {
		wasStopped,
		conversationId,
		streamId,
		modelId,
		modelDisplayName,
		providerDisplayName,
		providerIconUrl,
		reasoningDepth,
		depthMetadata,
		userId,
		normalizedMessage,
		upstreamMessage,
		skipPersistUserMessage,
		isReconnect,
		thinkingContent,
		fullResponse,
		toolCallRecords,
		skillControlEnvelopePayloads,
		skillControlEnabled = true,
		serverSegments,
		attachmentIds,
		linkedSources,
		activeSkillSessionId,
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
		upstreamFinishReason = "stop",
		upstreamRawFinishReason = null,
		streamClosedWithoutFinish = false,
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
		getFileProductionJobs,
		assignFileProductionJobsToAssistantMessage,
		estimateTokenCount,
	} = params;

	const fileProductionFailureNotice = wasStopped
		? null
		: buildFileProductionFailureNotice(toolCallRecords);
	const completionWarning = wasStopped
		? null
		: buildCompletionWarning({
				upstreamFinishReason,
				upstreamRawFinishReason,
				streamClosedWithoutFinish,
			});
	const completionNotices = [
		fileProductionFailureNotice,
		completionWarning,
	].filter((notice): notice is string => Boolean(notice));
	const responseBeforeCitationNotice = appendNotices(
		fullResponse,
		completionNotices,
	);
	const citationGate = wasStopped
		? null
		: applyWebCitationQualityGate({
				assistantResponse: responseBeforeCitationNotice,
				toolCalls: toolCallRecords,
			});
	const finalResponse = citationGate?.response ?? responseBeforeCitationNotice;
	const skillControl = wasStopped
		? { operations: [] }
		: skillControlEnabled
			? parseSkillControlEnvelopePayloads(skillControlEnvelopePayloads)
			: { operations: [] };
	if (completionNotices.length > 0) {
		if (!fullResponse) {
			enqueueChunk(streamTextStartEvent());
		}
		enqueueChunk(
			streamTextDeltaEvent(
				`${fullResponse.trim() ? "\n\n" : ""}${completionNotices.join("\n\n")}`,
			),
		);
	}
	if (citationGate?.appendedNotice) {
		if (!responseBeforeCitationNotice) {
			enqueueChunk(streamTextStartEvent());
		}
		enqueueChunk(streamTextDeltaEvent(`\n\n${citationGate.appendedNotice}`));
		console.warn("[CHAT_STREAM] Appended web citation quality notice", {
			conversationId,
			streamId,
			status: citationGate.audit?.status,
		});
	}

	const thinkingTokenCount = estimateTokenCount(thinkingContent);
	const responseTokenCount = estimateTokenCount(finalResponse);
	const totalTokenCount = thinkingTokenCount + responseTokenCount;
	const genTimeMs = Date.now() - requestStartTime;
	const analyticsModel = modelId ?? "model1";
	const persistUserMessage = !skipPersistUserMessage;
	const toolCallSummary = toolCallRecords.map((record) => ({
		name: record.name,
		status: record.status,
	}));
	const hadFileProductionToolCall = toolCallSummary.some((record) =>
		isFileProductionToolName(record.name),
	);
	let persistedTurnState: PersistedStreamTurnState | null = null;
	let persistedContextSources: ContextSourcesState | null = null;

	if (getConfig().contextDiagnosticsDebug) {
		console.info("[CHAT_STREAM] Tool-call summary", {
			conversationId,
			streamId,
			wasStopped,
			toolCallCount: toolCallSummary.length,
			fileProductionCallCount: toolCallSummary.filter((record) =>
				isFileProductionToolName(record.name),
			).length,
			toolCalls: toolCallSummary,
		});
	}

	let userMessageToPersist = normalizedMessage;
	if (isReconnect && streamId) {
		const buffer = getStreamBuffer({
			streamId,
			userId,
			conversationId,
		});
		if (buffer?.userMessage) {
			userMessageToPersist = buffer.userMessage;
		}
	}
	const sendEndAndClose = async (
		userMsgId?: string,
		assistantMsgId?: string,
	) => {
		let generatedFiles: ChatGeneratedFile[] = [];
		try {
			if (assistantMsgId && hadFileProductionToolCall) {
				const fileProductionJobs = await getFileProductionJobs(
					userId,
					conversationId,
				);
				const newFileProductionJobs = fileProductionJobs.filter(
					(job) => !fileProductionJobIdsAtStart.has(job.id),
				);
				const newFileProductionJobIds = newFileProductionJobs.map(
					(job) => job.id,
				);

				if (newFileProductionJobIds.length > 0) {
					await assignFileProductionJobsToAssistantMessage(
						userId,
						conversationId,
						assistantMsgId,
						newFileProductionJobIds,
					);
				}

				const newGeneratedFileIds = Array.from(
					new Set(
						newFileProductionJobs.flatMap((job) =>
							(job.files ?? []).map((file) => file.id),
						),
					),
				);

				if (newGeneratedFileIds.length > 0) {
					void syncGeneratedFilesToMemory({
						userId,
						conversationId,
						assistantMessageId: assistantMsgId,
						fileIds: newGeneratedFileIds,
						assistantResponse: finalResponse,
					}).catch((error) => {
						console.error(
							"[CHAT_STREAM] Background generated-file memory sync failed",
							{
								conversationId,
								streamId,
								assistantMessageId: assistantMsgId,
								fileIds: newGeneratedFileIds,
								error,
							},
						);
					});
				}

				generatedFiles = (
					await getChatFilesForAssistantMessage(conversationId, assistantMsgId)
				).map(toPublicGeneratedFile);
			}
		} catch (error) {
			console.error(
				"[CHAT_STREAM] Failed to load generated files for end event",
				{
					conversationId,
					streamId,
					error,
				},
			);
		}

		const contextSources =
			persistedContextSources ??
			(await buildChatTurnCompletionContextSources({
				userId,
				conversationId,
				contextStatus: latestContextStatus as ConversationContextStatus | null,
				contextDebug: latestContextDebug as ContextDebugState | null,
				linkedSources,
				activeWorkingSet: latestActiveWorkingSet,
				contextTraceSections:
					latestContextTraceSections ?? initialContextTraceSections ?? [],
				toolCalls: toolCallRecords,
			}));
		const contextCompressionSnapshots = await listContextCompressionSnapshots(
			conversationId,
		)
			.then((snapshots) => snapshots.map(serializeContextCompressionSnapshot))
			.catch(() => []);
		const activeWorkingSet = persistedTurnState
			? persistedTurnState.activeWorkingSet
			: latestActiveWorkingSet;
		const taskState = persistedTurnState
			? persistedTurnState.taskState
			: latestTaskState;
		const contextDebug = persistedTurnState
			? persistedTurnState.contextDebug
			: latestContextDebug;
		const streamDepthMetadata = assistantMsgId
			? withDepthMetadataModelInfo(
					depthMetadata ??
						buildBaselineDepthMetadata({
							reasoningDepth,
							modelId,
							modelDisplayName,
							providerDisplayName,
						}),
					{
						modelId,
						modelDisplayName,
						providerDisplayName,
					},
				)
			: undefined;

		if (thinkingContent) {
			enqueueChunk(streamReasoningEndEvent());
		}
		if (finalResponse) {
			enqueueChunk(streamTextEndEvent());
		}
		enqueueChunk(
			streamDataPartEvent("data-stream-metadata", {
				thinkingTokenCount,
				responseTokenCount,
				totalTokenCount,
				thinking: thinkingContent || undefined,
				wasStopped,
				...(completionWarning
					? {
							completionWarning,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				userMessageId: userMsgId,
				assistantMessageId: assistantMsgId,
				modelId,
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				depthMetadata: streamDepthMetadata,
				contextStatus: latestContextStatus,
				contextSources,
				activeWorkingSet,
				taskState,
				contextDebug,
				generatedFiles,
				contextCompressionSnapshots,
			}),
		);
		enqueueChunk(
			streamFinishEvent(
				streamClosedWithoutFinish ? "error" : (upstreamFinishReason ?? "stop"),
			),
		);
		enqueueChunk(createUiMessageStreamDoneFrame());
		touchConversation(userId, conversationId).catch(() => undefined);
		if (streamId) clearStreamBuffer(streamId);
		closeDownstream();
	};

	try {
		const persistedAssistantResponse =
			wasStopped && finalResponse.trim().length === 0
				? "Stopped"
				: finalResponse;
		const completion = await finalizeChatTurn({
			logPrefix: "[STREAM]",
			streamId,
			userId,
			conversationId,
			userMessageContent: userMessageToPersist,
			persistUserMessage,
			normalizedMessage,
			upstreamMessage,
			assistantResponse: persistedAssistantResponse,
			assistantThinking: thinkingContent || undefined,
			serverSegments: serverSegments.length > 0 ? serverSegments : undefined,
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName,
				providerDisplayName,
				providerIconUrl,
				...(wasStopped ? { wasStopped: true } : {}),
				...(completionWarning
					? {
							completionWarning,
							upstreamFinishReason,
							upstreamRawFinishReason: upstreamRawFinishReason ?? undefined,
						}
					: {}),
				...(streamClosedWithoutFinish ? { streamClosedWithoutFinish } : {}),
				...skillControl.metadata,
			},
			reasoningDepth,
			depthMetadata,
			skillControlOperations: skillControl.operations,
			skillControlSessionId: activeSkillSessionId ?? null,
			attachmentIds,
			activeDocumentArtifactId,
			contextStatus: latestContextStatus as ConversationContextStatus | null,
			initialTaskState,
			initialContextDebug,
			analytics: {
				model: analyticsModel,
				modelDisplayName,
				promptTokens: estimateTokenCount(upstreamMessage),
				completionTokens: responseTokenCount,
				reasoningTokens: thinkingTokenCount,
				generationTimeMs: genTimeMs,
				providerUsage: latestProviderUsage,
			},
			continuitySource: "stream",
			honchoContext: latestHonchoContext,
			honchoSnapshot: latestHonchoSnapshot,
			assistantMirrorContent: wasStopped ? "" : finalResponse,
			maintenanceReason: "chat_stream",
			toolCalls: toolCallRecords,
			contextTraceSections:
				latestContextTraceSections ?? initialContextTraceSections,
			webCitationAudit: citationGate?.audit,
			linkedSources,
			persistenceMode: "best_effort",
			persistAssistantMessage: true,
			persistTurnState: !wasStopped,
			createMessage,
			persistUserTurnAttachments,
			persistAssistantTurnState,
			persistAssistantEvidence,
			runPostTurnTasks,
			persistUserAttachmentsBeforeAssistantMessage: false,
		});
		persistedTurnState = completion.turnState
			? {
					activeWorkingSet: completion.turnState.activeWorkingSet,
					taskState: completion.turnState.taskState,
					contextDebug: completion.turnState.contextDebug,
					workCapsule: completion.turnState.workCapsule,
					attachedArtifacts: completion.attachedArtifacts,
				}
			: null;
		persistedContextSources = completion.turnState
			? completion.contextSources
			: null;
		return sendEndAndClose(
			completion.userMessage?.id,
			completion.assistantMessage?.id,
		).then(() => completion.createPostTurnTask());
	} catch {
		return sendEndAndClose();
	}
}

function appendNotices(response: string, notices: string[]): string {
	if (notices.length === 0) return response;
	const suffix = notices.join("\n\n");
	return response.trim() ? `${response}\n\n${suffix}` : suffix;
}

function buildFileProductionFailureNotice(
	toolCallRecords: ToolCallEntry[],
): string | null {
	const hasFailedFileProductionCall = toolCallRecords.some(
		(record) =>
			isFileProductionToolName(record.name) &&
			record.status === "done" &&
			record.metadata?.ok === false,
	);
	return hasFailedFileProductionCall
		? "Note: File production failed. Check the file card for details or retry the job."
		: null;
}

function buildCompletionWarning(params: {
	upstreamFinishReason?: FinishReason | null;
	upstreamRawFinishReason?: string | null;
	streamClosedWithoutFinish?: boolean;
}): string | null {
	if (params.streamClosedWithoutFinish) {
		return "Note: The upstream model stream ended before a normal completion signal, so this answer may be incomplete.";
	}
	switch (params.upstreamFinishReason) {
		case "length":
			return "Note: The model reached its output limit, so this answer may be incomplete.";
		case "content-filter":
			return "Note: The provider stopped part of the response because of a content filter, so this answer may be incomplete.";
		case "error":
			return "Note: The provider reported an error at the end of the stream, so this answer may be incomplete.";
		case "other":
			return "Note: The provider stopped with a non-standard finish reason, so this answer may be incomplete.";
		default:
			return null;
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
