// The user's Retry button.
//
// Keyed on the artifact, not the job, so the client never has to know whether
// a row exists: a document that predates the ledger is answered by the read
// model with a synthesised `legacy_unknown` failure, and pressing Retry on it
// materialises a real row first (the ONE place a legacy artifact is written —
// see D7) and then retries that.
//
// Every unretryable case answers 404 with the same code. That is deliberate:
// "not yours", "no such artifact" and "already succeeded" must be
// indistinguishable from outside, or the endpoint becomes an oracle for which
// artifact ids exist in another account.

import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	getExtractionJobById,
	getExtractionJobForArtifact,
	materializeLegacyExtractionJob,
	retryExtractionJob,
	wakeExtractionWorker,
} from "$lib/server/services/extraction";
import type { RequestHandler } from "./$types";

function notFound() {
	return json(
		{
			error: "Extraction job not found or not retryable",
			code: "extraction_job_not_found",
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
	if (!artifactId) return notFound();

	const current = await getExtractionJobForArtifact({
		userId: user.id,
		artifactId,
	});
	if (!current || !current.retryable) return notFound();

	let jobId = current.id;
	if (current.legacy) {
		const materialized = await materializeLegacyExtractionJob({
			userId: user.id,
			sourceArtifactId: artifactId,
			fileName: current.fileName,
		});
		if (!materialized) return notFound();
		jobId = materialized.id;
	}

	const retried = await retryExtractionJob({ userId: user.id, jobId });
	if (!retried) return notFound();

	wakeExtractionWorker();

	const job = await getExtractionJobById({ userId: user.id, jobId });
	if (!job) return notFound();

	return json({ job });
};
