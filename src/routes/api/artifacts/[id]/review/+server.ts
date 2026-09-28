import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	acknowledgeDocumentReviewBlocks,
	getDocumentReviewState,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/review — ruling 61's first point: the pending set,
// recomputed fresh on every read (never written here — the marker only moves
// on an Alfy edit, in `applyDocumentPatch`, or on acknowledge, below). Same
// 404 rule as every artifact route (ruling 39/49): a missing id, another
// user's artifact, and an incognito one read from outside its own
// conversation all answer the identical body. Not a Document (App/Canvas/
// Slides/File — ruling 61 is Documents only) answers the same `not_found`
// shape as a missing id: there is nothing here to distinguish for a kind that
// was never a candidate.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const result = await getDocumentReviewState({
		userId: user.id,
		artifactId,
		conversationId,
	});
	if (!result.ok) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({ ok: true, pending: result.pending });
};

// POST /api/artifacts/[id]/review — { blockIds } acknowledges those blocks
// (Keep, Undo, Keep all, Undo all all call this the same way: the caller
// names which blocks it just resolved). Answers the recomputed pending list
// so the caller can resync without a second round trip.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		blockIds?: unknown;
	} | null;
	const blockIds = Array.isArray(payload?.blockIds)
		? payload.blockIds.filter((id): id is string => typeof id === "string")
		: [];

	const result = await acknowledgeDocumentReviewBlocks({
		userId: user.id,
		artifactId,
		conversationId,
		blockIds,
	});
	if (!result.ok) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return json({ ok: true, pending: result.pending });
};
