import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { anotherVideoTake } from "$lib/server/services/images/video/card-actions";
import type { RequestHandler } from "./$types";

/**
 * Another take of the card. `cardId` is the card's first take id — the id the
 * read model gives the card and the one the tool's `videoCardId` names.
 */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const result = await anotherVideoTake({
		userId: user.id,
		cardId: event.params.cardId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (result.ok) return createJsonResponse({ takeId: result.takeId }, 201);
	if (result.reason === "not_found") {
		return createJsonErrorResponse(result.reason, 404);
	}
	return createJsonErrorResponse(result.reason, 503);
};
