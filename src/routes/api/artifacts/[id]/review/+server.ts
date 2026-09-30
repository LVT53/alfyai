import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	type ArtifactReviewResult,
	acknowledgeArtifactReview,
	getArtifactReviewState,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/review — ruling 61's first point: the pending set,
// recomputed fresh on every read (never written here — the marker only moves
// on an Alfy edit, in `applyDocumentPatch` or `applyArtifactOps`, or on
// acknowledge, below). Same 404 rule as every artifact route (ruling 39/49): a
// missing id, another user's artifact, an incognito one read from outside its
// own conversation, and a kind with no review (App, File) all answer the
// identical body.
//
// Two kinds have a review. A Document answers `{ ok, pending }`, the blocks
// still waiting (ruling 61). A board answers `{ ok, kind: "canvas", review }`,
// its one pending change (ruling 63): the blocks waiting, whether Undo is
// possible and what it goes back to. The kind-specific work is the service's
// (`review.ts`); this only turns its answer into a response.
function respond(result: ArtifactReviewResult): Response {
	if (!result.ok) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}
	return result.kind === "canvas"
		? json({ ok: true, kind: "canvas", review: result.review })
		: json({ ok: true, pending: result.pending });
}

export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");

	return respond(
		await getArtifactReviewState({
			userId: user.id,
			artifactId: event.params.id,
			conversationId,
		}),
	);
};

// POST /api/artifacts/[id]/review acknowledges: Keep, Undo, Keep all and Undo
// all all call it. A Document names the blocks it just resolved
// (`{ blockIds }`); a board is reviewed as one change, so it names the newest
// version of Alfy's it was shown (`{ throughVersion }`) and the marker moves to
// it. Answers the recomputed state so the caller can resync without a second
// round trip.
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");

	const payload = (await event.request.json().catch(() => null)) as {
		blockIds?: unknown;
		throughVersion?: unknown;
	} | null;
	const blockIds = Array.isArray(payload?.blockIds)
		? payload.blockIds.filter((id): id is string => typeof id === "string")
		: [];
	const throughVersion =
		typeof payload?.throughVersion === "number" &&
		Number.isFinite(payload.throughVersion)
			? payload.throughVersion
			: undefined;

	return respond(
		await acknowledgeArtifactReview({
			userId: user.id,
			artifactId: event.params.id,
			conversationId,
			blockIds,
			throughVersion,
		}),
	);
};
