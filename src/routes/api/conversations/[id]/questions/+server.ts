import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { listConversationAskQuestions } from "$lib/server/services/chat-turn";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// GET /api/conversations/[id]/questions: the questions Alfy asked in this chat
// ("Ask me first"), for the card and its folded line: the words, the state and the
// answer of each. The store lists what the browser reads (`AskQuestionDto`), never
// what the resume starts from, so the capture of the paused reply stays on the server.
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const conversationId = event.params.id;

	const conversation = await getConversation(userId, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	return json({
		questions: await listConversationAskQuestions({ userId, conversationId }),
	});
};
