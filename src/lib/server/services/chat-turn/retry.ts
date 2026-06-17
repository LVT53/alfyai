import { eq } from "drizzle-orm";
import type { RuntimeConfig } from "$lib/server/config-store";
import { db } from "$lib/server/db";
import { messages } from "$lib/server/db/schema";
import { listChildForksBySourceMessages } from "$lib/server/services/conversation-forks";
import { getConversation } from "$lib/server/services/conversations";
import { messageOrderAsc } from "$lib/server/services/message-ordering";
import { repairConversationMessageSequences } from "$lib/server/services/message-sequences";
import { deleteMessages } from "$lib/server/services/messages";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";
import { preflightChatTurn } from "./preflight";
import { parseChatTurnRequest } from "./request";
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
	"turn" | "upstreamMessage" | "isReconnect" | "systemPromptAppendix"
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
		attachmentIds,
		streamId,
		model,
		reasoningDepth,
		personalityProfileId,
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
	const skillSystemPromptAppendix = buildSkillSystemPromptAppendix(
		turn.skillPromptContext,
	);
	const systemPromptAppendix = [
		skillSystemPromptAppendix,
		REGENERATION_PROMPT_APPENDIX,
	]
		.filter((value): value is string => Boolean(value?.trim()))
		.join("\n\n");

	return {
		ok: true,
		value: {
			orchestratorInput: {
				turn,
				upstreamMessage,
				isReconnect: false,
				systemPromptAppendix,
			},
		},
	};
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
}): Record<string, unknown> {
	return {
		message: params.message,
		conversationId: params.conversationId,
		attachmentIds: Array.isArray(params.attachmentIds)
			? params.attachmentIds.filter(
					(id): id is string => typeof id === "string",
				)
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
