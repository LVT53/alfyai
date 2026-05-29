import { getConfig } from "$lib/server/config-store";
import {
	listContextCompressionSnapshots,
	serializeContextCompressionSnapshot,
} from "$lib/server/services/context-compression";
import {
	buildChatTurnCompletionContextSources,
	finalizeChatTurn,
} from "$lib/server/services/chat-turn/finalize";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import type {
	ContextDebugState,
	ContextSourcesState,
	ConversationContextStatus,
	LinkedContextSource,
	ToolCallEntry,
	WebCitationAudit,
} from "$lib/types";
import type { LegacyContextTraceSectionInput } from "./context-trace";
import { parseSkillControlEnvelopePayloads } from "./skill-control-envelope";
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
	getStreamBuffer: (streamId: string) => { userMessage?: string } | null;
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
	) => Promise<Array<{ id: string; name: string }>>;
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
		initialContextStatus,
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

	const citationGate = wasStopped
		? null
		: applyWebCitationQualityGate({
				assistantResponse: fullResponse,
				toolCalls: toolCallRecords,
			});
	const finalResponse = citationGate?.response ?? fullResponse;
	const skillControl = wasStopped
		? { operations: [] }
		: skillControlEnabled
			? parseSkillControlEnvelopePayloads(skillControlEnvelopePayloads)
			: { operations: [] };
	if (citationGate?.appendedNotice) {
		enqueueChunk(
			`event: token\ndata: ${JSON.stringify({ text: `\n\n${citationGate.appendedNotice}` })}\n\n`,
		);
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
	const hadFileProductionToolCall = toolCallSummary.some(
		(record) => record.name === "produce_file",
	);
	let persistedTurnState: PersistedStreamTurnState | null = null;
	let persistedContextSources: ContextSourcesState | null = null;

	if (getConfig().contextDiagnosticsDebug) {
		console.info("[CHAT_STREAM] Tool-call summary", {
			conversationId,
			streamId,
			wasStopped,
			toolCallCount: toolCallSummary.length,
			fileProductionCallCount: toolCallSummary.filter(
				(record) => record.name === "produce_file",
			).length,
			toolCalls: toolCallSummary,
		});
	}

	let userMessageToPersist = normalizedMessage;
	if (isReconnect && streamId) {
		const buffer = getStreamBuffer(streamId);
		if (buffer?.userMessage) {
			userMessageToPersist = buffer.userMessage;
		}
	}
	const sendEndAndClose = async (
		userMsgId?: string,
		assistantMsgId?: string,
	) => {
		let generatedFiles: Array<{ id: string; name: string }> = [];
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

				generatedFiles = await getChatFilesForAssistantMessage(
					conversationId,
					assistantMsgId,
				);
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

		enqueueChunk(
			`event: end\ndata: ${JSON.stringify({
				thinkingTokenCount,
				responseTokenCount,
				totalTokenCount,
				thinking: thinkingContent || undefined,
				wasStopped,
				userMessageId: userMsgId,
				assistantMessageId: assistantMsgId,
				modelId,
				modelDisplayName,
				contextStatus: latestContextStatus,
				contextSources,
				activeWorkingSet,
				taskState,
				contextDebug,
				generatedFiles,
				contextCompressionSnapshots,
			})}\n\n`,
		);
		touchConversation(userId, conversationId).catch(() => undefined);
		if (streamId) clearStreamBuffer(streamId);
		closeDownstream();
	};

	try {
		const completion = await finalizeChatTurn({
			logPrefix: "[STREAM]",
			streamId,
			userId,
			conversationId,
			userMessageContent: userMessageToPersist,
			persistUserMessage,
			normalizedMessage,
			upstreamMessage,
			assistantResponse: finalResponse,
			assistantThinking: thinkingContent || undefined,
			serverSegments: serverSegments.length > 0 ? serverSegments : undefined,
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName,
				...(wasStopped ? { wasStopped: true } : {}),
				...skillControl.metadata,
			},
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
			assistantMirrorContent: finalResponse,
			maintenanceReason: "chat_stream",
			toolCalls: toolCallRecords,
			contextTraceSections:
				latestContextTraceSections ?? initialContextTraceSections,
			webCitationAudit: citationGate?.audit,
			linkedSources,
			persistenceMode: "best_effort",
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
		persistedContextSources = completion.contextSources;
		return sendEndAndClose(
			completion.userMessage?.id,
			completion.assistantMessage?.id,
		).then(() => completion.createPostTurnTask());
	} catch {
		return sendEndAndClose();
	}
}
