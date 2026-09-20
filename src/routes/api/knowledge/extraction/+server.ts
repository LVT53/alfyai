// The batch status endpoint every client surface polls.
//
// Keyed on artifact ids rather than job ids on purpose: the composer, the
// landing page and the Knowledge list all know which DOCUMENTS they are
// showing, and a pre-ledger document has no job id at all (the read model
// synthesises one — see `extraction/read-model.ts`). Asking by artifact id is
// therefore the only question all three surfaces can actually ask.
//
// Unknown and unowned ids are omitted rather than answered with a placeholder,
// so polling for somebody else's artifact id cannot tell a caller whether it
// exists. That filtering lives in the read model (`WHERE user_id = ?` plus the
// same predicate on the legacy fallback query); this route's only job is to
// hand it the authenticated user's own id and never a client-supplied one.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import { getExtractionJobsForArtifacts } from "$lib/server/services/extraction";
import { EXTRACTION_STATUS_BATCH_LIMIT } from "$lib/shared/extraction-status";
import type { RequestHandler } from "./$types";

/**
 * How many ids one poll may ask about. The cap is what keeps a Knowledge page
 * with hundreds of documents from turning a 1 s poll into a hundred-row scan;
 * clients chunk to it.
 *
 * The number itself lives in `$lib/shared/extraction-status` because a
 * SvelteKit route module may export only its handlers and a few named config
 * exports, so this side cannot own a constant the poller imports — and two
 * hand-kept copies is exactly the arrangement where lowering one turns every
 * poll into a 400.
 */
const MAX_EXTRACTION_ARTIFACT_IDS = EXTRACTION_STATUS_BATCH_LIMIT;

function parseArtifactIds(raw: string | null): string[] {
	if (!raw) return [];
	const seen = new Set<string>();
	for (const part of raw.split(",")) {
		const id = part.trim();
		if (id) seen.add(id);
	}
	return Array.from(seen);
}

export const GET: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	const artifactIds = parseArtifactIds(
		event.url.searchParams.get("artifactIds"),
	);

	if (artifactIds.length > MAX_EXTRACTION_ARTIFACT_IDS) {
		return json(
			{
				error: `Ask about at most ${MAX_EXTRACTION_ARTIFACT_IDS} documents at a time.`,
				code: "too_many_artifact_ids",
				details: { limit: MAX_EXTRACTION_ARTIFACT_IDS },
			},
			{ status: 400 },
		);
	}

	if (artifactIds.length === 0) {
		return json({ jobs: [] });
	}

	const jobs = await getExtractionJobsForArtifacts({
		userId: user.id,
		artifactIds,
	});

	return json({ jobs });
};
