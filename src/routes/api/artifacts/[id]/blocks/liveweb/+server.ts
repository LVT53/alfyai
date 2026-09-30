import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	canvasWebFailureStatus,
	searchCanvasLiveWeb,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

/** A query is at most a block's label, a few hundred characters: nothing real is near this. */
const MAX_BODY_CHARS = 4 * 1024;

// POST /api/artifacts/[id]/blocks/liveweb — searches the web for a query typed into
// the Insert menu and answers the snapshot a new live-web block starts from. A thin
// adapter over `searchCanvasLiveWeb`, which owns every rule (who may ask, the
// throttle, the deadline, what a board may keep); this route only reads the body,
// bounded, and passes the query on as written for the service to judge. The query
// travels in the body, never the address, so no server log's request line has it.
// It writes nothing: the reader's own insert saves the block.
//
// Same 404 rule as every artifact route (rulings 39/49/51). `?conversationId=`
// names the chat the panel shows, so an incognito chat's own board can search.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const declaredChars = Number(event.request.headers.get("content-length"));
	if (Number.isFinite(declaredChars) && declaredChars > MAX_BODY_CHARS) {
		return json({ ok: false, reason: "too_large" }, { status: 413 });
	}
	const raw = await event.request.text().catch(() => null);
	if (raw !== null && raw.length > MAX_BODY_CHARS) {
		return json({ ok: false, reason: "too_large" }, { status: 413 });
	}
	let body: unknown = null;
	try {
		body = raw === null ? null : JSON.parse(raw);
	} catch {
		body = null;
	}
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		return json({ ok: false, reason: "invalid_query" }, { status: 400 });
	}

	const result = await searchCanvasLiveWeb({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: event.url.searchParams.get("conversationId"),
		query: (body as { query?: unknown }).query,
		signal: event.request.signal,
	});
	if (result.ok) return json({ ok: true, data: result.data });
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
