import { requireApiUser } from "$lib/server/api/auth";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { useTake } from "$lib/server/services/images/cards";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const result = await useTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (result.ok)
		return createJsonResponse({ versionNumber: result.versionNumber });
	return createJsonErrorResponse(
		result.reason,
		result.reason === "not_found" ? 404 : 409,
	);
};
