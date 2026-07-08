import { json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { atlasJobs } from "$lib/server/db/schema";
import {
	cancelAtlasJob,
	linkAtlasJobAssistantMessage,
	submitAtlasJobIntake,
	wakeAtlasWorker,
} from "$lib/server/services/atlas";
import { logAttachmentTrace } from "$lib/server/services/attachment-trace";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import { finalizeChatTurn } from "$lib/server/services/chat-turn/finalize";
import { normalizeAssistantOutputWithSkillControl } from "$lib/server/services/chat-turn/normalizer";
import { runPlainNormalChatSendModel } from "$lib/server/services/chat-turn/plain-normal-chat-model-run";
import {
	preflightAtlasTurnSources,
	preflightChatTurn,
} from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import type { ParsedChatTurnRequest } from "$lib/server/services/chat-turn/types";
import { touchConversation } from "$lib/server/services/conversations";
import { listConversationFileProductionJobs } from "$lib/server/services/file-production";
import {
	createArtifactLink,
	isAttachmentReadinessError,
} from "$lib/server/services/knowledge";
import { detectLanguage } from "$lib/server/services/language";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile";
import { getPersonalityProfile } from "$lib/server/services/personality-profiles";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import { applyWebCitationQualityGate } from "$lib/server/services/web-citation-audit";
import type { LinkedContextSource, ToolCallEntry } from "$lib/types";
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

	const runtimeConfig = getConfig();
	const parsedRequest = await parseChatTurnRequest(
		event.request,
		runtimeConfig,
		"send",
	);
	if (!parsedRequest.ok) {
		return json(
			{ error: parsedRequest.error.error, code: parsedRequest.error.code },
			{ status: parsedRequest.error.status },
		);
	}

	if (parsedRequest.value.atlasMode) {
		return runAtlasSendTurn({
			user,
			turn: parsedRequest.value,
		});
	}

	const capacityResponse = buildChatSendCapacityResponse(
		checkStreamCapacity(user.id),
		user.id,
	);
	if (capacityResponse) {
		return capacityResponse;
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
		return await runStandardSendTurn({
			user,
			turn,
			runtimeConfig,
		});
	} catch (error) {
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

async function runAtlasSendTurn({
	user,
	turn,
}: {
	user: { id: string; displayName: string | null; email: string | null };
	turn: ParsedChatTurnRequest;
}): Promise<Response> {
	if (!turn.atlasProfile) {
		return json(
			{
				error: "atlasProfile must be one of overview, in-depth, or exhaustive",
				code: "INVALID_ATLAS_PROFILE",
			},
			{ status: 400 },
		);
	}
	if (!turn.clientAtlasTurnId) {
		return json(
			{
				error: "clientAtlasTurnId is required for Atlas turns",
				code: "MISSING_CLIENT_ATLAS_TURN_ID",
			},
			{ status: 400 },
		);
	}
	const config = getConfig();
	const responseLanguage = detectLanguage(turn.normalizedMessage);
	if (config.atlasWorkerEnabled === false) {
		return json(
			{
				error:
					responseLanguage === "hu"
						? "Az Atlas jelenleg ki van kapcsolva."
						: "Atlas is currently disabled.",
				code: "ATLAS_DISABLED",
			},
			{ status: 503 },
		);
	}
	if (!config.searxngBaseUrl?.trim()) {
		return json(
			{
				error:
					responseLanguage === "hu"
						? "Az Atlas használatához be kell állítani a SearXNG keresést."
						: "Atlas requires SearXNG search to be configured.",
				code: "ATLAS_SEARXNG_REQUIRED",
			},
			{ status: 503 },
		);
	}

	let createdAtlasJobId: string | null = null;
	try {
		const atlasPreflight = await preflightAtlasTurnSources({
			userId: user.id,
			request: turn,
		});
		if (!atlasPreflight.ok) {
			return json(
				{
					error: atlasPreflight.error.error,
					code: atlasPreflight.error.code,
					attachmentIds: atlasPreflight.error.attachmentIds,
				},
				{ status: atlasPreflight.error.status },
			);
		}
		if (turn.atlasAction !== "create" && turn.parentAtlasId) {
			const [parentJob] = await db
				.select({
					id: atlasJobs.id,
					userId: atlasJobs.userId,
					status: atlasJobs.status,
				})
				.from(atlasJobs)
				.where(eq(atlasJobs.id, turn.parentAtlasId))
				.limit(1);
			if (
				!parentJob ||
				parentJob.userId !== user.id ||
				parentJob.status !== "succeeded"
			) {
				return json(
					{
						error:
							"The parent Atlas report must be completed successfully before continuing, forking, or revising.",
					},
					{ status: 409 },
				);
			}
		}
		const intake = await submitAtlasJobIntake({
			userId: user.id,
			conversationId: turn.conversationId,
			query: turn.normalizedMessage,
			profile: turn.atlasProfile,
			action: turn.atlasAction,
			parentAtlasJobId: turn.parentAtlasId,
			clientAtlasTurnId: turn.clientAtlasTurnId,
		});
		const assistantResponse = buildAtlasKickoffAssistantMessage({
			profile: intake.job.profile,
			language: responseLanguage,
		});
		if (intake.reused && intake.job.assistantMessageId) {
			await touchConversation(user.id, turn.conversationId).catch(
				() => undefined,
			);
			return json({
				response: { text: assistantResponse },
				conversationId: turn.conversationId,
				atlasJob: intake.job,
				contextSources: null,
				activeWorkingSet: undefined,
				taskState: undefined,
				contextDebug: undefined,
				generatedFiles: [],
			});
		}
		if (intake.reused && !intake.job.assistantMessageId) {
			await touchConversation(user.id, turn.conversationId).catch(
				() => undefined,
			);
			return json(
				{
					response: { text: assistantResponse },
					conversationId: turn.conversationId,
					atlasJob: intake.job,
					contextSources: null,
					activeWorkingSet: undefined,
					taskState: undefined,
					contextDebug: undefined,
					generatedFiles: [],
				},
				{ status: 202 },
			);
		}
		createdAtlasJobId = intake.job.id;

		const completion = await finalizeChatTurn({
			logPrefix: "[SEND]",
			userId: user.id,
			conversationId: turn.conversationId,
			userMessageContent: turn.normalizedMessage,
			persistUserMessage: true,
			normalizedMessage: turn.normalizedMessage,
			upstreamMessage: turn.normalizedMessage,
			assistantResponse,
			assistantMetadata: {
				evidenceStatus: "not_applicable",
				atlas: {
					jobId: intake.job.id,
					status: intake.job.status,
					stage: intake.job.stage,
					profile: intake.job.profile,
					action: intake.job.action,
					reused: intake.reused,
				},
			},
			reasoningDepth: "auto",
			skillControlOperations: [],
			skillControlSessionId: null,
			attachmentIds: turn.attachmentIds,
			activeDocumentArtifactId: null,
			contextStatus: null,
			initialTaskState: null,
			initialContextDebug: null,
			analytics: {
				model: "atlas",
				modelDisplayName: "Atlas",
				promptTokens: estimateTokenCount(turn.normalizedMessage),
				completionTokens: estimateTokenCount(assistantResponse),
				generationTimeMs: undefined,
				providerUsage: null,
			},
			continuitySource: "send",
			assistantMirrorContent: assistantResponse,
			maintenanceReason: "chat_send",
			linkedSources: atlasPreflight.value.linkedSources,
			toolCalls: [],
			contextTraceSections: [],
			persistenceMode: "strict",
			waitForEvidenceBeforePostTurnTasks: false,
		});
		if (completion.userMessage?.id) {
			await snapshotAtlasLinkedSources({
				userId: user.id,
				conversationId: turn.conversationId,
				userMessageId: completion.userMessage.id,
				linkedSources: atlasPreflight.value.linkedSources,
			});
		}
		await touchConversation(user.id, turn.conversationId).catch(
			() => undefined,
		);
		const atlasJob =
			completion.assistantMessage?.id && !intake.job.assistantMessageId
				? await linkAtlasJobAssistantMessage({
						userId: user.id,
						conversationId: turn.conversationId,
						jobId: intake.job.id,
						assistantMessageId: completion.assistantMessage.id,
					}).catch((error) => {
						console.warn("[ATLAS] Failed to link kickoff assistant message", {
							conversationId: turn.conversationId,
							jobId: intake.job.id,
							error,
						});
						void cancelAtlasJob({
							userId: user.id,
							jobId: intake.job.id,
						});
						return intake.job;
					})
				: intake.job;
		void completion.evidenceTask;
		void completion.createPostTurnTask();
		wakeAtlasWorker();

		return json({
			response: { text: assistantResponse },
			conversationId: turn.conversationId,
			atlasJob,
			contextSources: completion.contextSources,
			activeWorkingSet: completion.turnState?.activeWorkingSet,
			taskState: completion.turnState?.taskState,
			contextDebug: completion.turnState?.contextDebug,
			generatedFiles: completion.generatedFiles,
		});
	} catch (error) {
		console.error("[ATLAS] Send kickoff failed:", error);
		if (createdAtlasJobId) {
			await cancelAtlasJob({
				userId: user.id,
				jobId: createdAtlasJobId,
			}).catch((cancelError) => {
				console.warn("[ATLAS] Failed to cancel failed kickoff job", {
					jobId: createdAtlasJobId,
					error: cancelError,
				});
			});
		}
		return json(
			{
				error:
					responseLanguage === "hu"
						? "Nem sikerült elindítani az Atlast. Próbáld újra."
						: "Failed to start Atlas. Please try again.",
				code: "ATLAS_KICKOFF_FAILED",
			},
			{ status: 500 },
		);
	}
}

function buildAtlasKickoffAssistantMessage({
	profile: _profile,
	language: _language,
}: {
	profile: string;
	language: "en" | "hu";
}): string {
	return "";
}

async function snapshotAtlasLinkedSources(input: {
	userId: string;
	conversationId: string;
	userMessageId: string;
	linkedSources: LinkedContextSource[];
}): Promise<void> {
	for (const source of input.linkedSources) {
		await createArtifactLink({
			userId: input.userId,
			artifactId: source.displayArtifactId,
			relatedArtifactId: source.promptArtifactId,
			conversationId: input.conversationId,
			messageId: input.userMessageId,
			linkType: "linked_context_source",
		});
	}
}

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
	const startedResetGeneration = await getCurrentMemoryResetGeneration(user.id);
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
		assistantMirrorContent: modelRunResult.text ?? "",
		maintenanceReason: "chat_send",
		startedResetGeneration,
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
