import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversation } from "$lib/server/services/conversations";
import {
	conversationExportFilename,
	renderConversationMarkdown,
} from "$lib/server/services/conversation-export";
import { listMessages } from "$lib/server/services/messages";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id } = event.params;
	// Ownership gate first (`getConversation` is scoped by userId), then the
	// FULL message history. This deliberately does not go through
	// `getConversationDetail`: that read model returns a bounded message
	// *window* (CONVERSATION_MESSAGE_WINDOW_DEFAULT_LIMIT = 100, newest
	// first), so exporting a longer conversation through it silently dropped
	// everything before the last 100 turns — and it assembles a large amount
	// of state (atlas jobs, knowledge working set, task state, forks) that a
	// Markdown export has no use for.
	const conversation = await getConversation(user.id, id);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const messages = await listMessages(id);
	const markdown = renderConversationMarkdown(conversation.title, messages);
	const filename = conversationExportFilename(conversation.title);

	return new Response(markdown, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		},
	});
};
