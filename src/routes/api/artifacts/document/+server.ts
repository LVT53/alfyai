import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	createDocumentArtifact,
	DocumentOperationError,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// POST /api/artifacts/document — a bare "create a Document" entry point,
// scoped to this one kind (App/Canvas/Slides are created only through Alfy's
// own `create_artifact` tool, never a direct user POST — spec §5). Slice 1
// has exactly one caller: `DocumentBody.svelte`'s "deleted while open"
// escape hatch (`slice-1.md` T7.10), which has no message and no existing
// artifact to key off, unlike T5's "Open as document"
// (`/api/conversations/[id]/messages/[messageId]/document`), so it cannot
// reuse that route. A static segment (`document`) always wins over the
// sibling `[id]` route at the same depth, so this never shadows or is
// shadowed by it.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);

	const payload = (await event.request.json().catch(() => null)) as {
		conversationId?: unknown;
		title?: unknown;
		markdown?: unknown;
	} | null;
	if (!payload || typeof payload.title !== "string" || !payload.title.trim()) {
		return json({ ok: false, reason: "invalid_patch" }, { status: 400 });
	}
	const conversationId =
		typeof payload.conversationId === "string" ? payload.conversationId : null;
	const markdown =
		typeof payload.markdown === "string" ? payload.markdown : undefined;

	let artifact: Awaited<ReturnType<typeof createDocumentArtifact>>;
	try {
		artifact = await createDocumentArtifact({
			userId: user.id,
			conversationId,
			title: payload.title,
			markdown,
			author: "user",
			summary: "Saved as a new document",
		});
	} catch (error) {
		// createDocumentArtifact throws its refusal (its contract has no union);
		// uncaught, it was a 500. Ruling 49's shape instead — and one answer for
		// "missing" and "someone else's" conversation, as everywhere (RV-1A).
		if (!(error instanceof DocumentOperationError)) throw error;
		if (error.reason === "too_large") {
			return json({ ok: false, reason: "too_large" }, { status: 413 });
		}
		if (error.reason === "conversation_not_found") {
			return json({ ok: false, reason: "not_found" }, { status: 404 });
		}
		return json({ ok: false, reason: "invalid_patch" }, { status: 400 });
	}

	return json({ ok: true, artifact });
};
