import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import {
	finalizeChatTurn,
	persistUserTurnAttachments,
} from "$lib/server/services/chat-turn/finalize";
import { normalizeAssistantOutputWithSkillControl } from "$lib/server/services/chat-turn/normalizer";
import { preflightChatTurn } from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import { touchConversation } from "$lib/server/services/conversations";
import { isAttachmentReadinessError } from "$lib/server/services/knowledge";
import {
	assertCanStartDeepResearchJob,
	isDeepResearchJobStartError,
	startDeepResearchJobShell,
} from "$lib/server/services/deep-research";
import { buildDeepResearchPlanningContext } from "$lib/server/services/deep-research/planning-context";
import { sendMessage } from "$lib/server/services/langflow";
import { createMessage } from "$lib/server/services/messages";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
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

		const langflowResult = await sendMessage(
			upstreamMessage,
			turn.conversationId,
			turn.modelId,
			modelUser,
			{
				attachmentIds: turn.attachmentIds,
				activeDocumentArtifactId: turn.activeDocumentArtifactId,
				attachmentTraceId: turn.attachmentTraceId,
				systemPromptAppendix: skillSystemPromptAppendix,
				personalityPrompt,
				thinkingMode: turn.thinkingMode,
				forceWebSearch: turn.forceWebSearch,
			},
		);
		const text = langflowResult.text ?? "";
		const contextStatus = langflowResult.contextStatus;
		const initialTaskState = langflowResult.taskState;
		const initialContextDebug = langflowResult.contextDebug;
		const contextTraceSections = langflowResult.contextTraceSections;
		const honchoContext = langflowResult.honchoContext;
		const honchoSnapshot = langflowResult.honchoSnapshot;
		const normalizedAssistantOutput =
			normalizeAssistantOutputWithSkillControl(text, {
				skillControlEnabled: runtimeConfig.composerCommandRegistryEnabled,
			});
		const responseText = normalizedAssistantOutput.visibleText;
		const effectiveModelId = langflowResult.modelId ?? turn.modelId ?? "model1";
		const effectiveModelDisplayName =
			langflowResult.modelDisplayName ?? turn.modelDisplayName;

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: user.id,
			conversationId: turn.conversationId,
			userMessageContent: turn.normalizedMessage,
			persistUserMessage: true,
			normalizedMessage: turn.normalizedMessage,
			upstreamMessage,
			assistantResponse: responseText,
			assistantMetadata: {
				evidenceStatus: "pending",
				modelDisplayName: effectiveModelDisplayName,
				...normalizedAssistantOutput.metadata,
			},
			skillControlOperations: normalizedAssistantOutput.operations,
			skillControlSessionId:
				turn.skillPromptContext?.source === "active_session"
					? turn.skillPromptContext.sessionId ?? null
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
				completionTokens: estimateTokenCount(responseText),
				generationTimeMs: undefined,
				providerUsage: langflowResult.providerUsage,
			},
			continuitySource: "send",
			honchoContext,
			honchoSnapshot,
			assistantMirrorContent: text,
			maintenanceReason: "chat_send",
			linkedSources: turn.linkedSources,
			contextTraceSections,
			persistenceMode: "strict",
			waitForEvidenceBeforePostTurnTasks: false,
		});
		await touchConversation(user.id, turn.conversationId).catch(
			() => undefined,
		);
		void completion.evidenceTask;
		void completion.createPostTurnTask();

		return json({
			response: { text: responseText },
			conversationId: turn.conversationId,
			contextStatus,
			contextSources: completion.contextSources,
			activeWorkingSet: completion.turnState?.activeWorkingSet,
			taskState: completion.turnState?.taskState,
			contextDebug: completion.turnState?.contextDebug,
		});
	} catch (error) {
		if (isDeepResearchJobStartError(error)) {
			return json(
				{ error: error.message, code: error.code },
				{ status: error.status },
			);
		}
		console.error("Langflow sendMessage error:", error);
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
