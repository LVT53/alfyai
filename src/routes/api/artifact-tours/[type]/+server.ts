import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { getArtifactTour } from "$lib/server/services/artifact-tours";
import { isShippedArtifactTourType } from "$lib/shared/artifacts/tours";
import type { RequestHandler } from "./$types";

// GET /api/artifact-tours/[type] — the first-open tour for one kind of
// artifact, as it is right now (a published campaign's snapshot, or the code
// default), with whether THIS user has already seen that exact content and the
// slide they left it on.
//
// An adapter and only that: auth, the kind check, the answer shape. The tour
// and the seen state come from `getArtifactTour`; which kinds exist is the
// shipped list (ruling 69), so Slides — shelved — and File — never — are a 404
// like any other unknown segment.
//
//  - 401: no session. Over HTTP, `hooks.server.ts` answers an unauthenticated
//    /api call first, with its own 401 JSON (`{ code: "session_expired" }`,
//    ruling 19: the HTTP layer); `requireApiUser` is the route's own guard
//    and throws the same status (`{ message: "Unauthorized" }`, ruling 39) so
//    the route is safe whatever sits in front of it. The panel `fetch`es this,
//    so a redirect to the login page would be parsed as JSON; the campaign
//    routes chose `requireAuth` for a modal that can take a redirect, and this
//    is deliberately not that.
//  - 404 `{ ok: false, reason: "unknown_type" }`: the path names no shipped
//    tour kind. A resource address, so 404 and not 400.
//  - 200 `{ ok: true, tour, seen, lastSlide }` (ruling 49). `tour` is `null`
//    when the kind's tour was retired by archiving its campaign: the panel
//    shows the kind's own empty-state line, and a missing tour is NOT an
//    error to paint over a working panel.
//
// The user is the session's, never a query parameter. The route takes no
// conversation and no artifact id and writes nothing: opening a tour is not a
// trace of what the user was working on (ruling 33).
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactType = event.params.type;
	if (!isShippedArtifactTourType(artifactType)) {
		return json({ ok: false, reason: "unknown_type" }, { status: 404 });
	}

	const result = await getArtifactTour({ userId: user.id, artifactType });
	return json({
		ok: true,
		tour: result?.tour ?? null,
		seen: result?.seen ?? false,
		lastSlide: result?.lastSlide ?? 0,
	});
};
