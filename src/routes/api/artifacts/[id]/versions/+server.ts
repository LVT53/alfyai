import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { optionalPositiveIntegerParam } from "$lib/server/api/query-params";
import { getArtifact, listVersions } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

// GET /api/artifacts/[id]/versions — the History sheet's own refetch path
// (T6), separate from GET /api/artifacts/[id] so a restore can refresh just
// the list. Same 404 rule as every artifact route (ruling 39/49): a missing
// id, another user's artifact, and an incognito one read from outside its
// conversation all answer the identical body.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const artifactId = event.params.id;
	const conversationId = event.url.searchParams.get("conversationId");
	// `before` is the lowest version number the caller has seen: ruling 47 always
	// said history is paged, and the list stopped at fifty with no way on.
	const before = optionalPositiveIntegerParam(
		event.url.searchParams.get("before"),
	);
	const limit = optionalPositiveIntegerParam(
		event.url.searchParams.get("limit"),
	);
	if (before === null || limit === null) {
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

	const versions = await listVersions({
		userId: user.id,
		artifactId,
		conversationId,
		...(before !== undefined ? { before } : {}),
		...(limit !== undefined ? { limit } : {}),
	});
	return json({ ok: true, versions });
};
