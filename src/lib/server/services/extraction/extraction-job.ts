// Document extraction on the job engine (docs/plans/jobs-merge, slice S3).
//
// This file is the KIND: its definition, which is everything the engine needs to
// know that is particular to extraction, and the functions the rest of the app
// calls to start, retry and cancel a job. It imports the engine and no extractor:
// the handler (`extraction-runner.ts`) is loaded on the first claim, so a route
// that only reads, retries or cancels never pulls in the extractor registry, the
// MinerU client or `node:fs`.
//
// What the engine owns and this file does not: claiming, the lease and its
// heartbeat, the fenced writes, taking an attempt back, cancel's immediate abort,
// scheduling and waiting. What stays extraction's: the intake route and the hints
// a job carries, the retry arithmetic (`retry-policy.ts`), the ceilings Retry and
// Re-extract are held to, the direct-text inline run, and the vocabulary the
// browser reads (`shared/extraction-status.ts`, which keeps `canceled` and the
// phase words: only the stored words changed).

import {
	documentExtractionJobAttempts,
	documentExtractionJobs,
} from "$lib/server/db/schema";
import type {
	FailureDecision,
	FailureHistory,
	JobFailure,
} from "$lib/server/services/jobs";
import { defineJobKind } from "$lib/server/services/jobs";
import { isExtractionErrorCode } from "$lib/shared/extraction-status";
import { getExtractionConfig } from "./config";
import {
	decideExtractionRetry,
	extractionRetryBudgetLeft,
	isEmptyExtractionOutageState,
	parseExtractionOutageState,
} from "./retry-policy";

// ---------------------------------------------------------------------------
// The definition
// ---------------------------------------------------------------------------

/**
 * The phases an attempt moves through, in order. The engine refuses a report that
 * would move one backwards, which is what `state-machine.ts` used to say.
 * `uploading` is the first: a claim starts there, as it always did.
 */
export const EXTRACTION_PHASES = [
	"uploading",
	"parsing",
	"downloading",
	"indexing",
] as const;

/** What an attempt the engine took back is told, as it always was. */
export const EXTRACTION_STALE_WORKER_MESSAGE =
	"The extraction worker stopped responding before finishing this document.";

/**
 * What a failure does to the job: today's `decideExtractionRetry`, unchanged, with
 * the live config values and the outage memory the engine keeps in
 * `retry_state_json`. Pure, and called inside the transaction that settles the
 * failure, for every failure whatever its source: the extractor's, a throw, and a
 * take-back.
 *
 * A code that is not one of the ledger's (the engine's own `no_verdict`, or a
 * handler that threw something it never mapped) is an ordinary retryable document
 * failure, `job_failed`: the retry arithmetic has a policy for every code of the
 * vocabulary and none for a word it has not heard, and a job must never stay
 * `running` because its failure had a name the table lacks.
 */
export function decideExtractionFailure(
	failure: JobFailure,
	history: FailureHistory,
): FailureDecision {
	const config = getExtractionConfig();
	const decision = decideExtractionRetry({
		code: isExtractionErrorCode(failure.code) ? failure.code : "job_failed",
		retryable: failure.retryable,
		retryAfterMs: failure.retryAfterMs,
		attemptCount: history.attempts,
		maxAttempts: config.maxAttempts,
		retryBaseMs: config.retryBaseMs,
		retryMaxMs: config.retryMaxMs,
		outageWindowMs: config.outageWindowMs,
		outage: parseExtractionOutageState(history.state),
		nowMs: history.nowMs,
	});

	// An outage with nothing to remember leaves the column empty, as the previous
	// release left the hints key out.
	const state = isEmptyExtractionOutageState(decision.outage)
		? null
		: decision.outage;
	return decision.requeue
		? {
				requeue: true,
				delayMs: decision.delayMs,
				code: decision.jobErrorCode,
				retryable: decision.jobRetryable,
				state,
			}
		: {
				requeue: false,
				retryable: decision.jobRetryable,
				code: decision.jobErrorCode,
				state,
			};
}

export const extractionJob = defineJobKind({
	name: "extraction",
	logPrefix: "[EXTRACTION]",
	tables: {
		jobs: documentExtractionJobs,
		attempts: documentExtractionJobAttempts,
	},
	// Every value is read through the config at the moment it is needed, which is
	// what lets all of them be `effect: "live"` on the admin Advanced page: an
	// admin who lowers the concurrency cap sees it apply on the very next claim,
	// and the switch pauses the inline direct-text path too, or "off" would mean
	// "off for big files only".
	enabled: () => getExtractionConfig().workerEnabled,
	limits: () => {
		const config = getExtractionConfig();
		return {
			global: config.maxConcurrency,
			perUser: config.perUserConcurrency,
		};
	},
	lease: () => {
		const config = getExtractionConfig();
		return {
			heartbeatMs: config.heartbeatMs,
			staleAfterMs: config.staleAttemptMs,
		};
	},
	phases: EXTRACTION_PHASES,
	lostAttempt: () => ({
		code: "stale_worker",
		message: EXTRACTION_STALE_WORKER_MESSAGE,
	}),
	onFailure: decideExtractionFailure,
	// Retry is legal from failed and cancelled while the job has document
	// attempts left under its ceiling (outage waits discounted); it is not the
	// button that is drawn, though: the DTO also asks that a failed job says it is
	// retryable.
	userRetry: {
		from: ["failed", "cancelled"],
		allow: (row) =>
			extractionRetryBudgetLeft(row, getExtractionConfig().maxAttempts),
	},
	// A direct-text job is local CPU, not a backend seat: it may run inside the
	// request that made it, past the caps.
	inline: { eligible: (row) => row.intakeRoute === "direct-text" },
	handler: () =>
		import("./extraction-runner").then((module) => module.runExtraction),
});
