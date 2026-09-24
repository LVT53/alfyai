import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getConversation } from "$lib/server/services/conversations";
import { getMessageEvidenceState } from "$lib/server/services/messages";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const { id: conversationId, messageId } = event.params;

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const state = await getMessageEvidenceState(conversationId, messageId);
	if (!state) {
		return json({ error: "Message not found" }, { status: 404 });
	}

	if (state.status === "pending") {
		return json({ status: "pending" }, { status: 202 });
	}

	if (state.evidenceSummary && state.evidenceSummary.groups.length > 0) {
		return json({
			status: "ready",
			evidenceSummary: state.evidenceSummary,
			// The evidence's own project-files count rides the same answer: it
			// was written in the same metadata write as this summary, and the
			// live page has no other way to learn it (the terminal stream frame
			// cannot carry a number that is only known once the evidence has
			// been composed, after the frame was sent).
			...(state.projectFilesRead !== undefined
				? { projectFilesRead: state.projectFilesRead }
				: {}),
		});
	}

	return new Response(null, { status: 204 });
};
