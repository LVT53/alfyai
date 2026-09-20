// The user's Cancel button.
//
// The ledger row goes terminal immediately and the worker finds out on its
// next heartbeat; whether the remote backend can actually be told to stop has
// no bearing on the answer, because a user who pressed Cancel is owed a
// canceled job rather than one that stays "parsing" until a backend replies.
//
// A synthesised legacy row is never cancelable (it has no worker to stop), and
// an already-terminal or already-canceling job is not either — all of which
// the DTO's `cancelable` already answers, so this route asks it rather than
// re-deriving the rule.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	cancelExtractionJob,
	getExtractionJobById,
	getExtractionJobForArtifact,
} from "$lib/server/services/extraction";
import type { RequestHandler } from "./$types";

function notCancelable() {
	return json(
		{
			error: "Extraction job not found or not cancelable",
			code: "extraction_job_not_cancelable",
		},
		{ status: 404 },
	);
}

export const POST: RequestHandler = async (event) => {
	try {
		requireAuth(event);
	} catch {
		return json({ error: "Unauthorized" }, { status: 401 });
	}

	const user = event.locals.user;
	const artifactId = event.params.artifactId?.trim();
	if (!artifactId) return notCancelable();

	const current = await getExtractionJobForArtifact({
		userId: user.id,
		artifactId,
	});
	if (!current || current.legacy || !current.cancelable) {
		return notCancelable();
	}

	const canceled = await cancelExtractionJob({
		userId: user.id,
		jobId: current.id,
	});
	if (!canceled) return notCancelable();

	const job = await getExtractionJobById({
		userId: user.id,
		jobId: current.id,
	});
	if (!job) return notCancelable();

	return json({ job });
};
