import { requireApiUser } from "$lib/server/api/auth";
import { createJsonErrorResponse } from "$lib/server/api/responses";
import { findOwnTake } from "$lib/server/services/images/card-actions";
import { createTakeSettledStream } from "$lib/server/services/images/take-events";
import type { RequestHandler } from "./$types";

// No `Connection` header: it is hop-by-hop, HTTP/2 forbids it outright, and the
// browser's connection is kept open by the stream itself and the heartbeat.
// `X-Accel-Buffering` is what stops a proxy holding the events back.
const SSE_HEADERS = {
	"Content-Type": "text/event-stream",
	"Cache-Control": "no-cache, no-transform",
	"X-Accel-Buffering": "no",
};

/**
 * The take's end, streamed: one `settled` event and a `close`, then the stream
 * ends. A reader — the route writes no job column, and a refusal is the same
 * 401/404 every other take route gives. The chat page's poll stays the fallback
 * for a browser that cannot open the stream.
 */
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");
	const take = await findOwnTake({
		userId: user.id,
		takeId: event.params.takeId,
		conversationId,
	});
	if (!take) return createJsonErrorResponse("not_found", 404);

	return new Response(
		createTakeSettledStream({
			userId: user.id,
			takeId: take.id,
			conversationId,
			initialStatus: take.status,
			signal: event.request.signal,
		}),
		{ status: 200, headers: SSE_HEADERS },
	);
};
