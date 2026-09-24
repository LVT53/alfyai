import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { listProjectLinksForArtifacts } from "$lib/server/services/knowledge";
import type { RequestHandler } from "./$types";

/**
 * Which of the caller's projects know the given library documents.
 *
 * The library's Documents table asks this to draw one small token per row, so
 * the question is asked once for a whole page of documents rather than once
 * per row. It is a reverse lookup — the project side of the same links
 * `GET /api/projects/[id]/knowledge` reads forwards — and it answers with
 * project NAMES only: the token says "In 1 project", the names are the title
 * attribute, and neither is a reason to hand the browser a project's row.
 *
 * Scoping is the service's (`listProjectLinksForArtifacts` joins `projects` on
 * the caller's own user id), so an artifact id that is not the caller's simply
 * has no links.
 */

/**
 * The library page is capped at 100 documents per page, so 200 distinct ids is
 * twice what any single page can ask about and still a bound: the id list comes
 * from the query string, and an unbounded `IN (...)` is a way to make the
 * database read the whole table on somebody else's behalf.
 */
const MAX_ARTIFACT_IDS = 200;

export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const user = event.locals.user;
	if (!user) {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const raw = event.url.searchParams.get("artifactIds");
	if (raw === null) {
		return json({ error: "artifactIds is required" }, { status: 400 });
	}

	const artifactIds = [
		...new Set(
			raw
				.split(",")
				.map((id) => id.trim())
				.filter((id) => id.length > 0),
		),
	];
	if (artifactIds.length > MAX_ARTIFACT_IDS) {
		return json(
			{ error: `Ask about at most ${MAX_ARTIFACT_IDS} artifacts at a time` },
			{ status: 400 },
		);
	}

	const links = await listProjectLinksForArtifacts({
		userId: user.id,
		artifactIds,
	});

	const byArtifact: Record<string, string[]> = {};
	for (const link of links) {
		const names = byArtifact[link.artifactId] ?? [];
		names.push(link.projectName);
		byArtifact[link.artifactId] = names;
	}

	return json({ links: byArtifact });
};
