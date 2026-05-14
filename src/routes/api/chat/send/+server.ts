import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import { buildContextSourcesState } from "$lib/server/services/chat-turn/context-sources";
import {
	persistAssistantEvidence,
	persistAssistantTurnState,
	persistUserTurnAttachments,
	runPostTurnTasks,
} from "$lib/server/services/chat-turn/finalize";
import { normalizeAssistantOutput } from "$lib/server/services/chat-turn/normalizer";
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
import { getProjectReferenceContext } from "$lib/server/services/task-state";
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
				personalityPrompt,
				thinkingMode: turn.thinkingMode,
			},
		);
		const text = langflowResult.text ?? "";
		const contextStatus = langflowResult.contextStatus;
		const initialTaskState = langflowResult.taskState;
		const initialContextDebug = langflowResult.contextDebug;
		const contextTraceSections = langflowResult.contextTraceSections;
		const honchoContext = langflowResult.honchoContext;
		const honchoSnapshot = langflowResult.honchoSnapshot;
		const responseText = normalizeAssistantOutput(text);
		const effectiveModelId = langflowResult.modelId ?? turn.modelId ?? "model1";
		const effectiveModelDisplayName =
			langflowResult.modelDisplayName ?? turn.modelDisplayName;

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

		const assistantMessage = await createMessage(
			turn.conversationId,
			"assistant",
			responseText,
			undefined,
			undefined,
			{ evidenceStatus: "pending", modelDisplayName: effectiveModelDisplayName },
		);
		const turnState = await persistAssistantTurnState({
			userId: user.id,
			conversationId: turn.conversationId,
			normalizedMessage: turn.normalizedMessage,
			assistantResponse: responseText,
			attachmentIds: turn.attachmentIds,
			activeDocumentArtifactId: turn.activeDocumentArtifactId,
			contextStatus,
			initialTaskState,
			initialContextDebug,
			userMessageId: userMessage.id,
			assistantMessageId: assistantMessage.id,
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
		});
		await touchConversation(user.id, turn.conversationId).catch(
			() => undefined,
		);

		void persistAssistantEvidence({
			logPrefix: "[SEND]",
			userId: user.id,
			conversationId: turn.conversationId,
			assistantMessageId: assistantMessage.id,
			normalizedMessage: turn.normalizedMessage,
			assistantResponse: responseText,
			attachmentIds: turn.attachmentIds,
			taskState: turnState.taskState,
			contextStatus,
			contextDebug: turnState.contextDebug,
			initialTaskState,
			initialContextDebug,
			contextTraceSections,
		});
		void runPostTurnTasks({
			logPrefix: "[SEND]",
			userId: user.id,
			conversationId: turn.conversationId,
			upstreamMessage,
			assistantMirrorContent: text,
			workCapsule: turnState.workCapsule,
			maintenanceReason: "chat_send",
		});
		const projectReference = await getProjectReferenceContext({
			userId: user.id,
			conversationId: turn.conversationId,
		}).catch(() => null);
		const contextSources = buildContextSourcesState({
			userId: user.id,
			conversationId: turn.conversationId,
			contextStatus,
			contextDebug: turnState.contextDebug,
			activeWorkingSet: turnState.activeWorkingSet,
			projectReference,
		});

		return json({
			response: { text: responseText },
			conversationId: turn.conversationId,
			contextStatus,
			contextSources,
			activeWorkingSet: turnState.activeWorkingSet,
			taskState: turnState.taskState,
			contextDebug: turnState.contextDebug,
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
