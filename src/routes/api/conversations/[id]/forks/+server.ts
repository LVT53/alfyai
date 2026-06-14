import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	ConversationForkError,
	createConversationFork,
} from "$lib/server/services/conversation-forks";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const body = await event.request.json().catch(() => null);
	const messageId =
		body && typeof body.messageId === "string" ? body.messageId.trim() : "";

	if (!messageId) {
		return json({ error: "messageId is required" }, { status: 400 });
	}

	try {
		const result = await createConversationFork({
			userId: user.id,
			sourceConversationId: event.params.id,
			sourceMessageId: messageId,
		});
		return json(result, { status: 201 });
	} catch (error) {
		if (error instanceof ConversationForkError) {
			return json(
				{
					error: error.message,
					code: error.code,
				},
				{ status: error.status },
			);
		}
		console.error("[CONVERSATION_FORK] Failed to create fork:", error);
		return json(
			{ error: "Failed to create conversation fork" },
			{ status: 500 },
		);
	}
};
