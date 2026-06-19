import { getConfig } from "$lib/server/config-store";
import { getConversation } from "$lib/server/services/conversations";
import {
	assertPromptReadyAttachments,
	isAttachmentReadinessError,
} from "$lib/server/services/knowledge";
import {
	addConversationLinkedContextSources,
	isLinkedContextSourceError,
} from "$lib/server/services/linked-context-sources";
import { listMessages } from "$lib/server/services/messages";
import {
	resolveSkillPromptContext,
	skillSessionToPromptContext,
} from "$lib/server/services/skills/prompt-context";
import { startSkillSession } from "$lib/server/services/skills/sessions";
import { resolveEffectiveSkillDefinition } from "$lib/server/services/skills/user-skills";
import type { DepthMetadata } from "$lib/types";
import { resolveReasoningDepthSelection } from "./depth-selection";
import type {
	ChatTurnRequestError,
	ParsedChatTurnRequest,
	PreflightedChatTurn,
} from "./types";

const DEPTH_CLARIFICATION_CARRY_FORWARD_PROFILES = new Set([
	"extended",
	"maximum",
]);

type PreflightResult =
	| { ok: true; value: PreflightedChatTurn }
	| { ok: false; error: ChatTurnRequestError };

type PreflightError = Extract<PreflightResult, { ok: false }>;

type SkillSessionStartResult =
	| { ok: true; value: Awaited<ReturnType<typeof startSkillSession>> }
	| PreflightError;

export async function preflightChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<PreflightResult> {
	const { userId, request } = params;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return {
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		};
	}

	const attachmentValidation = await validateAttachmentReadiness(
		userId,
		request,
	);
	if (attachmentValidation) return attachmentValidation;

	const resolvedLinkedSources = await resolveLinkedSources(userId, request);
	if (!resolvedLinkedSources.ok) return resolvedLinkedSources;

	if (request.pendingSkill) {
		const pendingSkillError = await validatePendingSkillAvailability(
			userId,
			request,
		);
		if (pendingSkillError) return pendingSkillError;
	}
	const { depthMetadata, linkedSources } = await resolveDepthMetadata(
		userId,
		request,
		resolvedLinkedSources.value,
	);

	let skillPromptContext = await resolveSkillPromptContext({
		userId,
		turn: {
			...request,
			linkedSources,
			depthMetadata,
		},
	});

	if (request.pendingSkill && skillPromptContext?.source !== "pending_skill") {
		return {
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		};
	}

	if (
		request.pendingSkill &&
		skillPromptContext?.source === "pending_skill" &&
		skillPromptContext.durationPolicy === "session"
	) {
		const pendingSessionSkill = request.pendingSkill;
		const startedSession = await maybeStartSkillSession(
			userId,
			request,
			pendingSessionSkill,
		);
		if (!startedSession.ok) {
			return startedSession;
		}
		skillPromptContext = skillSessionToPromptContext({
			session: startedSession.value,
			linkedSources: skillPromptContext.linkedSources,
			skillResources: skillPromptContext.skillResources,
		});
	}

	return {
		ok: true,
		value: {
			...request,
			linkedSources,
			depthMetadata,
			skillPromptContext,
		},
	};
}

async function validateAttachmentReadiness(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<PreflightError | null> {
	if (request.attachmentIds.length === 0) return null;

	try {
		await assertPromptReadyAttachments({
			userId,
			conversationId: request.conversationId,
			attachmentIds: request.attachmentIds,
			traceId: request.attachmentTraceId,
		});
		return null;
	} catch (error) {
		if (!isAttachmentReadinessError(error)) {
			throw error;
		}
		return {
			ok: false,
			error: {
				status: error.status,
				error: error.message,
				code: error.code,
				attachmentIds: error.attachmentIds,
			},
		};
	}
}

async function resolveLinkedSources(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<
	{ ok: true; value: ParsedChatTurnRequest["linkedSources"] } | PreflightError
> {
	if (request.linkedSources.length === 0) {
		return {
			ok: true,
			value: request.linkedSources,
		};
	}

	if (!getConfig().composerCommandRegistryEnabled) {
		return {
			ok: false,
			error: {
				status: 403,
				error: "Composer Command Registry is disabled.",
				code: "composer_commands_disabled",
			},
		};
	}

	try {
		const linkedSources = await addConversationLinkedContextSources({
			userId,
			conversationId: request.conversationId,
			linkedSources: request.linkedSources,
			attachmentIds: request.attachmentIds,
		});
		return {
			ok: true,
			value: linkedSources,
		};
	} catch (error) {
		if (!isLinkedContextSourceError(error)) {
			throw error;
		}
		return {
			ok: false,
			error: {
				status: error.status,
				error: error.message,
				code: error.code,
			},
		};
	}
}

async function validatePendingSkillAvailability(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<PreflightError | null> {
	if (!request.pendingSkill) return null;

	if (!getConfig().composerCommandRegistryEnabled) {
		return {
			ok: false,
			error: {
				status: 403,
				error: "Composer Command Registry is disabled.",
				code: "composer_commands_disabled",
			},
		};
	}

	const availableSkill = await resolveEffectiveSkillDefinition(userId, {
		id: request.pendingSkill.id,
		ownership: request.pendingSkill.ownership,
	});
	if (!availableSkill.available) {
		return {
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		};
	}

	return null;
}

async function maybeStartSkillSession(
	userId: string,
	request: ParsedChatTurnRequest,
	pendingSkill: NonNullable<ParsedChatTurnRequest["pendingSkill"]>,
): Promise<SkillSessionStartResult> {
	try {
		const session = await startSkillSession(
			userId,
			request.conversationId,
			pendingSkill,
		);
		return {
			ok: true,
			value: session,
		};
	} catch (error) {
		const code = parseErrorCode(error);
		const status = parseErrorStatus(error);

		if (code === "skill_unavailable") {
			return {
				ok: false,
				error: {
					status: 409,
					error: "Selected skill is no longer available.",
					code: "pending_skill_unavailable",
				},
			};
		}

		if (code === "active_skill_session_conflict") {
			return {
				ok: false,
				error: {
					status: typeof status === "number" ? status : 409,
					error: "Another skill session is already active.",
					code: "active_skill_session_conflict",
				},
			};
		}

		throw error;
	}
}

function parseErrorCode(error: unknown): string | undefined {
	if (error instanceof Error && "code" in error) {
		return (error as { code?: unknown }).code as string | undefined;
	}
	return undefined;
}

function parseErrorStatus(error: unknown): number | undefined {
	if (error instanceof Error && "status" in error) {
		return (error as { status?: unknown }).status as number | undefined;
	}
	return undefined;
}

async function resolveDepthMetadata(
	userId: string,
	request: ParsedChatTurnRequest,
	linkedSources: ParsedChatTurnRequest["linkedSources"],
): Promise<{
	depthMetadata: DepthMetadata;
	linkedSources: ParsedChatTurnRequest["linkedSources"];
}> {
	const turnForDepthSelection = {
		...request,
		linkedSources,
	};
	const carriedDepthMetadata = await resolveDepthClarificationCarryForward({
		conversationId: request.conversationId,
		request: turnForDepthSelection,
	});

	if (carriedDepthMetadata) {
		return {
			depthMetadata: carriedDepthMetadata,
			linkedSources,
		};
	}

	return {
		depthMetadata: (
			await resolveReasoningDepthSelection({
				userId,
				conversationId: request.conversationId,
				request: turnForDepthSelection,
			})
		).metadata,
		linkedSources,
	};
}

async function resolveDepthClarificationCarryForward(params: {
	conversationId: string;
	request: Pick<
		ParsedChatTurnRequest,
		| "reasoningDepth"
		| "modelId"
		| "modelDisplayName"
		| "providerDisplayName"
	>;
}): Promise<DepthMetadata | null> {
	const messages = await listMessages(params.conversationId).catch(() => []);
	const previousMessage = messages.at(-1);
	const previousDepthMetadata = previousMessage?.depthMetadata;
	if (
		previousMessage?.role !== "assistant" ||
		previousDepthMetadata?.clarification?.outcome !== "ask" ||
		previousDepthMetadata.requested !== params.request.reasoningDepth ||
		!DEPTH_CLARIFICATION_CARRY_FORWARD_PROFILES.has(
			previousDepthMetadata.appliedProfile,
		)
	) {
		return null;
	}

	const metadata: DepthMetadata = {
		requested: params.request.reasoningDepth,
		appliedProfile: previousDepthMetadata.appliedProfile,
		fallback: previousDepthMetadata.fallback,
	};
	if (previousDepthMetadata.fallbackReason) {
		metadata.fallbackReason = previousDepthMetadata.fallbackReason;
	}
	if (previousDepthMetadata.constraintNote) {
		metadata.constraintNote = previousDepthMetadata.constraintNote;
	}
	if (previousDepthMetadata.classifierSource) {
		metadata.classifierSource = previousDepthMetadata.classifierSource;
	}
	if (previousDepthMetadata.classifierModelSource) {
		metadata.classifierModelSource =
			previousDepthMetadata.classifierModelSource;
	}
	if (previousDepthMetadata.classifierModelId) {
		metadata.classifierModelId = previousDepthMetadata.classifierModelId;
	}
	if (previousDepthMetadata.classifierModelDisplayName) {
		metadata.classifierModelDisplayName =
			previousDepthMetadata.classifierModelDisplayName;
	}
	if (previousDepthMetadata.classifierModelFallbackReason) {
		metadata.classifierModelFallbackReason =
			previousDepthMetadata.classifierModelFallbackReason;
	}
	if (previousDepthMetadata.configuredClassifierModelId) {
		metadata.configuredClassifierModelId =
			previousDepthMetadata.configuredClassifierModelId;
	}
	if (previousDepthMetadata.signals) {
		metadata.signals = { ...previousDepthMetadata.signals };
	}
	if (params.request.modelId) metadata.modelId = params.request.modelId;
	if (params.request.modelDisplayName) {
		metadata.modelDisplayName = params.request.modelDisplayName;
	}
	if (params.request.providerDisplayName) {
		metadata.providerDisplayName = params.request.providerDisplayName;
	}

	return metadata;
}
