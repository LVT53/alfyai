import { getConfig } from "$lib/server/config-store";
import type { DepthMetadata } from "$lib/server/services/chat-turn/depth-metadata-types";
import { getConversation } from "$lib/server/services/conversations";
import {
	assertPromptReadyAttachments,
	isAttachmentReadinessError,
} from "$lib/server/services/knowledge";
import {
	addConversationLinkedContextSources,
	isLinkedContextSourceError,
} from "$lib/server/services/linked-context-sources";
import { resolvePendingSkillApplication } from "$lib/server/services/skills/prompt-context";
import { resolveReasoningDepthSelection } from "./depth-selection";
import type {
	AdmittedChatTurn,
	AppliedSkillContext,
	ChatTurnAdmissionResult,
	ChatTurnPreparationResult,
	ChatTurnRequestError,
	ParsedChatTurnRequest,
} from "./types";

type PreflightError = { ok: false; error: ChatTurnRequestError };

export async function preflightChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const admission = await admitChatTurn({ userId, request });
	if (!admission.ok) return admission;

	return prepareAdmittedChatTurn({
		userId,
		admittedTurn: admission.value,
	});
}

export async function admitChatTurnStream(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnAdmissionResult> {
	return admitChatTurn(params);
}

export async function prepareAdmittedChatTurn(params: {
	userId: string;
	admittedTurn: AdmittedChatTurn;
}): Promise<ChatTurnPreparationResult> {
	return prepareChatTurn({
		userId: params.userId,
		request: params.admittedTurn,
	});
}

async function admitChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnAdmissionResult> {
	const { userId, request } = params;
	const conversation = await getConversation(userId, request.conversationId);
	if (!conversation) {
		return {
			ok: false,
			error: { status: 404, error: "Conversation not found" },
		};
	}

	return {
		ok: true,
		value: request as AdmittedChatTurn,
	};
}

async function prepareChatTurn(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<ChatTurnPreparationResult> {
	const { userId, request } = params;
	const attachmentValidation = await validateAttachmentReadiness(
		userId,
		request,
	);
	if (attachmentValidation) return attachmentValidation;

	const resolvedLinkedSources = await resolveLinkedSources(userId, request);
	if (!resolvedLinkedSources.ok) return resolvedLinkedSources;

	let appliedSkill: AppliedSkillContext | null = null;
	if (request.pendingSkill) {
		const applied = await resolveAppliedSkill(userId, request);
		if (!applied.ok) return applied;
		appliedSkill = applied.value;
	}

	const { depthMetadata, linkedSources } = await resolveDepthMetadata(
		userId,
		request,
		resolvedLinkedSources.value,
	);

	return {
		ok: true,
		value: {
			...request,
			linkedSources,
			depthMetadata,
			appliedSkill,
		},
	};
}

export async function preflightAtlasTurnSources(params: {
	userId: string;
	request: ParsedChatTurnRequest;
}): Promise<
	| {
			ok: true;
			value: { linkedSources: ParsedChatTurnRequest["linkedSources"] };
	  }
	| PreflightError
> {
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

	return {
		ok: true,
		value: { linkedSources: resolvedLinkedSources.value },
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

// Resolves an explicit `$` composer selection into this turn's forced skill
// injection (see AppliedSkillContext) — no durable session row. Both the
// "Composer Command Registry disabled" and "skill no longer available"
// failures surface the same request-level errors the pre-refactor
// session-starting flow returned, so existing client error handling for
// `pending_skill_unavailable` / `composer_commands_disabled` keeps working.
async function resolveAppliedSkill(
	userId: string,
	request: ParsedChatTurnRequest,
): Promise<{ ok: true; value: AppliedSkillContext } | PreflightError> {
	const pendingSkill = request.pendingSkill;
	if (!pendingSkill) {
		throw new Error("resolveAppliedSkill called without a pendingSkill");
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

	const resolved = await resolvePendingSkillApplication({
		userId,
		pendingSkill,
		requestText: request.normalizedMessage,
	});
	if (!resolved.ok) {
		return {
			ok: false,
			error: {
				status: 409,
				error: "Selected skill is no longer available.",
				code: "pending_skill_unavailable",
			},
		};
	}

	return {
		ok: true,
		value: {
			skillId: resolved.skillId,
			skillOwnership: resolved.skillOwnership,
			skillKind: resolved.skillKind,
			skillDisplayName: resolved.displayName,
			instructionsEnvelope: resolved.envelope,
		},
	};
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
