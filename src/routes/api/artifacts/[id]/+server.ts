import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import {
	getArtifact,
	listComments,
	listVersions,
} from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id] — one artifact's detail, its version history and
// its comment threads, all through the one scoped read (ruling 39: 401 comes
// from requireApiUser/hooks.server.ts, never a route-local check).
//
// The 404 body is the family's own shape ({ ok: false, reason: "not_found" }),
// never a 403: a 403 confirms existence, and this route must answer the same
// way for a missing id, another user's artifact, or an incognito artifact
// read from outside its conversation.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;

	const artifact = await getArtifact({ userId: user.id, artifactId });
	if (!artifact) {
		return json({ ok: false, reason: "not_found" }, { status: 404 });
	}

	const [versions, comments] = await Promise.all([
		listVersions({ userId: user.id, artifactId }),
		listComments({ userId: user.id, artifactId }),
	]);

	return json({ artifact, versions, comments });
};
