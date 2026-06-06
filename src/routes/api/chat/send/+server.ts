import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import {
	getChatFilesForAssistantMessage,
	syncGeneratedFilesToMemory,
} from "$lib/server/services/chat-files";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import {
	finalizeChatTurn,
	persistUserTurnAttachments,
} from "$lib/server/services/chat-turn/finalize";
import { normalizeAssistantOutputWithSkillControl } from "$lib/server/services/chat-turn/normalizer";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import { preflightChatTurn } from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import { touchConversation } from "$lib/server/services/conversations";
import {
	assertCanStartDeepResearchJob,
	isDeepResearchJobStartError,
	startDeepResearchJobShell,
} from "$lib/server/services/deep-research";
import { buildDeepResearchPlanningContext } from "$lib/server/services/deep-research/planning-context";
import {
	assignFileProductionJobsToAssistantMessage,
	listConversationFileProductionJobs,
} from "$lib/server/services/file-production";
import { isAttachmentReadinessError } from "$lib/server/services/knowledge";
import { createMessage } from "$lib/server/services/messages";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import type { ToolCallEntry } from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	// Check capacity limits before processing
	const capacity = checkStreamCapacity(user.id);
	if (!capacity.allowed) {
		console.warn("[CHAT_SEND] Rejected due to capacity", {
			userId: user.id,
			reason: capacity.reason,
			retryAfterSeconds: capacity.retryAfterSeconds,
			currentGlobalCount: capacity.currentGlobalCount,
			currentUserCount: capacity.currentUserCount,
		});

		return json(
			{
				error: "Server at capacity. Please try again later.",
				code: "CAPACITY_EXCEEDED",
				reason: capacity.reason,
				retryAfter: capacity.retryAfterSeconds,
			},
			{
				status: 503,
				headers: {
					"Retry-After": String(capacity.retryAfterSeconds ?? 10),
					"Cache-Control": "no-store",
				},
			},
		);
	}

	const runtimeConfig = getConfig();
	const parsedRequest = await parseChatTurnRequest(
		event.request,
		runtimeConfig,
		"send",
	);
	if (!parsedRequest.ok) {
		return json(
			{ error: parsedRequest.error.error },
			{ status: parsedRequest.error.status },
		);
	}

	const preflight = await preflightChatTurn({
		userId: user.id,
		request: parsedRequest.value,
	});
	if (!preflight.ok) {
		return json(
			{
				error: preflight.error.error,
				code: preflight.error.code,
				attachmentIds: preflight.error.attachmentIds,
			},
			{ status: preflight.error.status },
		);
	}

	const turn = preflight.value;

	try {
		if (turn.deepResearchDepth) {
			if (!runtimeConfig.deepResearchEnabled) {
				return json(
					{
						error: "Deep Research is disabled",
						code: "deep_research_disabled",
					},
					{ status: 403 },
				);
			}
			await assertCanStartDeepResearchJob({
				userId: user.id,
				conversationId: turn.conversationId,
			});
			const userMessage = await createMessage(
				turn.conversationId,
				"user",
				turn.normalizedMessage,
			);
			await persistUserTurnAttachments({
				userId: user.id,
				conversationId: turn.conversationId,
				messageId: userMessage.id,
				normalizedMessage: turn.normalizedMessage,
				attachmentIds: turn.attachmentIds,
			});
			const planningContext = await buildDeepResearchPlanningContext({
				userId: user.id,
				conversationId: turn.conversationId,
				userRequest: turn.normalizedMessage,
				attachmentIds: turn.attachmentIds,
				activeDocumentArtifactId: turn.activeDocumentArtifactId,
			});
			const deepResearchJob = await startDeepResearchJobShell({
				userId: user.id,
				conversationId: turn.conversationId,
				triggerMessageId: userMessage.id,
				userRequest: turn.normalizedMessage,
				depth: turn.deepResearchDepth,
				planningContext,
			});
			await touchConversation(user.id, turn.conversationId).catch(
				() => undefined,
			);

			return json({
				response: null,
				conversationId: turn.conversationId,
				deepResearchJob,
			});
		}

		const upstreamMessage = turn.normalizedMessage;
		const skillSystemPromptAppendix = buildSkillSystemPromptAppendix(
			turn.skillPromptContext,
		);
		let fileProductionJobIdsAtStart = new Set<string>();
		try {
			fileProductionJobIdsAtStart = new Set(
				(
					await listConversationFileProductionJobs(user.id, turn.conversationId)
				).map((job) => job.id),
			);
		} catch (error) {
			console.warn(
				"[CHAT_SEND] Failed to snapshot file-production jobs at send start",
				{
					conversationId: turn.conversationId,
					error,
				},
			);
		}
		const modelUser = {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
		};

		let personalityPrompt: string | undefined;
		if (turn.personalityProfileId) {
			const profile = await getPersonalityProfile(
				turn.personalityProfileId,
			).catch(() => null);
			personalityPrompt = profile?.promptText || undefined;
		}

		const modelRunResult = await runPlainNormalChatSendModel({
			userId: user.id,
			runtimeConfig,
			message: upstreamMessage,
			conversationId: turn.conversationId,
			modelId: turn.modelId,
			user: modelUser,
			attachmentIds: turn.attachmentIds,
			activeDocumentArtifactId: turn.activeDocumentArtifactId,
			attachmentTraceId: turn.attachmentTraceId,
			systemPromptAppendix: skillSystemPromptAppendix,
			personalityPrompt,
			thinkingMode: turn.thinkingMode,
			depthMetadata: turn.depthMetadata,
			forceWebSearch: turn.forceWebSearch,
		});
		const text = modelRunResult.text ?? "";
		const contextStatus = modelRunResult.contextStatus;
		const initialTaskState = modelRunResult.taskState;
		const initialContextDebug = modelRunResult.contextDebug;
		const contextTraceSections = modelRunResult.contextTraceSections;
		const honchoContext = modelRunResult.honchoContext;
		const honchoSnapshot = modelRunResult.honchoSnapshot;
		const normalizedAssistantOutput = normalizeAssistantOutputWithSkillControl(
			text,
			{
				skillControlEnabled: runtimeConfig.composerCommandRegistryEnabled,
			},
		);
		const responseText = normalizedAssistantOutput.visibleText;
		const effectiveModelId = modelRunResult.modelId ?? turn.modelId ?? "model1";
		const effectiveModelDisplayName =
			modelRunResult.modelDisplayName ?? turn.modelDisplayName;
		const finalToolCalls = (
			modelRunResult.toolCalls ?? modelRunResult.prefetchedToolCalls
		)?.filter(isEvidenceReadyToolCall);

		const citationGate = applyWebCitationQualityGate({
			assistantResponse: responseText,
			toolCalls: finalToolCalls,
		});
		const finalResponseText = citationGate.response ?? responseText;
		if (citationGate.appendedNotice) {
			console.warn("[CHAT_SEND] Appended web citation quality notice", {
				conversationId: turn.conversationId,
				status: citationGate.audit?.status,
			});
		}

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: user.id,
			conversationId: turn.conversationId,
			userMessageContent: turn.normalizedMessage,
			persistUserMessage: true,
			normalizedMessage: turn.normalizedMessage,
			upstreamMessage,
			assistantResponse: finalResponseText,
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: effectiveModelDisplayName,
				...normalizedAssistantOutput.metadata,
			},
			reasoningDepth: turn.reasoningDepth,
			depthMetadata: modelRunResult.depthMetadata ?? turn.depthMetadata,
			skillControlOperations: normalizedAssistantOutput.operations,
			skillControlSessionId:
				turn.skillPromptContext?.source === "active_session"
					? (turn.skillPromptContext.sessionId ?? null)
					: null,
			attachmentIds: turn.attachmentIds,
			activeDocumentArtifactId: turn.activeDocumentArtifactId ?? null,
			contextStatus,
			initialTaskState,
			initialContextDebug,
			analytics: {
				model: effectiveModelId,
				modelDisplayName: effectiveModelDisplayName,
				promptTokens: estimateTokenCount(upstreamMessage),
				completionTokens: estimateTokenCount(finalResponseText),
				generationTimeMs: undefined,
				providerUsage: modelRunResult.providerUsage,
			},
			continuitySource: "send",
			honchoContext,
			honchoSnapshot,
			assistantMirrorContent: text,
			maintenanceReason: "chat_send",
			linkedSources: turn.linkedSources,
			toolCalls: finalToolCalls,
			contextTraceSections,
			persistenceMode: "strict",
			waitForEvidenceBeforePostTurnTasks: false,
			webCitationAudit: citationGate.audit,
		});
		await touchConversation(user.id, turn.conversationId).catch(
			() => undefined,
		);
		let generatedFiles: Awaited<
			ReturnType<typeof getChatFilesForAssistantMessage>
		> = [];
		try {
			const assistantMessageId = completion.assistantMessage?.id;
			if (assistantMessageId) {
				const fileProductionJobs = await listConversationFileProductionJobs(
					user.id,
					turn.conversationId,
				);
				const newFileProductionJobs = fileProductionJobs.filter(
					(job) => !fileProductionJobIdsAtStart.has(job.id),
				);
				const newFileProductionJobIds = newFileProductionJobs.map(
					(job) => job.id,
				);

				if (newFileProductionJobIds.length > 0) {
					await assignFileProductionJobsToAssistantMessage(
						user.id,
						turn.conversationId,
						assistantMessageId,
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
						userId: user.id,
						conversationId: turn.conversationId,
						assistantMessageId,
						fileIds: newGeneratedFileIds,
						assistantResponse: finalResponseText,
					}).catch((error) => {
						console.error(
							"[CHAT_SEND] Background generated-file memory sync failed",
							{
								conversationId: turn.conversationId,
								assistantMessageId,
								fileIds: newGeneratedFileIds,
								error,
							},
						);
					});
				}

				generatedFiles = await getChatFilesForAssistantMessage(
					turn.conversationId,
					assistantMessageId,
				);
			}
		} catch (error) {
			console.error("[CHAT_SEND] Failed to attach generated files", {
				conversationId: turn.conversationId,
				error,
			});
		}
		void completion.evidenceTask;
		void completion.createPostTurnTask();

		return json({
			response: { text: finalResponseText },
			conversationId: turn.conversationId,
			contextStatus,
			contextSources: completion.contextSources,
			activeWorkingSet: completion.turnState?.activeWorkingSet,
			taskState: completion.turnState?.taskState,
			contextDebug: completion.turnState?.contextDebug,
			generatedFiles,
		});
	} catch (error) {
		if (isDeepResearchJobStartError(error)) {
			return json(
				{ error: error.message, code: error.code },
				{ status: error.status },
			);
		}
		console.error("Normal Chat Model Run send error:", error);
		if (turn.attachmentTraceId) {
			logAttachmentTrace("send_failure", {
				traceId: turn.attachmentTraceId,
				conversationId: turn.conversationId,
				attachmentIds: turn.attachmentIds,
				errorMessage: error instanceof Error ? error.message : String(error),
				errorCode:
					typeof error === "object" && error !== null && "code" in error
						? ((error as { code?: unknown }).code ?? null)
						: null,
			});
		}
		if (isAttachmentReadinessError(error)) {
			return json(
				{
					error: error.message,
					code: error.code,
					attachmentIds: error.attachmentIds,
				},
				{ status: error.status },
			);
		}
		return json(
			{ error: "Failed to get response from AI. Please try again." },
			{ status: 502 },
		);
	}
};

function isEvidenceReadyToolCall(toolCall: ToolCallEntry): boolean {
	return (
		toolCall.status === "done" &&
		toolCall.metadata?.ok !== false &&
		toolCall.metadata?.evidenceReady !== false
	);
}
