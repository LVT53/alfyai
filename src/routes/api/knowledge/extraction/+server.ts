// The batch status endpoint every client surface polls.
//
// The response is a two-part contract:
//
//   { jobs: DocumentExtractionJobDTO[], readiness: AttachmentReadinessSnapshot[] }
//
// `jobs` is the lifecycle truth — what happened to each document, in the order
// the caller asked, with unknown and unowned ids omitted. `readiness` is the
// content verdict for terminal success only: one snapshot per returned
// `succeeded` job, so a job that finished with unusable text arrives as a
// success WITH `promptReady: false` rather than a silent success the client
// cannot see. Queued, active, failed and canceled jobs carry no readiness row,
// and when no returned job succeeded the readiness read does not happen at all.
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
import { readAttachmentReadinessSnapshots } from "$lib/server/services/knowledge/readiness";
import type { AttachmentReadinessSnapshot } from "$lib/shared/attachment-readiness";
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
		return json({ jobs: [], readiness: [] });
	}

	const jobs = await getExtractionJobsForArtifacts({
		userId: user.id,
		artifactIds,
	});

	// Content verdicts are owed only for terminal success, and only when the
	// job names a source artifact to ask about. Anything else is answered with
	// no extra read — a poll for queued work must stay as cheap as it was.
	const succeededArtifactIds = jobs.flatMap((job) =>
		job.status === "succeeded" && job.sourceArtifactId
			? [job.sourceArtifactId]
			: [],
	);

	let readiness: AttachmentReadinessSnapshot[] = [];
	if (succeededArtifactIds.length > 0) {
		try {
			readiness = await readAttachmentReadinessSnapshots(
				user.id,
				succeededArtifactIds,
			);
		} catch (error) {
			// The readiness read is a content verdict, not the job lifecycle. A
			// failure here must not take job polling down with it and strand the
			// chip: answer the jobs, with no verdict.
			console.warn("[EXTRACTION] Readiness lookup failed", { error });
		}
	}

	return json({ jobs, readiness });
};
