import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { keepMessageAsDocument } from "$lib/server/services/artifacts";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// POST /api/conversations/[id]/messages/[messageId]/document — "Open as
// document" (Feature 2 · Artifacts, Slice 1). Idempotent by message: the link
// lives on the message's own metadata (messages.ts), so asking twice — one
// press after another or two at once — answers with the SAME artifact instead
// of creating a second one. `keepMessageAsDocument` owns that (and the one-
// press-at-a-time rule); this only checks the conversation is the caller's and
// maps its answer. This route sits beside its siblings under
// messages/[messageId]/** (evidence, skill-drafts), which use requireAuth +
// event.locals.user rather than requireApiUser — ruling 39's requireApiUser is
// for the routes under /api/artifacts/, and this one is a message action that
// happens to create an artifact, so it follows its own directory's convention
// instead.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const conversationId = event.params.id;
	const messageId = event.params.messageId;

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const kept = await keepMessageAsDocument({
		userId: user.id,
		conversationId,
		conversationTitle: conversation.title,
		messageId,
	});
	if (!kept.ok) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({
		ok: true,
		artifactId: kept.artifactId,
		title: kept.title,
		created: kept.created,
	});
};
