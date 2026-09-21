// "Re-extract at a higher quality tier" — the one ledger transition Retry
// cannot express.
//
// `retryExtractionJob` is the user's answer to a job that FAILED: it is legal
// from `failed` and `canceled` only, because re-running a document that is
// already readable is not a retry and must not look like one on the attempt
// table. A re-extraction is legal from `succeeded` as well, and that single
// difference is the whole reason this lives beside the ledger rather than
// inside it — Phase 2's slice owns `job-ledger.ts` and this phase must not
// reopen it.
//
// Everything else is deliberately identical to Retry: the same CAS-guarded
// transaction, the same attempt ceiling, the same refusal while a job is
// active, and `attempt_count` is never reset, so attempt numbers stay unique
// per job and the history stays readable.

import { and, eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { documentExtractionJobs } from "$lib/server/db/schema";
import type { DocumentExtractionStatus } from "$lib/shared/extraction-status";
import { isTerminalExtractionStatus } from "$lib/shared/extraction-status";
import { getExtractionConfig } from "./config";
import { extractionAttemptCeiling } from "./retry-policy";
import type { DocumentExtractionJobRow } from "./types";

export type RequeueExtractionRefusal =
	/** No such job, or not this user's. Answered as a 404, like Retry. */
	| "not_found"
	/** A job is queued or running for this artifact right now. */
	| "active"
	/** The total-attempt ceiling is reached; Retry refuses here too. */
	| "attempt_ceiling";

export type RequeueExtractionResult =
	| { ok: true; job: DocumentExtractionJobRow }
	| { ok: false; reason: RequeueExtractionRefusal };

export interface RequeueExtractionJobInput {
	userId: string;
	jobId: string;
	/**
	 * Replaces the stored hints for the next attempt. Validated by the caller;
	 * the ledger stores and forwards it without ever inspecting it, exactly as
	 * it does with `handle.data`.
	 */
	hints?: Readonly<Record<string, unknown>> | null;
	maxAttempts?: number;
	now?: Date;
}

/**
 * Moves a TERMINAL job — succeeded, failed or canceled — back to `queued`
 * with new hints.
 *
 * On the ceiling: a re-extraction is a fresh user intent, but it is still one
 * more seat on a backend that serves one job at a time, so it is bounded by
 * the same `extractionAttemptCeiling` Retry is. A user who has exhausted a
 * document's attempts has to delete and re-upload it, which is the same answer
 * Retry gives them and the same bound on how long one broken file can occupy
 * the queue.
 */
export async function requeueExtractionJobForReextraction(
	input: RequeueExtractionJobInput,
): Promise<RequeueExtractionResult> {
	const now = input.now ?? new Date();
	const ceiling = extractionAttemptCeiling(
		input.maxAttempts ?? getExtractionConfig().maxAttempts,
	);

	return db.transaction((tx) => {
		const [job] = tx
			.select()
			.from(documentExtractionJobs)
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.userId, input.userId),
				),
			)
			.limit(1)
			.all();

		if (!job) return { ok: false as const, reason: "not_found" as const };
		if (!isTerminalExtractionStatus(job.status as DocumentExtractionStatus)) {
			// Not an error the user caused: the document is being read right now,
			// and asking for a second parse of the same bytes would either race
			// the first or be refused by the job row's UNIQUE(source_artifact_id).
			return { ok: false as const, reason: "active" as const };
		}
		if (job.attemptCount >= ceiling) {
			return { ok: false as const, reason: "attempt_ceiling" as const };
		}

		const result = tx
			.update(documentExtractionJobs)
			.set({
				status: "queued",
				currentAttemptId: null,
				errorCode: null,
				errorMessage: null,
				retryable: false,
				nextAttemptAt: null,
				cancelRequestedAt: null,
				completedAt: null,
				// The previous parse's remote handle belongs to a job that is over.
				// Resuming into it would hand the extractor a finished remote job
				// and, worse, one parsed at the tier the user is trying to leave.
				remoteHandleJson: null,
				...(input.hints === undefined
					? {}
					: {
							hintsJson:
								input.hints && Object.keys(input.hints).length > 0
									? JSON.stringify(input.hints)
									: null,
						}),
				updatedAt: now,
			})
			.where(
				and(
					eq(documentExtractionJobs.id, input.jobId),
					eq(documentExtractionJobs.status, job.status),
				),
			)
			.run();

		// Lost the CAS: something else moved the row between the read and the
		// write, so whatever it did now owns the job.
		if (result.changes === 0) {
			return { ok: false as const, reason: "active" as const };
		}

		const [updated] = tx
			.select()
			.from(documentExtractionJobs)
			.where(eq(documentExtractionJobs.id, input.jobId))
			.limit(1)
			.all();

		return updated
			? { ok: true as const, job: updated }
			: { ok: false as const, reason: "not_found" as const };
	});
}
