import { json } from "@sveltejs/kit";
import { requireApiUser } from "$lib/server/api/auth";
import { listHistory } from "$lib/server/services/artifacts";
import type { RequestHandler } from "./$types";

/** A query value that is a whole number of at least one, else `null`; a missing value is `undefined`. */
function positiveInteger(value: string | null): number | null | undefined {
	if (value === null) return undefined;
	if (!/^\d{1,9}$/.test(value)) return null;
	const parsed = Number(value);
	return parsed >= 1 ? parsed : null;
}

// GET /api/artifacts/[id]/history?before=<versionNumber>&limit=<n> — an
// artifact's history as moments a reader can follow (ruling 76), newest first,
// a page at a time: `before` is the last page's `nextBefore`. The moments are
// derived from the version rows on every read (`listHistory`); nothing here is
// stored for them. The same 404 as every artifact route (rulings 39/49): a
// missing id, another user's, a produced file (no versions) and an incognito
// item read from outside its conversation all answer one body.
export const GET: RequestHandler = async (event) => {
	const user = requireApiUser(event);
	const before = positiveInteger(event.url.searchParams.get("before"));
	const limit = positiveInteger(event.url.searchParams.get("limit"));
	// A malformed query is the caller's mistake whatever the id is, so it is
	// answered before anything is looked up.
	if (before === null || limit === null) {
		return json({ ok: false, reason: "invalid_request" }, { status: 400 });
	}

	const result = await listHistory({
		userId: user.id,
		artifactId: event.params.id,
		conversationId: event.url.searchParams.get("conversationId"),
		before,
		limit,
	});
	if (!result.ok) return json(result, { status: 404 });
	return json(result);
};
