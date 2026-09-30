import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	canvasWebFailureStatus,
	refreshCanvasLiveWeb,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// POST /api/artifacts/[id]/blocks/[nodeId]/refresh — re-runs the search a live-web
// block stores and answers its new snapshot. A route by which a browser makes this
// server call a paid search provider, so it takes the least it can from the
// browser: the board and the block come from the ADDRESS, the reader from the
// session, and NOTHING from the request's body or headers — the route never reads
// them (a test reads this file to see it). What is searched is the query stored on
// the saved board, found by the block's id, by `refreshCanvasLiveWeb`, which owns
// every rule (who may ask, the throttle, the deadline, what a board may keep). The
// request carries no body on purpose: a request the server sees end is one whose
// `signal` fires when the tab goes away, and the search stops with it.
//
// It writes nothing: the editor puts the snapshot on the board and the board's own
// save keeps it as the reader's version.
//
// Same 404 rule as every artifact route (rulings 39/49/51): a missing id, another
// user's board, an incognito chat's board read from outside that chat and something
// that is not a board all answer the identical body. `?conversationId=` names the chat
// the panel shows, which is what lets an incognito chat's own board search.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const result = await refreshCanvasLiveWeb({
		userId: user.id,
		artifactId: event.params.id,
		nodeId: event.params.nodeId,
		conversationId: event.url.searchParams.get("conversationId"),
		signal: event.request.signal,
	});
	if (result.ok) {
		return json({ ok: true, nodeId: result.nodeId, data: result.data });
	}
	return json(
		{ ok: false, reason: result.reason },
		{
			status: canvasWebFailureStatus(result.reason),
			...(result.retryAfterSeconds !== undefined
				? { headers: { "Retry-After": String(result.retryAfterSeconds) } }
				: {}),
		},
	);
};
