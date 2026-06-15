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
import { listConversationFileProductionJobs } from "$lib/server/services/file-production";
import { isAttachmentReadinessError } from "$lib/server/services/knowledge";
import { createMessage } from "$lib/server/services/messages";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import type { ToolCallEntry } from "$lib/types";
import { estimateTokenCount } from "$lib/utils/tokens";
import type { RequestHandler } from "./$types";

type PreflightChatTurnResult = Awaited<ReturnType<typeof preflightChatTurn>>;
type SendTurn = Extract<PreflightChatTurnResult, { ok: true }>["value"];

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const capacityResponse = buildChatSendCapacityResponse(
		checkStreamCapacity(user.id),
		user.id,
	);
	if (capacityResponse) {
		return capacityResponse;
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
			return await runDeepResearchTurn({
				userId: user.id,
				turn,
				runtimeConfig,
			});
		}

		return await runStandardSendTurn({
			user,
			turn,
			runtimeConfig,
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

function buildChatSendCapacityResponse(
	capacity: ReturnType<typeof checkStreamCapacity>,
	userId: string,
): Response | null {
	if (capacity.allowed) {
		return null;
	}

	console.warn("[CHAT_SEND] Rejected due to capacity", {
		userId,
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

async function runDeepResearchTurn(params: {
	userId: string;
	turn: SendTurn;
	runtimeConfig: ReturnType<typeof getConfig>;
}): Promise<Response> {
	if (!params.runtimeConfig.deepResearchEnabled) {
		return json(
			{
				error: "Deep Research is disabled",
				code: "deep_research_disabled",
			},
			{ status: 403 },
		);
	}

	await assertCanStartDeepResearchJob({
		userId: params.userId,
		conversationId: params.turn.conversationId,
	});
	const deepResearchDepth = params.turn.deepResearchDepth as NonNullable<
		SendTurn["deepResearchDepth"]
	>;
	const userMessage = await createMessage(
		params.turn.conversationId,
		"user",
		params.turn.normalizedMessage,
	);
	await persistUserTurnAttachments({
		userId: params.userId,
		conversationId: params.turn.conversationId,
		messageId: userMessage.id,
		normalizedMessage: params.turn.normalizedMessage,
		attachmentIds: params.turn.attachmentIds,
	});
	const planningContext = await buildDeepResearchPlanningContext({
		userId: params.userId,
		conversationId: params.turn.conversationId,
		userRequest: params.turn.normalizedMessage,
		attachmentIds: params.turn.attachmentIds,
		activeDocumentArtifactId: params.turn.activeDocumentArtifactId,
	});
	const deepResearchJob = await startDeepResearchJobShell({
		userId: params.userId,
		conversationId: params.turn.conversationId,
		triggerMessageId: userMessage.id,
		userRequest: params.turn.normalizedMessage,
		depth: deepResearchDepth,
		planningContext,
	});
	await touchConversation(params.userId, params.turn.conversationId).catch(
		() => undefined,
	);

	return json({
		response: null,
		conversationId: params.turn.conversationId,
		deepResearchJob,
	});
}

async function runStandardSendTurn({
	user,
	turn,
	runtimeConfig,
}: {
	user: { id: string; displayName: string | null; email: string | null };
	turn: SendTurn;
	runtimeConfig: ReturnType<typeof getConfig>;
}): Promise<Response> {
	const upstreamMessage = turn.normalizedMessage;
	const skillSystemPromptAppendix = buildSkillSystemPromptAppendix(
		turn.skillPromptContext,
	);
	const fileProductionJobIdsAtStart = await snapshotConversationFileJobs({
		userId: user.id,
		conversationId: turn.conversationId,
	});
	const personalityPrompt = await resolvePersonalityPrompt(
		turn.personalityProfileId,
	);

	const modelRunResult = await runPlainNormalChatSendModel({
		userId: user.id,
		runtimeConfig,
		message: upstreamMessage,
		conversationId: turn.conversationId,
		modelId: turn.modelId,
		user: buildModelUser(user),
		attachmentIds: turn.attachmentIds,
		activeDocumentArtifactId: turn.activeDocumentArtifactId,
		attachmentTraceId: turn.attachmentTraceId,
		systemPromptAppendix: skillSystemPromptAppendix,
		personalityPrompt,
		thinkingMode: turn.thinkingMode,
		depthMetadata: turn.depthMetadata,
		forceWebSearch: turn.forceWebSearch,
	});

	const modelRunArtifacts = normalizeModelRunOutput({
		runtimeConfig,
		turn,
		modelRunResultText: modelRunResult.text ?? "",
		modelRunResult,
	});
	const finalResponseText =
		modelRunArtifacts.citationGate.response ?? modelRunArtifacts.responseText;
	const contextStatus = modelRunResult.contextStatus;

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
			modelDisplayName: modelRunArtifacts.effectiveModelDisplayName,
			...modelRunArtifacts.normalizedAssistantOutput.metadata,
		},
		reasoningDepth: turn.reasoningDepth,
		depthMetadata: modelRunResult.depthMetadata ?? turn.depthMetadata,
		skillControlOperations:
			modelRunArtifacts.normalizedAssistantOutput.operations,
		skillControlSessionId:
			turn.skillPromptContext?.source === "active_session"
				? (turn.skillPromptContext.sessionId ?? null)
				: null,
		attachmentIds: turn.attachmentIds,
		activeDocumentArtifactId: turn.activeDocumentArtifactId ?? null,
		contextStatus,
		initialTaskState: modelRunResult.taskState,
		initialContextDebug: modelRunResult.contextDebug,
		analytics: {
			model: modelRunArtifacts.effectiveModelId,
			modelDisplayName: modelRunArtifacts.effectiveModelDisplayName,
			promptTokens: estimateTokenCount(upstreamMessage),
			completionTokens: estimateTokenCount(finalResponseText),
			generationTimeMs: undefined,
			providerUsage: modelRunResult.providerUsage,
		},
		continuitySource: "send",
		honchoContext: modelRunResult.honchoContext,
		honchoSnapshot: modelRunResult.honchoSnapshot,
		assistantMirrorContent: modelRunResult.text ?? "",
		maintenanceReason: "chat_send",
		linkedSources: turn.linkedSources,
		toolCalls: modelRunArtifacts.finalToolCalls,
		contextTraceSections: modelRunResult.contextTraceSections,
		persistenceMode: "strict",
		waitForEvidenceBeforePostTurnTasks: false,
		webCitationAudit: modelRunArtifacts.citationGate.audit,
		generatedOutputReconciliation: {
			fileProductionJobIdsAtStart,
		},
	});
	await touchConversation(user.id, turn.conversationId).catch(() => undefined);
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
		generatedFiles: completion.generatedFiles,
	});
}

async function snapshotConversationFileJobs({
	userId,
	conversationId,
}: {
	userId: string;
	conversationId: string;
}): Promise<Set<string>> {
	try {
		const jobs = await listConversationFileProductionJobs(
			userId,
			conversationId,
		);
		return new Set(jobs.map((job) => job.id));
	} catch (error) {
		console.warn(
			"[CHAT_SEND] Failed to snapshot file-production jobs at send start",
			{
				conversationId,
				error,
			},
		);
		return new Set();
	}
}

async function resolvePersonalityPrompt(
	personalityProfileId: string | null | undefined,
) {
	if (!personalityProfileId) return undefined;
	const profile = await getPersonalityProfile(personalityProfileId).catch(
		() => null,
	);
	return profile?.promptText || undefined;
}

function buildModelUser(user: {
	id: string;
	displayName: string | null;
	email: string | null;
}) {
	return {
		id: user.id,
		displayName: user.displayName,
		email: user.email,
	};
}

function normalizeModelRunOutput({
	runtimeConfig,
	turn,
	modelRunResultText,
	modelRunResult,
}: {
	runtimeConfig: ReturnType<typeof getConfig>;
	turn: SendTurn;
	modelRunResultText: string;
	modelRunResult: Awaited<ReturnType<typeof runPlainNormalChatSendModel>>;
}) {
	const normalizedAssistantOutput = normalizeAssistantOutputWithSkillControl(
		modelRunResultText,
		{
			skillControlEnabled: runtimeConfig.composerCommandRegistryEnabled,
		},
	);
	const responseText = normalizedAssistantOutput.visibleText;
	const finalToolCalls = (
		modelRunResult.toolCalls ?? modelRunResult.prefetchedToolCalls
	)?.filter(isEvidenceReadyToolCall);
	const citationGate = applyWebCitationQualityGate({
		assistantResponse: responseText,
		toolCalls: finalToolCalls,
	});
	if (citationGate.appendedNotice) {
		console.warn("[CHAT_SEND] Appended web citation quality notice", {
			conversationId: turn.conversationId,
			status: citationGate.audit?.status,
		});
	}

	return {
		normalizedAssistantOutput,
		responseText,
		citationGate,
		finalToolCalls,
		effectiveModelId: modelRunResult.modelId ?? turn.modelId ?? "model1",
		effectiveModelDisplayName:
			modelRunResult.modelDisplayName ?? turn.modelDisplayName,
	};
}

function isEvidenceReadyToolCall(toolCall: ToolCallEntry): boolean {
	return (
		toolCall.status === "done" &&
		toolCall.metadata?.ok !== false &&
		toolCall.metadata?.evidenceReady !== false
	);
}
