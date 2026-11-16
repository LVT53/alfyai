import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import {
	currentReading,
	positionRequestSchema,
	reportPosition,
} from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/** The sentence now playing, from the browser's playback time: it lets the service make the sentences ahead. */
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const reading = currentReading(user.id, event.params.sessionId);
	if (!reading) return createJsonErrorResponse("not_found", 404);
	let body: unknown;
	try {
		body = await event.request.json();
	} catch {
		return createJsonErrorResponse("invalid_request", 400);
	}
	const parsed = positionRequestSchema.safeParse(body);
	if (!parsed.success) return createJsonErrorResponse("invalid_request", 400);
	await reportPosition(reading, parsed.data.sentenceId);
	return new Response(null, { status: 204 });
};
