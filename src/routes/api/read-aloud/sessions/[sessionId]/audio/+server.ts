import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { attachAudio, currentReading } from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

/**
 * The reading's audio, from its first byte and then live. Every request is
 * served from the reading's replay, whatever its `Range`: the speech service
 * has one reader of each stream, and this server is it.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const reading = currentReading(user.id, event.params.sessionId);
	if (!reading) return createJsonErrorResponse("not_found", 404);
	const audio = attachAudio(reading);
	// Past the replay's cap nobody new can start from the first byte.
	if (!audio) return createJsonErrorResponse("already_read", 409);
	return new Response(audio, {
		status: 200,
		headers: {
			"Content-Type": "audio/mpeg",
			"Cache-Control": "no-store, no-transform",
			"X-Accel-Buffering": "no",
		},
	});
};
