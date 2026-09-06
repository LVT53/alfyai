import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversationDetail } from "$lib/server/services/conversation-detail/read-model";
import {
	conversationExportFilename,
	renderConversationMarkdown,
} from "$lib/server/services/conversation-export";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id } = event.params;
	const detail = await getConversationDetail({
		userId: user.id,
		conversationId: id,
		view: "full",
	});
	if (!detail) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const markdown = renderConversationMarkdown(
		detail.conversation.title,
		detail.messages,
	);
	const filename = conversationExportFilename(detail.conversation.title);

	return new Response(markdown, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Content-Disposition": `attachment; filename="${filename}"`,
			"Cache-Control": "no-store",
		},
	});
};
