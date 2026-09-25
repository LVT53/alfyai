import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { listArtifactsForConversation } from "$lib/server/services/artifacts";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// GET /api/artifacts?conversationId=… — the panel list's and the chat
// header count button's one source: every artifact-family row for a
// conversation, newest first. The conversation itself must belong to the
// caller before its artifacts are read — listArtifactsForConversation is
// already scoped to userId, but that alone cannot distinguish "empty" from
// "not yours" for the 404 this route promises (ruling 39: 401 comes from
// requireApiUser/hooks.server.ts, never a route-local check).
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");
	if (!conversationId) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const artifacts = await listArtifactsForConversation({
		userId: user.id,
		conversationId,
	});
	return json({ artifacts });
};
