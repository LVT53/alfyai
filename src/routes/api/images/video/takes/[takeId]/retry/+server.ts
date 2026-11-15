import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { findOwnVideoTake } from "$lib/server/services/images/video/card-actions";
import { retryVideoTake } from "$lib/server/services/images/video/video-job";
import type { RequestHandler } from "./$types";

/** Try again: a failed or cancelled take only, and never one the filter blocked. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const take = await findOwnVideoTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!take) return createJsonErrorResponse("not_found", 404);
	const queued = await retryVideoTake(user.id, take.id);
	return queued
		? createJsonResponse({ ok: true })
		: createJsonErrorResponse("not_retryable", 409);
};
