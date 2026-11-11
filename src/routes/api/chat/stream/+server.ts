import type { RequestHandler } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	admitChatTurnStream,
	createStreamJsonErrorResponse,
	findWaitingQuestionRefusal,
	parseChatTurnRequest,
	prepareAdmittedChatTurn,
	refuseTurnWhenOverCapacity,
	runChatStreamOrchestrator,
	startStartedResetGenerationFact,
} from "$lib/server/services/chat-turn";
import { SERVER_STREAM_TIMELINE_MARKS } from "$lib/services/stream-timeline";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		throw new Error("Authenticated user missing after auth check");
	}

	const requestStartTime = Date.now();
	const routePhaseTimings: Record<string, number> = {};
	let phaseStartedAt = requestStartTime;
	const recordPhase = (name: string) => {
		const now = Date.now();
		routePhaseTimings[name] = now - phaseStartedAt;
		phaseStartedAt = now;
	};
	const runtimeConfig = getConfig();

	// Parse request first to detect if this is a reconnect to an orphaned stream
	const parsedRequest = await parseChatTurnRequest(
		event.request,
		runtimeConfig,
		"stream",
	);
	if (!parsedRequest.ok) {
		return createStreamJsonErrorResponse(parsedRequest.error);
	}
	recordPhase(SERVER_STREAM_TIMELINE_MARKS.ROUTE_PARSE);

	if (parsedRequest.value.atlasMode) {
		return createStreamJsonErrorResponse({
			status: 400,
			error: "Atlas turns must be started through /api/chat/send.",
			code: "ATLAS_STREAM_UNSUPPORTED",
		});
	}

	const isReconnect =
		typeof parsedRequest.value.reconnectToStreamId === "string" &&
		parsedRequest.value.reconnectToStreamId.length > 0;

	// For reconnects, skip capacity check - the orphan stream will be replaced
	// when we register the new stream (registerActiveChatStream handles this)
	if (!isReconnect) {
		const refused = refuseTurnWhenOverCapacity(user.id, "CHAT_STREAM");
		recordPhase(SERVER_STREAM_TIMELINE_MARKS.CAPACITY);
		if (refused) return refused;
	} else {
		recordPhase(SERVER_STREAM_TIMELINE_MARKS.CAPACITY);
	}

	// "Ask me first": a chat that holds a saved question that waits takes no new
	// message (the page reads the questions again and puts the words back in the
	// draft). A reconnect is no new message, and neither is an edit's resend: the
	// edit of an earlier message removes the rows after it, the question with the
	// row that asked it.
	if (!isReconnect && parsedRequest.value.turnOrigin !== "edit_resend") {
		const questionWaiting = await findWaitingQuestionRefusal({
			userId: user.id,
			conversationId: parsedRequest.value.conversationId,
		});
		if (questionWaiting) return createStreamJsonErrorResponse(questionWaiting);
	}

	const admission = await admitChatTurnStream({
		userId: user.id,
		request: parsedRequest.value,
	});
	if (!admission.ok) {
		return createStreamJsonErrorResponse(admission.error);
	}
	recordPhase(SERVER_STREAM_TIMELINE_MARKS.ADMISSION);

	const turn = admission.value;

	const upstreamMessage = turn.normalizedMessage;
	const startedResetGeneration = startStartedResetGenerationFact(user.id);
	return runChatStreamOrchestrator({
		compactOutput:
			event.request.headers.get("X-Alfy-Output-Transport") === "compact-v1",
		user: {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
			uiLanguage: user.uiLanguage,
		},
		turn,
		prepareTurn: (signal) =>
			prepareAdmittedChatTurn({
				userId: user.id,
				admittedTurn: turn,
				signal: AbortSignal.any([event.request.signal, signal]),
			}),
		upstreamMessage,
		downstreamAbortSignal: event.request.signal,
		requestStartTime,
		startedResetGeneration,
		isReconnect,
		routePhaseTimings,
	});
};
