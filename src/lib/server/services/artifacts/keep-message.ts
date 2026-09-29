// "Open as document" (Feature 2 · Artifacts, Slice 1): get-or-create the
// Document a chat reply was kept as. Idempotent by message — the link lives on
// the message's own metadata (messages.ts) — and, since the security review's
// L5, idempotent for two presses at once too: a second tab or a double click
// used to arrive while the first was still making the Document, see no live
// link, and make a second one (the message kept only the last, the other was
// left in the panel). One press per message runs at a time here; a press that
// arrives meanwhile is handed that Document instead.
import {
	getMessageForDocumentKeep,
	updateMessageDocumentLink,
} from "$lib/server/services/messages";
import { inlinePlainText } from "$lib/shared/artifact-document/blocks";
import { createDocumentArtifact } from "./document-ops";
import { getArtifact } from "./record";

type KeepMessageAsDocumentResult =
	| { ok: true; artifactId: string; title: string; created: boolean }
	| { ok: false; reason: "not_found" };

/**
 * The first non-empty line's TEXT, capped for a title: heading markers and
 * inline Markdown removed (a reply that opens with "**Weekend plan**" was
 * titled with the asterisks, RV-1A).
 */
function deriveTitle(content: string, fallback: string): string {
	const firstLine =
		content.split("\n").find((line) => line.trim().length > 0) ?? "";
	const cleaned = inlinePlainText(firstLine.replace(/^#{1,6}\s*/, ""))
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : fallback;
}

const keeping = new Map<string, Promise<KeepMessageAsDocumentResult>>();

async function keepOnce(params: {
	userId: string;
	conversationId: string;
	conversationTitle: string;
	messageId: string;
}): Promise<KeepMessageAsDocumentResult> {
	const message = await getMessageForDocumentKeep({
		conversationId: params.conversationId,
		messageId: params.messageId,
	});
	if (!message || message.content.trim().length === 0) {
		return { ok: false, reason: "not_found" };
	}

	if (message.documentArtifactId) {
		const existing = await getArtifact({
			userId: params.userId,
			artifactId: message.documentArtifactId,
			conversationId: params.conversationId,
		});
		if (existing) {
			return {
				ok: true,
				artifactId: existing.id,
				title: existing.title,
				created: false,
			};
		}
		// The link points at something gone (deleted since); fall through and
		// keep the message text as a fresh document rather than failing a click
		// that should still work.
	}

	const created = await createDocumentArtifact({
		userId: params.userId,
		conversationId: params.conversationId,
		title: deriveTitle(message.content, params.conversationTitle),
		markdown: message.content,
		author: "alfy",
		summary: "Kept from a chat reply",
	});
	await updateMessageDocumentLink(params.messageId, created.id);
	return {
		ok: true,
		artifactId: created.id,
		title: created.title,
		created: true,
	};
}

/**
 * The Document this reply was kept as: the one it already has while that still
 * exists, otherwise a new one made from the reply's text. `not_found` for a
 * message that is not an assistant reply of that conversation, or has no text.
 * The caller has already established that the conversation is the user's.
 */
export async function keepMessageAsDocument(params: {
	userId: string;
	conversationId: string;
	conversationTitle: string;
	messageId: string;
}): Promise<KeepMessageAsDocumentResult> {
	const key = `${params.conversationId}:${params.messageId}`;
	const running = keeping.get(key);
	if (running) {
		// A press that arrived while the first was making the Document: the same
		// Document, not a second — and not "created", since this press made nothing.
		const outcome = await running;
		return outcome.ok ? { ...outcome, created: false } : outcome;
	}
	const work = keepOnce(params).finally(() => keeping.delete(key));
	keeping.set(key, work);
	return work;
}
