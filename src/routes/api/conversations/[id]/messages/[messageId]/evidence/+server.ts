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
			// The citation audit rides the same answer for the same reason, but
			// it is NOT part of the evidence: the turn persists it when its
			// message is created, so it is already there while the evidence may
			// still be pending, and it stays there when the evidence step finds
			// nothing at all.
			...(state.citationAudit !== undefined
				? { citationAudit: state.citationAudit }
				: {}),
		});
	}

	// A settled turn with a citation audit but no evidence summary: the audit is
	// written before the evidence is composed, so this is a real answer — the
	// web research ran and its citations were checked, and there was simply no
	// evidence group to show. Reporting it as "ready" is what lets the live page
	// apply the popover's "Citation audit" row; answering 204 here instead would
	// lose that row until a reload, which is the bug this endpoint exists to
	// close. The pending case is handled above, so this only sees settled turns.
	if (state.citationAudit !== undefined) {
		return json({ status: "ready", citationAudit: state.citationAudit });
	}

	return new Response(null, { status: 204 });
};
