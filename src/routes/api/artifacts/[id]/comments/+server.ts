import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { createComment, getArtifact } from "$lib/server/services/artifacts";
import type { Anchor } from "$lib/shared/artifacts/anchor";
import type { RequestHandler } from "./$types";

// POST /api/artifacts/[id]/comments — creates a root comment (T10.1). Thin
// and ownership-scoped like every route in this family (ruling 39: 401 comes
// from requireApiUser). The author is ALWAYS "user" here, whatever the
// request body carries: a comment can only ever be authored "alfy" through
// `runAlfyCommentReply`'s own reply, never through this client-facing route
// (T10.7 — a client cannot author as Alfy).
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		anchor?: unknown;
		body?: unknown;
		parentId?: unknown;
	} | null;
	if (!payload || typeof payload.body !== "string" || !payload.body.trim()) {
		return json({ ok: false, reason: "invalid_request" }, { status: 400 });
	}

	const artifact = await getArtifact({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const comment = await createComment({
		userId: user.id,
		artifactId,
		conversationId,
		// createComment (`toAnchor`) validates the real shape; this route only
		// forwards whatever the client sent, never trusting this assertion.
		anchor: (payload.anchor ?? null) as Anchor | null,
		author: "user",
		body: payload.body,
		parentId: typeof payload.parentId === "string" ? payload.parentId : null,
	});
	if (!comment) {
		return json({ ok: false, reason: "invalid_request" }, { status: 400 });
	}

	return json({ ok: true, comment });
};
