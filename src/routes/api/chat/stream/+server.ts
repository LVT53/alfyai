import type { RequestHandler } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConfig } from "$lib/server/config-store";
import { checkStreamCapacity } from "$lib/server/services/chat-turn/active-streams";
import { preflightChatTurn } from "$lib/server/services/chat-turn/preflight";
import { parseChatTurnRequest } from "$lib/server/services/chat-turn/request";
import { createStreamJsonErrorResponse } from "$lib/server/services/chat-turn/stream";
import { runChatStreamOrchestrator } from "$lib/server/services/chat-turn/stream-orchestrator";
import { getCurrentMemoryResetGeneration } from "$lib/server/services/memory-profile";
import { buildSkillSystemPromptAppendix } from "$lib/server/services/skills/prompt-context";

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
	recordPhase("route_parse");

	const isReconnect =
		typeof parsedRequest.value.reconnectToStreamId === "string" &&
		parsedRequest.value.reconnectToStreamId.length > 0;

	// For reconnects, skip capacity check - the orphan stream will be replaced
	// when we register the new stream (registerActiveChatStream handles this)
	if (!isReconnect) {
		const capacity = checkStreamCapacity(user.id);
		recordPhase("capacity");
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
		recordPhase("capacity");
	}

	const preflight = await preflightChatTurn({
		userId: user.id,
		request: parsedRequest.value,
	});
	if (!preflight.ok) {
		return createStreamJsonErrorResponse(preflight.error);
	}
	recordPhase("preflight");

	const turn = preflight.value;

	const upstreamMessage = turn.normalizedMessage;
	const skillSystemPromptAppendix = buildSkillSystemPromptAppendix(
		turn.skillPromptContext,
	);
	const startedResetGeneration = await getCurrentMemoryResetGeneration(user.id);

	return runChatStreamOrchestrator({
		user: {
			id: user.id,
			displayName: user.displayName,
			email: user.email,
		},
		turn,
		upstreamMessage,
		downstreamAbortSignal: event.request.signal,
		requestStartTime,
		startedResetGeneration,
		isReconnect,
		systemPromptAppendix: skillSystemPromptAppendix,
		routePhaseTimings,
	});
};
