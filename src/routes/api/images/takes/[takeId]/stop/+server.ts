import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { findOwnTake } from "$lib/server/services/images/card-actions";
import { cancelTake } from "$lib/server/services/images/image-job";
import type { RequestHandler } from "./$types";

/** The card's own Stop: may interrupt a prompt ComfyUI is already rendering. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const take = await findOwnTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!take) return createJsonErrorResponse("not_found", 404);
	const stopped = await cancelTake(user.id, take.id, { interrupt: true });
	return stopped
		? createJsonResponse({ ok: true })
		: createJsonErrorResponse("not_running", 409);
};
