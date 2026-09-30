import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { listCanvasChatBlocks } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/chat-blocks — what the Canvas's own chat has that the
// board can hold (the Insert menu's "From this chat"): files, Apps, route maps
// and charts, newest first, a few of each. A thin adapter: the listing, its
// bound and its scope live in the artifacts service. Same 404 rule as every
// artifact route (rulings 39/49/51): a missing id, another user's board, an
// incognito chat's board read from outside that chat and an artifact that is
// not a board all answer the identical body. `?conversationId=` names the chat
// the panel is showing, which is what lets an incognito chat's own board list
// its own work.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const listing = await listCanvasChatBlocks({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: event.url.searchParams.get("conversationId"),
	});
	if (!listing) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({ ok: true, ...listing });
};
