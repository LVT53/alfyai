import type { RequestHandler } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { requireAuth } from "$lib/server/auth/hooks";
import { requestActiveChatStreamStop } from "$lib/server/services/chat-turn/active-streams";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);

	let body: { streamId?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("Invalid JSON body", 400);
	}

	const streamId =
		typeof body.streamId === "string" && body.streamId.trim().length > 0
			? body.streamId.trim()
			: "";
	if (!streamId) {
		return createJsonErrorResponse("streamId is required", 400);
	}

	const stopped = requestActiveChatStreamStop({
		streamId,
		userId: event.locals.user?.id,
	});

	return createJsonResponse({ stopped });
};
