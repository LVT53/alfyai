import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { anotherTake } from "$lib/server/services/images/card-actions";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const result = await anotherTake({
		userId: user.id,
		cardId: event.params.cardId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (result.ok) return createJsonResponse({ takeId: result.takeId }, 201);
	if (result.reason === "not_found") {
		return createJsonErrorResponse(result.reason, 404);
	}
	return createJsonErrorResponse(
		result.reason,
		result.reason === "too_many_takes" ? 409 : 503,
	);
};
