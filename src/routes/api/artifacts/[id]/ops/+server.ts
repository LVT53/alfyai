import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { applyArtifactOps } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

/**
 * A diff is at most 40 ops, each a sentence or a small block: nothing real is
 * near this. A request that says it is larger is refused without being read.
 */
const MAX_REQUEST_BYTES = 512 * 1024;

// POST /api/artifacts/[id]/ops — an id-addressed change to an artifact, as ONE
// new Alfy version (ruling 14). The route is an adapter and only that: auth
// (401 at the HTTP layer, ruling 39), the size cap, and the family's answer
// shape (`{ ok: true, … }` / `{ ok: false, reason, … }`, ruling 49). Ownership,
// the base-version check, dispatch on the artifact's kind and the write all
// live in `applyArtifactOps`, which the model's edit tool calls in-process — so
// there is one path for a diff, and Slides adds a branch there, not a route.
//
// A foreign id and a missing id answer the same 404 body (a 403 would confirm
// the id exists); an incognito conversation's artifact is reachable only with
// `?conversationId=` naming that conversation (ruling 51).
export const POST: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const conversationId = event.url.searchParams.get("conversationId");

	const declaredBytes = Number(event.request.headers.get("content-length"));
	if (Number.isFinite(declaredBytes) && declaredBytes > MAX_REQUEST_BYTES) {
		return json({ ok: false, reason: "too_large" }, { status: 413 });
	}

	const payload = await event.request.json().catch(() => null);
	const result = await applyArtifactOps({
		userId: user.id,
		artifactId: event.params.id,
		conversationId,
		payload,
	});

	if (!result.ok) {
		return json(
			{
				ok: false,
				reason: result.reason,
				...(result.version !== undefined ? { version: result.version } : {}),
				...(result.detail !== undefined ? { detail: result.detail } : {}),
			},
			{ status: result.status },
		);
	}
	return json({
		ok: true,
		versionId: result.versionId,
		version: result.version,
		applied: result.applied,
		refused: result.refused,
		changed: result.changed,
	});
};
