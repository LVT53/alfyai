import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getStreamConversationStatus } from "$lib/server/services/chat-turn/active-streams";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const conversationId = event.url.searchParams.get("conversationId");
	if (!conversationId) {
		return json({ error: "conversationId is required" }, { status: 400 });
	}

	return json(
		getStreamConversationStatus({
			userId: user.id,
			conversationId,
		}),
	);
};
