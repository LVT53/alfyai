import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	createDocumentArtifact,
	getArtifact,
} from "$lib/server/services/artifacts";
import { getConversation } from "$lib/server/services/conversations";
import {
	getMessageForDocumentKeep,
	updateMessageDocumentLink,
} from "$lib/server/services/messages";
import type { RequestHandler } from "./$types";

/** The first non-empty line, markdown heading markers stripped, capped for a title. */
function deriveTitle(content: string, fallback: string): string {
	const firstLine =
		content.split("\n").find((line) => line.trim().length > 0) ?? "";
	const cleaned = firstLine.replace(/^#{1,6}\s*/, "").trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

// POST /api/conversations/[id]/messages/[messageId]/document — "Open as
// document" (Feature 2 · Artifacts, Slice 1). Idempotent by message: the link
// lives on the message's own metadata (messages.ts), so asking twice answers
// with the SAME artifact instead of creating a second one. This route sits
// beside its siblings under messages/[messageId]/** (evidence, skill-drafts),
// which use requireAuth + event.locals.user rather than requireApiUser —
// ruling 39's requireApiUser is for the routes under /api/artifacts/, and
// this one is a message action that happens to create an artifact, so it
// follows its own directory's convention instead.
export const POST: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	const conversationId = event.params.id;
	const messageId = event.params.messageId;

	const conversation = await getConversation(user.id, conversationId);
	if (!conversation) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const message = await getMessageForDocumentKeep({
		conversationId,
		messageId,
	});
	if (!message || message.content.trim().length === 0) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	if (message.documentArtifactId) {
		const existing = await getArtifact({
			userId: user.id,
			artifactId: message.documentArtifactId,
			conversationId,
		});
		if (existing) {
			return json({
				ok: true,
				artifactId: existing.id,
				title: existing.title,
				created: false,
			});
		}
		// The link points at something gone (deleted since); fall through and
		// keep the message text as a fresh document rather than 404ing on a
		// click that should still work.
	}

	const created = await createDocumentArtifact({
		userId: user.id,
		conversationId,
		title: deriveTitle(message.content, conversation.title),
		markdown: message.content,
		author: "alfy",
		summary: "Kept from a chat reply",
	});
	await updateMessageDocumentLink(messageId, created.id);

	return json({
		ok: true,
		artifactId: created.id,
		title: created.title,
		created: true,
	});
};
