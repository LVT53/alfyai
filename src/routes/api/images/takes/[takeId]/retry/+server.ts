import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { findOwnTake } from "$lib/server/services/images/card-actions";
import { retryTake } from "$lib/server/services/images/image-job";
import type { RequestHandler } from "./$types";

/** Try again: a failed or cancelled take only. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const take = await findOwnTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!take) return createJsonErrorResponse("not_found", 404);
	const queued = await retryTake(user.id, take.id);
	return queued
		? createJsonResponse({ ok: true })
		: createJsonErrorResponse("not_retryable", 409);
};
