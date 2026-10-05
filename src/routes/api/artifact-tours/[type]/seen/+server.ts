import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	markArtifactTourSeen,
	parseArtifactTourSeenBody,
} from "$lib/server/services/artifact-tours";
import { isShippedArtifactTourType } from "$lib/shared/artifacts/tours";
import type { RequestHandler } from "./$types";

// POST /api/artifact-tours/[type]/seen — "this user finished (or dismissed)
// this kind's tour". Body `{ contentKey, status: "completed" | "dismissed",
// lastSlide }`; `contentKey` is the key of the tour the user was SHOWN, and is
// trusted for one thing only: being compared with the tour that resolves now.
//
// An adapter: auth, the kind check, the body's shape, the family's answers
// (`{ ok: true, … }` / `{ ok: false, reason, … }`, ruling 49). The comparison
// and the insert-if-absent live in `markArtifactTourSeen`.
//
//  - 401: no session (the HTTP layer's own 401 first, then `requireApiUser`'s,
//    exactly as the GET says: rulings 19 and 39).
//  - 404 `{ ok: false, reason: "unknown_type" }`: not a shipped tour kind.
//  - 400 `{ ok: false, reason: "invalid_state", fieldErrors }`: a `status`
//    outside the two values, a `lastSlide` that is not a whole number inside
//    the tour, or a missing `contentKey`.
//  - 409 `{ ok: false, reason: "content_changed", contentKey }`: the user was
//    shown something other than what is current (an admin published while they
//    were reading), or the tour was retired (`contentKey: null`). Nothing is
//    written; the panel re-fetches and shows the new copy from its first slide.
//  - 200 `{ ok: true, alreadyRecorded }`: written, or already there (a retry, a
//    second tab). Idempotent: the first answer stands.
//
// The user is the session's. Whatever else a body carries — a conversation id,
// an artifact id, another user's id — is dropped by the parser before it can
// reach a row (ruling 33: the row records that a KIND was explained, never
// what the user was working on, so it can never become a trace of a chat).
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactType = event.params.type;
	if (!isShippedArtifactTourType(artifactType)) {
		return json({ ok: false, reason: "unknown_type" }, { status: 404 });
	}

	const parsed = parseArtifactTourSeenBody(
		await event.request.json().catch(() => null),
	);
	if (!parsed.ok) {
		return json(
			{
				ok: false,
				reason: "invalid_state",
				fieldErrors: parsed.fieldErrors,
			},
			{ status: 400 },
		);
	}

	const result = await markArtifactTourSeen({
		userId: user.id,
		artifactType,
		...parsed.value,
	});
	if (result.ok) {
		return json({ ok: true, alreadyRecorded: result.alreadyRecorded });
	}
	if (result.reason === "content_changed") {
		return json(
			{
				ok: false,
				reason: "content_changed",
				contentKey: result.contentKey,
			},
			{ status: 409 },
		);
	}
	return json({ ok: false, reason: "unknown_type" }, { status: 404 });
};
