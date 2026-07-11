import type { RequestHandler } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { prepareRetryChatTurn } from "$lib/server/services/chat-turn/retry";
import { createStreamJsonErrorResponse } from "$lib/server/services/chat-turn/stream";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile/reset-generation";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return createJsonErrorResponse("Unauthorized", 401);
	}
	const runtimeConfig = getConfig();

	let body: Record<string, unknown>;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON body", 400);
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
		},
		...preparedRetry.value.orchestratorInput,
		downstreamAbortSignal: event.request.signal,
		requestStartTime: Date.now(),
		startedResetGeneration,
	});
};
