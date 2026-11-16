import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { attachEvents, currentReading } from "$lib/server/services/read-aloud";
import type { RequestHandler } from "./$types";

// The same headers as the take events: no `Connection` (hop-by-hop, and HTTP/2
// forbids it), and `X-Accel-Buffering` stops a proxy holding the events back.
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	"X-Accel-Buffering": "no",
};

/** The reading's timeline: the service's events replayed from the first, then live, and `replaced` when another reading takes over. */
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const reading = currentReading(user.id, event.params.sessionId);
	if (!reading) return createJsonErrorResponse("not_found", 404);
	return new Response(attachEvents(reading), {
		status: 200,
		headers: SSE_HEADERS,
	});
};
