import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { closeReading, currentReading } from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/** A stop or a jump: cancels the person's reading. Any other id is not theirs, so 404. */
export const DELETE: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const reading = currentReading(user.id, event.params.sessionId);
	if (!reading) return createJsonErrorResponse("not_found", 404);
	await closeReading(reading);
	return new Response(null, { status: 204 });
};
