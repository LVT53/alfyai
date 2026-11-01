// src/routes/api/conversations/[id]/title/+server.ts
import type { RequestEvent } from "@sveltejs/kit";
import {
	createJsonErrorResponse,
	createJsonResponse,
} from "$lib/server/api/responses";
import { ensureConversationTitle } from "$lib/server/services/chat-turn/conversation-title";

// The server names a conversation itself when a turn ends; a page that is still
// there asks here so that it hears the title as soon as it exists. An older tab
// still sends the turn's text in the body, and nothing reads it: the title comes
// from what was stored.
export async function POST({ params, locals }: RequestEvent) {
	try {
		const userId = locals.user?.id;
		if (!userId) {
			return createJsonErrorResponse("Unauthorized", 401);
		}

		const title = await ensureConversationTitle({
			userId,
			conversationId: params.id,
		});
		return createJsonResponse({ title });
	} catch (error) {
		console.error("[TITLE_GENERATE] Failed to generate title", {
			conversationId: params.id,
			error,
		});
		return createJsonResponse({ title: null });
	}
}
