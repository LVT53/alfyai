// Retry arithmetic, kept pure so the interesting cases are unit-testable
// without a clock, a database or a backend.

import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import { RETRYABLE_EXTRACTION_ERROR_CODES } from "$lib/shared/extraction-status";

/**
 * How many attempts a user may add to a job by pressing Retry, in total, ever.
 *
 * Each Retry grants exactly one more attempt by design — that is what makes
 * the button useful the moment the automatic budget runs out. With no ceiling
 * on top of it, one user holding one broken document can generate unbounded
 * backend work simply by pressing Retry, which is a denial-of-service with a
 * mouse. Five is generous for a transient outage and finite for a loop.
 */
export const EXTRACTION_USER_RETRY_GRANTS = 5;

/**
 * The hard ceiling on TOTAL attempts for one job: the automatic budget plus
 * every retry a user may ever be granted. Enforced in the ledger, not just at
 * the endpoint, so no future caller can route around it.
 */
export function extractionAttemptCeiling(maxAttempts: number): number {
	return Math.max(1, Math.floor(maxAttempts)) + EXTRACTION_USER_RETRY_GRANTS;
}

/** Jitter band. A fixed backoff would sync every requeued job onto one tick. */
export const EXTRACTION_BACKOFF_JITTER_MIN = 0.8;
export const EXTRACTION_BACKOFF_JITTER_MAX = 1.2;
const EXTRACTION_BACKOFF_FACTOR = 3;

/**
 * `min(maxMs, baseMs * 3^(attempt-1))`, multiplied by a jitter in [0.8, 1.2].
 *
 * `random` is injected rather than `Math.random` being called inline, because a
 * backoff test that cannot pin the jitter can only assert a range, and a range
 * assertion passes just as happily when the exponent is wrong.
 */
export function computeBackoffMs(
	attempt: number,
	baseMs: number,
	maxMs: number,
	random: () => number = Math.random,
): number {
	const safeAttempt = Math.max(1, Math.floor(attempt));
	const safeBase = Math.max(0, baseMs);
	const safeMax = Math.max(safeBase, maxMs);
	const raw = safeBase * EXTRACTION_BACKOFF_FACTOR ** (safeAttempt - 1);
	const capped = Math.min(safeMax, Number.isFinite(raw) ? raw : safeMax);
	const jitter =
		EXTRACTION_BACKOFF_JITTER_MIN +
		clamp01(random()) *
			(EXTRACTION_BACKOFF_JITTER_MAX - EXTRACTION_BACKOFF_JITTER_MIN);
	return Math.round(capped * jitter);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export interface ExtractionRetryDecisionInput {
	code: ExtractionErrorCode;
	/** The extractor's own verdict; falls back to the code's default. */
	retryable?: boolean;
	/** Honoured verbatim for `rate_limited`, in place of the computed backoff. */
	retryAfterMs?: number;
	/** Attempts already consumed, i.e. the job's `attempt_count` after the claim. */
	attemptCount: number;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	random?: () => number;
}

export interface ExtractionRetryDecision {
	/** true ⇒ back to `queued` with a backoff gate; false ⇒ terminal `failed`. */
	requeue: boolean;
	delayMs: number;
	/** The code to stamp on the JOB row (not the attempt). */
	jobErrorCode: ExtractionErrorCode;
	/** Whether the user's Retry button should be offered on a terminal failure. */
	jobRetryable: boolean;
}

/**
 * The one place that decides "again or done".
 *
 * A code that is retryable but has burned its attempts becomes `max_attempts`
 * with `retryable: true` — the failure is terminal for the WORKER but not for
 * the USER, and the DTO must be able to say so. Conflating the two is how a
 * transient outage ends up looking like a permanently broken file.
 */
export function decideExtractionRetry(
	input: ExtractionRetryDecisionInput,
): ExtractionRetryDecision {
	const retryable =
		input.retryable ?? RETRYABLE_EXTRACTION_ERROR_CODES.has(input.code);
	const attemptsLeft = input.attemptCount < input.maxAttempts;

	// The ceiling is checked before anything else: past it the job is done,
	// whatever the code says and however many times the user presses Retry.
	if (input.attemptCount >= extractionAttemptCeiling(input.maxAttempts)) {
		return {
			requeue: false,
			delayMs: 0,
			jobErrorCode: "max_attempts",
			jobRetryable: false,
		};
	}

	if (retryable && attemptsLeft) {
		const delayMs =
			input.code === "rate_limited" &&
			typeof input.retryAfterMs === "number" &&
			Number.isFinite(input.retryAfterMs) &&
			input.retryAfterMs >= 0
				? Math.round(input.retryAfterMs)
				: computeBackoffMs(
						input.attemptCount,
						input.retryBaseMs,
						input.retryMaxMs,
						input.random,
					);
		return {
			requeue: true,
			delayMs,
			jobErrorCode: input.code,
			jobRetryable: true,
		};
	}

	const cappedOut = retryable && !attemptsLeft;
	return {
		requeue: false,
		delayMs: 0,
		jobErrorCode: cappedOut ? "max_attempts" : input.code,
		jobRetryable: cappedOut,
	};
}
