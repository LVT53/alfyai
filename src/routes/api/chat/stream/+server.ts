import type { RequestHandler } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import {
	admitChatTurnStream,
	checkStreamCapacity,
	createStreamJsonErrorResponse,
	parseChatTurnRequest,
	prepareAdmittedChatTurn,
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
		const capacity = checkStreamCapacity(user.id);
		recordPhase(SERVER_STREAM_TIMELINE_MARKS.CAPACITY);
		if (!capacity.allowed) {
			console.warn("[CHAT_STREAM] Rejected due to capacity", {
				userId: user.id,
				reason: capacity.reason,
				retryAfterSeconds: capacity.retryAfterSeconds,
				currentGlobalCount: capacity.currentGlobalCount,
				currentUserCount: capacity.currentUserCount,
			});

			return new Response(
				JSON.stringify({
					error: "Server at capacity. Please try again later.",
					code: "CAPACITY_EXCEEDED",
					reason: capacity.reason,
					retryAfter: capacity.retryAfterSeconds,
				}),
				{
					status: 503,
					headers: {
						"Content-Type": "application/json",
						"Retry-After": String(capacity.retryAfterSeconds ?? 10),
						"Cache-Control": "no-store",
					},
				},
			);
		}
	} else {
		recordPhase(SERVER_STREAM_TIMELINE_MARKS.CAPACITY);
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
		user: {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
		},
		turn,
		prepareTurn: () =>
			prepareAdmittedChatTurn({
				userId: user.id,
				admittedTurn: turn,
			}),
		upstreamMessage,
		downstreamAbortSignal: event.request.signal,
		requestStartTime,
		startedResetGeneration,
		isReconnect,
		routePhaseTimings,
	});
};
