import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { findOwnVideoTake } from "$lib/server/services/images/video/card-actions";
import { cancelVideoTake } from "$lib/server/services/images/video/video-job";
import type { RequestHandler } from "./$types";

/** The card's own Stop: may interrupt the segment ComfyUI is already rendering. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const take = await findOwnVideoTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!take) return createJsonErrorResponse("not_found", 404);
	const stopped = await cancelVideoTake(user.id, take.id, { interrupt: true });
	return stopped
		? createJsonResponse({ ok: true })
		: createJsonErrorResponse("not_running", 409);
};
