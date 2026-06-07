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

export async function preflightChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<PreflightResult> {
	const { userId, request } = params;
	let resolvedLinkedSources = request.linkedSources;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return {
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		};
	}

	if (request.attachmentIds.length > 0) {
		try {
			await assertPromptReadyAttachments({
				userId,
				conversationId: request.conversationId,
				attachmentIds: request.attachmentIds,
				traceId: request.attachmentTraceId,
			});
		} catch (error) {
			if (isAttachmentReadinessError(error)) {
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
			throw error;
		}
	}

	if (!request.deepResearchDepth && request.linkedSources.length > 0) {
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
			resolvedLinkedSources = await addConversationLinkedContextSources({
				userId,
				conversationId: request.conversationId,
				linkedSources: request.linkedSources,
				attachmentIds: request.attachmentIds,
			});
		} catch (error) {
			if (isLinkedContextSourceError(error)) {
				return {
					ok: false,
					error: {
						status: error.status,
						error: error.message,
						code: error.code,
					},
				};
			}
			throw error;
		}
	}

	if (!request.deepResearchDepth && request.pendingSkill) {
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
	}

	let skillPromptContext = await resolveSkillPromptContext({
		userId,
		turn: {
			...request,
			linkedSources: resolvedLinkedSources,
		},
	});

	if (
		!request.deepResearchDepth &&
		request.pendingSkill &&
		skillPromptContext?.source !== "pending_skill"
	) {
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
		!request.deepResearchDepth &&
		request.pendingSkill &&
		skillPromptContext?.source === "pending_skill" &&
		skillPromptContext.durationPolicy === "session"
	) {
		try {
			const session = await startSkillSession(
				userId,
				request.conversationId,
				request.pendingSkill,
			);
			skillPromptContext = skillSessionToPromptContext({
				session,
				linkedSources: skillPromptContext.linkedSources,
				skillResources: skillPromptContext.skillResources,
			});
		} catch (error) {
			const code =
				error instanceof Error && "code" in error
					? (error as { code?: unknown }).code
					: undefined;
			const status =
				error instanceof Error && "status" in error
					? (error as { status?: unknown }).status
					: undefined;
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

	const turnForDepthSelection = {
		...request,
		linkedSources: resolvedLinkedSources,
	};
	const carriedDepthMetadata = await resolveDepthClarificationCarryForward({
		conversationId: request.conversationId,
		request: turnForDepthSelection,
	});
	const depthMetadata =
		carriedDepthMetadata ??
		(
			await resolveReasoningDepthSelection({
				userId,
				conversationId: request.conversationId,
				request: turnForDepthSelection,
			})
		).metadata;

	return {
		ok: true,
		value: {
			...turnForDepthSelection,
			linkedSources: resolvedLinkedSources,
			depthMetadata,
			skillPromptContext,
		},
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
		| "deepResearchDepth"
	>;
}): Promise<DepthMetadata | null> {
	if (params.request.deepResearchDepth) return null;

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
