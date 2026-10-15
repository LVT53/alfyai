// "Re-extract at a higher quality tier" — the one reopening Retry cannot express.
//
// `retryExtractionJob` is the user's answer to a job that FAILED: it is legal from
// `failed` and `cancelled` only, because re-running a document that is already
// readable is not a retry and must not look like one on the attempt table. A
// re-extraction is legal from `succeeded` as well. Both are the engine's `reopen`
// with a rule of their own; this file holds the rule and writes no lifecycle
// column.
//
// Everything else is deliberately identical to Retry: the same transaction, the
// same attempt ceiling, the same refusal while a job is active, and `attempt_count`
// is never reset, so attempt numbers stay unique per job and the history stays
// readable.

import { and, eq, or } from "drizzle-orm";
import { db } from "$lib/server/db";
import { documentExtractionJobs } from "$lib/server/db/schema";
import { reopen } from "$lib/server/services/jobs";
import { getExtractionConfig } from "./config";
import { extractionJob } from "./extraction-job";
import {
	carryExtractionOutageWaits,
	extractionRetryBudgetLeft,
} from "./retry-policy";
import type { DocumentExtractionJobRow } from "./types";

export type RequeueExtractionRefusal =
	/** No such job, or not this user's. Answered as a 404, like Retry. */
	| "not_found"
	/** A job is queued or running for this artifact right now. */
	| "active"
	/** The total-attempt ceiling is reached; Retry refuses here too. */
	| "attempt_ceiling"
	/** This user already has the most re-extractions in flight they may. */
	| "user_limit";

export type RequeueExtractionResult =
	| { ok: true; job: DocumentExtractionJobRow }
	| { ok: false; reason: RequeueExtractionRefusal };

/**
 * The hint key that says "this queued job exists because somebody pressed
 * Re-extract".
 *
 * The ledger has no origin column that distinguishes a re-extraction from the
 * upload that first created the row — `origin` is fixed at enqueue and a
 * re-extraction reuses the row — and adding one would mean a migration for a
 * rate limit. `hints_json` is already rewritten on every requeue, already opaque to
 * the engine and the handler, and already carries the tier, so the marker rides
 * with it. Extractors ignore keys they do not know.
 */
export const REEXTRACT_HINT_KEY = "reextract";

/**
 * How many re-extractions one user may have queued or running at once.
 *
 * Re-extraction is the only action in the app that lets a user re-spend the whole
 * cost of a document they already paid for, at the most expensive tier the server
 * offers, as often as they can click. The per-document guards (`active`, the
 * attempt ceiling) bound one file; nothing bounded a library. Fifty rows and fifty
 * clicks is fifty `advanced` parses on a backend that serves one job at a time,
 * which is a self-inflicted outage for every other user of the box.
 *
 * Five is small enough to be a real bound and large enough that nobody re-reading a
 * handful of documents ever meets it. It counts jobs, not requests: finishing one
 * frees a seat.
 */
export const MAX_ACTIVE_REEXTRACTIONS_PER_USER = 5;

/**
 * Roughly how long a caller should wait before trying again: one job's worth
 * of MinerU time. Advisory — the seat frees when a job ends, not on a clock.
 */
export const REEXTRACT_RETRY_AFTER_SECONDS = 60;

function hintsMarkReextraction(hintsJson: string | null): boolean {
	if (!hintsJson) return false;
	try {
		const parsed: unknown = JSON.parse(hintsJson);
		return (
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as Record<string, unknown>)[REEXTRACT_HINT_KEY] === true
		);
	} catch {
		return false;
	}
}

export interface RequeueExtractionJobInput {
	userId: string;
	jobId: string;
	/**
	 * Replaces the stored hints for the next attempt. Validated by the caller;
	 * the engine stores and forwards it without ever inspecting it, exactly as it
	 * does with the checkpoint.
	 */
	hints?: Readonly<Record<string, unknown>> | null;
	maxAttempts?: number;
	/** Overridable for tests. Defaults to MAX_ACTIVE_REEXTRACTIONS_PER_USER. */
	maxActiveReextractions?: number;
}

/**
 * Moves a SETTLED job — succeeded, failed or cancelled — back to `queued` with new
 * hints.
 *
 * On the ceiling: a re-extraction is a fresh user intent, but it is still one more
 * seat on a backend that serves one job at a time, so it is bounded by the same
 * `extractionAttemptCeiling` Retry is, measured in DOCUMENT attempts. The raw
 * `attempt_count` also carries every attempt spent waiting on an unreachable
 * backend; one 30-minute outage costs about a dozen of them, which is already past
 * the ceiling. Charging those to the document disabled Re-extract permanently for a
 * file that never failed once, while the Retry button beside it — which discounts
 * them — still worked. A user who has exhausted a document's attempts has to delete
 * and re-upload it, which is the same answer Retry gives them.
 *
 * On the per-user cap: the ceiling bounds ONE document. The cap bounds the library,
 * and it is counted and enforced inside the same transaction as the reopening so
 * that N simultaneous requests cannot each read "four in flight" and all write a
 * fifth.
 *
 * A re-extraction is a fresh look: the CURRENT outage window is cleared, `waits` is
 * cumulative and carries, or the discount above would be destroyed by the very write
 * that just used it. The previous parse's remote handle belongs to a job that is
 * over, so the checkpoint is cleared too: resuming into it would hand the extractor
 * a finished remote job and, worse, one parsed at the tier the user is trying to
 * leave.
 */
export async function requeueExtractionJobForReextraction(
	input: RequeueExtractionJobInput,
): Promise<RequeueExtractionResult> {
	const maxAttempts = input.maxAttempts ?? getExtractionConfig().maxAttempts;
	const userLimit = Math.max(
		1,
		Math.trunc(
			input.maxActiveReextractions ?? MAX_ACTIVE_REEXTRACTIONS_PER_USER,
		),
	);

	// What the rule saw when it refused, written by `allow` inside the engine's
	// transaction: the engine answers null for every refusal, and this is how a
	// caller learns which one.
	let refusal = null as RequeueExtractionRefusal | null;

	const reopened = await reopen(extractionJob, input.jobId, {
		userId: input.userId,
		from: ["succeeded", "failed", "cancelled"],
		allow: (tx, job) => {
			if (!extractionRetryBudgetLeft(job, maxAttempts)) {
				refusal = "attempt_ceiling";
				return false;
			}
			// Every unfinished job of this user's, the marker read in JS rather than
			// with a LIKE on `hints_json`: the set is bounded by the number of
			// documents a user has in flight, and a JSON substring match would count a
			// document whose filename happened to contain the marker.
			//
			// Unfinished is the STORED word, the engine's: `queued` or `running`. The
			// browser's vocabulary (`isTerminalExtractionStatus`) spells a cancel
			// `canceled` and does not know `cancelled`, so asking it about a stored row
			// counted every re-extraction the user had stopped as one in flight.
			const inFlight = tx
				.select({
					id: documentExtractionJobs.id,
					hintsJson: documentExtractionJobs.hintsJson,
				})
				.from(documentExtractionJobs)
				.where(
					and(
						eq(documentExtractionJobs.userId, input.userId),
						or(
							eq(documentExtractionJobs.status, "queued"),
							eq(documentExtractionJobs.status, "running"),
						),
					),
				)
				.all()
				.filter(
					(row) => row.id !== job.id && hintsMarkReextraction(row.hintsJson),
				);
			if (inFlight.length >= userLimit) {
				refusal = "user_limit";
				return false;
			}
			return true;
		},
		patch: () =>
			input.hints === undefined
				? {}
				: {
						hintsJson:
							input.hints && Object.keys(input.hints).length > 0
								? JSON.stringify(input.hints)
								: null,
					},
		retryState: carryExtractionOutageWaits,
	});

	if (reopened) return { ok: true, job: reopened };
	if (refusal) return { ok: false, reason: refusal };

	// The engine refused before the rule was asked: no such job, or one that is not
	// settled (being read right now, where a second parse of the same bytes would
	// either race the first or be refused by the job row's UNIQUE(source_artifact_id)),
	// or one that something else moved between the read and the write. Whatever it
	// did now owns the job.
	const [current] = await db
		.select({ id: documentExtractionJobs.id })
		.from(documentExtractionJobs)
		.where(
			and(
				eq(documentExtractionJobs.id, input.jobId),
				eq(documentExtractionJobs.userId, input.userId),
			),
		)
		.limit(1);
	return { ok: false, reason: current ? "active" : "not_found" };
}
