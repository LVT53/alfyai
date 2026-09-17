import { eq } from "drizzle-orm";
import {
	type MessageUserIntent,
	parseMessageUserIntent,
} from "$lib/message-user-intent";
import type { RuntimeConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { listMessageAttachments } from "$lib/server/services/knowledge";
import { messageOrderAsc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { deleteMessages } from "$lib/server/services/messages";
import type { PendingSkillSelection } from "$lib/server/services/skills/types";
import { preflightChatTurn, resolveAppliedSkill } from "./preflight";
import { parseChatTurnRequest, parsePendingSkill } from "./request";
import { cleanupFailedTurn } from "./retry-cleanup";
import type { StreamOrchestratorOptions } from "./stream-orchestrator";
import type { ChatTurnRequestError } from "./types";

const FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE =
	"forked_source_history_confirmation_required";

const REGENERATION_PROMPT_APPENDIX =
	"The user is regenerating their last request. Provide a completely fresh answer without referencing, acknowledging, or building upon your previous response to this same question. Do not mention that you answered this before. Start fresh as if this is the first time you are seeing this query.";

type RetryRequestBody = {
	conversationId?: unknown;
	assistantMessageId?: unknown;
	userMessageId?: unknown;
	userMessage?: unknown;
	activeDocumentArtifactId?: unknown;
	attachmentIds?: unknown;
	streamId?: unknown;
	model?: unknown;
	reasoningDepth?: unknown;
	personalityProfileId?: unknown;
	confirmForkedSourceHistoryMutation?: unknown;
};

export type RetryPreparationError = ChatTurnRequestError & {
	errorKey?: string;
	details?: string;
	responseShape: "json" | "stream-json";
};

export type RetryOrchestratorInput = Pick<
	StreamOrchestratorOptions,
	| "turn"
	| "upstreamMessage"
	| "isReconnect"
	| "systemPromptAppendix"
	| "pendingSkillInstructions"
>;

type RetryPreparationResult =
	| {
			ok: true;
			value: {
				orchestratorInput: RetryOrchestratorInput;
			};
	  }
	| { ok: false; error: RetryPreparationError };

type ConversationMessage = {
	id: string;
	role: string;
	content: string;
	// Raw `messages.metadata_json`. Read for the retried assistant message's
	// `userIntent` record — the only place the user's own turn choices
	// (composer-applied skill, forced `/web`) survive the send that made them.
	metadataJson: string | null;
};

export async function prepareRetryChatTurn(params: {
	userId: string;
	runtimeConfig: RuntimeConfig;
	body: RetryRequestBody;
}): Promise<RetryPreparationResult> {
	const { userId, runtimeConfig, body } = params;
	const {
		conversationId,
		assistantMessageId,
		userMessageId,
		userMessage,
		activeDocumentArtifactId,
		attachmentIds,
		streamId,
		model,
		reasoningDepth,
		personalityProfileId,
		confirmForkedSourceHistoryMutation,
	} = body;

	if (typeof conversationId !== "string" || !conversationId.trim()) {
		return jsonError("conversationId is required", 400);
	}
	if (typeof assistantMessageId !== "string" || !assistantMessageId.trim()) {
		return jsonError("assistantMessageId is required", 400);
	}
	if (typeof userMessageId !== "string" || !userMessageId.trim()) {
		return jsonError("userMessageId is required", 400);
	}
	if (typeof userMessage !== "string" || !userMessage.trim()) {
		return jsonError("userMessage is required", 400);
	}

	const conversation = await getConversation(userId, conversationId);
	if (!conversation) {
		return jsonError("Conversation not found", 404);
	}

	repairConversationMessageSequences(conversationId);

	const conversationMessages = await db
		.select({
			id: messages.id,
			role: messages.role,
			content: messages.content,
			metadataJson: messages.metadataJson,
		})
		.from(messages)
		.where(eq(messages.conversationId, conversationId))
		.orderBy(...messageOrderAsc());

	const assistantIndex = conversationMessages.findIndex(
		(message: ConversationMessage) => message.id === assistantMessageId,
	);
	const assistantMsg =
		assistantIndex >= 0 ? conversationMessages[assistantIndex] : null;
	if (assistantMsg?.role !== "assistant") {
		return jsonError("Assistant message not found", 404);
	}

	const precedingUserMsg = conversationMessages[assistantIndex - 1];
	if (
		precedingUserMsg?.role !== "user" ||
		precedingUserMsg.id !== userMessageId
	) {
		return jsonError(
			"Retry target does not match the preceding user message",
			409,
		);
	}

	if (precedingUserMsg.content.trim() !== userMessage.trim()) {
		return jsonError(
			"Retry user message text does not match persisted message",
			409,
		);
	}

	// The user's own choices for the turn being regenerated, read off the
	// assistant message this retry replaces BEFORE `deleteMessages` below drops
	// it. `conversationMessages` came from a conversation this user owns
	// (`getConversation` above) filtered to `conversationId`, so a record
	// belonging to another user or another conversation is never in reach.
	// Absent (a message persisted before the record existed) and malformed both
	// read as "the user chose nothing" — a plain retry.
	const recordedUserIntent = readRecordedUserIntent(assistantMsg.metadataJson);

	// Probe the recorded skill BEFORE preflight, and drop it when it no longer
	// resolves: a fresh send with an unavailable `pendingSkill` is rightly
	// refused with 409 `pending_skill_unavailable`, but a regenerate of an older
	// turn must not start failing because the user has since deleted or disabled
	// that skill. Only the drop decision is made here; a skill that survives is
	// handed to preflight as an ordinary `pendingSkill` and resolved there
	// again, so the turn is assembled by exactly one code path (the send path's)
	// and against the request's own normalized message.
	//
	// Done before the cleanup/delete below rather than after: this reads the
	// skill tables, and a failure there must not land after the retried turn's
	// messages are already gone, leaving the conversation short an answer it
	// cannot regenerate.
	const retryPendingSkill = await resolveRetryPendingSkill({
		userId,
		skill: recordedUserIntent?.skill,
		requestText: precedingUserMsg.content,
	});

	const trailingMessages = conversationMessages.slice(assistantIndex);
	if (confirmForkedSourceHistoryMutation !== true) {
		const trailingAssistantMessageIds = trailingMessages
			.filter((message: ConversationMessage) => message.role === "assistant")
			.map((message: ConversationMessage) => message.id);
		if (trailingAssistantMessageIds.length > 0) {
			const childForks = await listChildForksBySourceMessages(
				userId,
				trailingAssistantMessageIds,
			);
			const hasChildForks = Object.values(childForks).some(
				(sourceForks) => (sourceForks.count ?? 0) > 0,
			);
			if (hasChildForks) {
				return {
					ok: false,
					error: {
						status: 409,
						error: "Forked source history requires confirmation",
						code: FORKED_SOURCE_HISTORY_CONFIRMATION_REQUIRED_CODE,
						errorKey: "fork.regenerateWarning",
						responseShape: "json",
					},
				};
			}
		}
	}

	const retryAttachmentIds = await resolveRetryAttachmentIds({
		conversationId,
		userMessageId: precedingUserMsg.id,
		requestedAttachmentIds: attachmentIds,
	});

	try {
		const cleanupResult = await cleanupFailedTurn({
			userId,
			conversationId,
			assistantMessageId,
		});
		if (cleanupResult.warnings.length > 0) {
			console.warn("[RETRY] Cleanup warnings:", cleanupResult.warnings);
		}
	} catch (error) {
		console.error("[RETRY] Cleanup failed:", error);
		return {
			ok: false,
			error: {
				status: 500,
				error: "Retry cleanup failed",
				details: error instanceof Error ? error.message : String(error),
				responseShape: "json",
			},
		};
	}

	const trailingMessageIds = trailingMessages.map(
		(message: ConversationMessage) => message.id,
	);
	await deleteMessages(trailingMessageIds);

	if (!precedingUserMsg.content.trim()) {
		return jsonError("No user message found to retry", 400);
	}

	const syntheticBody = buildSyntheticRetryBody({
		conversationId,
		message: precedingUserMsg.content,
		activeDocumentArtifactId,
		attachmentIds: retryAttachmentIds,
		streamId,
		model,
		reasoningDepth,
		personalityProfileId,
		pendingSkill: retryPendingSkill,
		forceWebSearch: recordedUserIntent?.webSearch === true,
	});
	const syntheticRequest = new Request("https://internal", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(syntheticBody),
	});

	const parsedRequest = await parseChatTurnRequest(
		syntheticRequest,
		runtimeConfig,
		"stream",
	);
	if (!parsedRequest.ok) {
		return streamError(parsedRequest.error);
	}

	const preflight = await preflightChatTurn({
		userId,
		request: parsedRequest.value,
	});
	if (!preflight.ok) {
		return streamError(preflight.error);
	}

	const turn = preflight.value;
	const upstreamMessage = turn.normalizedMessage;

	return {
		ok: true,
		value: {
			orchestratorInput: {
				turn,
				upstreamMessage,
				isReconnect: false,
				systemPromptAppendix: REGENERATION_PROMPT_APPENDIX,
				pendingSkillInstructions:
					turn.appliedSkill?.instructionsEnvelope ?? undefined,
			},
		},
	};
}

async function resolveRetryAttachmentIds(params: {
	conversationId: string;
	userMessageId: string;
	requestedAttachmentIds: unknown;
}): Promise<string[]> {
	const explicitAttachmentIds = normalizeStringArray(
		params.requestedAttachmentIds,
	);
	if (explicitAttachmentIds.length > 0) {
		return explicitAttachmentIds;
	}

	const attachmentsByMessage = await listMessageAttachments(
		params.conversationId,
	);
	const persistedAttachments =
		attachmentsByMessage.get(params.userMessageId) ?? [];
	return normalizeStringArray(
		persistedAttachments.map((attachment) => attachment.artifactId),
	);
}

function normalizeStringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];

	const seen = new Set<string>();
	const result: string[] = [];
	for (const item of value) {
		if (typeof item !== "string") continue;
		const normalized = item.trim();
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		result.push(normalized);
	}
	return result;
}

/**
 * The `userIntent` record persisted with an assistant message, or `undefined`
 * for a legacy message that has none (and for anything malformed —
 * `parseMessageUserIntent` validates rather than passes through).
 */
function readRecordedUserIntent(
	metadataJson: string | null | undefined,
): MessageUserIntent | undefined {
	if (!metadataJson) return undefined;
	try {
		const parsed: unknown = JSON.parse(metadataJson);
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			return undefined;
		}
		return parseMessageUserIntent(
			(parsed as { userIntent?: unknown }).userIntent,
		);
	} catch {
		return undefined;
	}
}

/**
 * Turns the recorded `{ id, displayName }` back into the `pendingSkill` a fresh
 * send would have carried, or `null` when the skill no longer resolves for this
 * user (deleted, disabled, unpublished, or the Composer Command Registry turned
 * off) — the caller then regenerates without it.
 *
 * The record deliberately keeps no ownership, but the skill lookup queries on
 * it, so try the one the id implies first (system skills are `system:`-prefixed;
 * a user skill's id is a UUID) and the other only if that misses. The selection
 * goes through `parsePendingSkill` — the same validator a request body's
 * `pendingSkill` gets — and `resolveAppliedSkill`, the same resolver preflight
 * uses, which re-checks ownership and enabled state.
 */
async function resolveRetryPendingSkill(params: {
	userId: string;
	skill: MessageUserIntent["skill"];
	requestText: string;
}): Promise<PendingSkillSelection | null> {
	const { userId, skill, requestText } = params;
	if (!skill) return null;

	const ownerships: Array<"user" | "system"> = skill.id.startsWith("system:")
		? ["system", "user"]
		: ["user", "system"];

	for (const ownership of ownerships) {
		const candidate = parsePendingSkill({
			id: skill.id,
			ownership,
			displayName: skill.displayName,
		});
		if (!candidate) return null;
		const resolved = await resolveAppliedSkill({
			userId,
			pendingSkill: candidate,
			requestText,
		});
		if (resolved.ok) return candidate;
		// The registry being off is not about this skill — the other ownership
		// would fail identically, and so would preflight.
		if (resolved.error.code === "composer_commands_disabled") return null;
	}

	return null;
}

function buildSyntheticRetryBody(params: {
	conversationId: string;
	message: string;
	activeDocumentArtifactId: unknown;
	attachmentIds: unknown;
	streamId: unknown;
	model: unknown;
	reasoningDepth: unknown;
	personalityProfileId: unknown;
	pendingSkill: PendingSkillSelection | null;
	forceWebSearch: boolean;
}): Record<string, unknown> {
	return {
		message: params.message,
		conversationId: params.conversationId,
		// Carried so `parseChatTurnRequest` + `preflightChatTurn` re-apply the
		// user's own choices for this turn exactly as the send path did; the
		// orchestrator then rebuilds the same `userIntent` record from
		// `turn.appliedSkill` / `turn.forceWebSearch` for the regenerated message.
		pendingSkill: params.pendingSkill ?? undefined,
		forceWebSearch: params.forceWebSearch ? true : undefined,
		attachmentIds:
			Array.isArray(params.attachmentIds) && params.attachmentIds.length > 0
				? params.attachmentIds
				: undefined,
		activeDocumentArtifactId:
			typeof params.activeDocumentArtifactId === "string" &&
			params.activeDocumentArtifactId.trim()
				? params.activeDocumentArtifactId.trim()
				: undefined,
		streamId:
			typeof params.streamId === "string" && params.streamId.trim()
				? params.streamId.trim()
				: undefined,
		model:
			typeof params.model === "string" && params.model.trim()
				? params.model.trim()
				: undefined,
		reasoningDepth:
			typeof params.reasoningDepth === "string" && params.reasoningDepth.trim()
				? params.reasoningDepth.trim()
				: undefined,
		personalityProfileId:
			typeof params.personalityProfileId === "string" &&
			params.personalityProfileId.trim()
				? params.personalityProfileId.trim()
				: undefined,
		skipPersistUserMessage: true,
	};
}

function jsonError(
	error: string,
	status: number,
): { ok: false; error: RetryPreparationError } {
	return {
		ok: false,
		error: {
			error,
			status,
			responseShape: "json",
		},
	};
}

function streamError(error: ChatTurnRequestError): {
	ok: false;
	error: RetryPreparationError;
} {
	return {
		ok: false,
		error: {
			...error,
			responseShape: "stream-json",
		},
	};
}
