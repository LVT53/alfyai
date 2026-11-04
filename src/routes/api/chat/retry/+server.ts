import type { RequestHandler } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	createStreamJsonErrorResponse,
	findWaitingQuestionRefusal,
	prepareRetryChatTurn,
	refuseTurnWhenDraining,
	runChatStreamOrchestrator,
} from "$lib/server/services/chat-turn";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile/reset-generation";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return createJsonErrorResponse("Unauthorized", 401);
	}
	// Before anything is read or deleted: a regenerate deletes the reply it replaces
	// before the model runs, and a turn started while the server drains is cut by the
	// restart. Refused like a new message (the page waits for the update).
	const refused = refuseTurnWhenDraining(user.id, "CHAT_RETRY");
	if (refused) return refused;
	const runtimeConfig = getConfig();

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON body", 400);
	}

	// "Ask me first": a retry deletes the reply it replaces while it prepares, before
	// the stream's arbiter has seen the turn. While the chat holds a saved question
	// that waits, or whose answer is being carried on, that reply may be the row the
	// resume continues, so the retry is turned away like a new message.
	if (typeof body.conversationId === "string" && body.conversationId.trim()) {
		const questionWaiting = await findWaitingQuestionRefusal({
			userId: user.id,
			conversationId: body.conversationId.trim(),
		});
		if (questionWaiting) return createStreamJsonErrorResponse(questionWaiting);
	}

	const preparedRetry = await prepareRetryChatTurn({
		userId: user.id,
		runtimeConfig,
		body,
	});
	if (!preparedRetry.ok) {
		const { responseShape, errorKey, details, ...requestError } =
			preparedRetry.error;
		if (responseShape === "stream-json") {
			return createStreamJsonErrorResponse(requestError);
		}
		return createJsonResponse(
			{
				error: requestError.error,
				...(requestError.code ? { code: requestError.code } : {}),
				...(errorKey ? { errorKey } : {}),
				...(details ? { details } : {}),
			},
			requestError.status,
		);
	}
	const startedResetGeneration = await getCurrentMemoryResetGeneration(user.id);
	return runChatStreamOrchestrator({
		user: {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
			uiLanguage: user.uiLanguage,
		},
		...preparedRetry.value.orchestratorInput,
		downstreamAbortSignal: event.request.signal,
		requestStartTime: Date.now(),
		startedResetGeneration,
	});
};
