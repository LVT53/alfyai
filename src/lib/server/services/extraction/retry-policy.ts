// Retry arithmetic, kept pure so the interesting cases are unit-testable
// without a clock, a database or a backend.

import type { ExtractionErrorCode } from "$lib/shared/extraction-status";
import {
	extractionErrorPolicy,
	RETRYABLE_EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";

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
 *
 * It counts DOCUMENT attempts only — see `extractionDocumentAttempts`. An
 * outage the document had nothing to do with must not eat the budget that
 * exists for the document.
 */
export function extractionAttemptCeiling(maxAttempts: number): number {
	return Math.max(1, Math.floor(maxAttempts)) + EXTRACTION_USER_RETRY_GRANTS;
}

/** Jitter band. A fixed backoff would sync every requeued job onto one tick. */
export const EXTRACTION_BACKOFF_JITTER_MIN = 0.8;
export const EXTRACTION_BACKOFF_JITTER_MAX = 1.2;
const EXTRACTION_BACKOFF_FACTOR = 3;

// ---------------------------------------------------------------------------
// The outage budget
// ---------------------------------------------------------------------------

/**
 * The first wait after the backend stops answering.
 *
 * Deliberately not `retryBaseMs`: that knob exists for a document that failed
 * and is measured in seconds because three of them is the whole budget. This
 * one is the first step of a walk that lasts half an hour, so it can afford to
 * be short — a MinerU restart is often over before the second wait.
 */
export const EXTRACTION_OUTAGE_BACKOFF_BASE_MS = 5_000;

/**
 * The longest one outage wait may be. Five minutes: long enough that a
 * half-hour outage costs a single-figure number of probes, short enough that a
 * backend which came back is noticed while the user is still looking at the
 * page.
 */
export const EXTRACTION_OUTAGE_BACKOFF_MAX_MS = 300_000;

/** Doubling, not tripling: the walk is bounded by time, not by attempts. */
const EXTRACTION_OUTAGE_BACKOFF_FACTOR = 2;

/**
 * What the ledger remembers about a job's relationship with a down backend.
 *
 * `waits` is cumulative and never reset, because it is what the attempt budget
 * is discounted by: an attempt spent waiting on a dead backend is not an
 * attempt spent on the document, and the arithmetic has to keep saying so for
 * as long as the row exists. `since` anchors the outage window at the FIRST
 * outage wait of the job's current run, and only three things end that run: a
 * success, a user-initiated Retry/re-extract, and the window running out. An
 * ordinary failure in between does NOT clear it — see `decideExtractionRetry`.
 */
export interface ExtractionOutageState {
	/** Epoch ms of the first failure in the current outage, or null. */
	since: number | null;
	/** Attempts this job has spent waiting on an unreachable backend, ever. */
	waits: number;
}

export const EMPTY_EXTRACTION_OUTAGE_STATE: ExtractionOutageState = {
	since: null,
	waits: 0,
};

/**
 * Where the state lives: a reserved key inside the job's `hints_json`.
 *
 * The ledger has no column that fits a counter of "attempts that did not count"
 * and this is not worth a migration, so it rides in the one job-level JSON
 * column. The reader lives here, beside the arithmetic that consumes it, so the
 * read model can ask the same question without importing the ledger.
 */
export const EXTRACTION_OUTAGE_HINT_KEY = "$outage";

export function readExtractionOutageState(
	hintsJson: string | null | undefined,
): ExtractionOutageState {
	if (!hintsJson) return EMPTY_EXTRACTION_OUTAGE_STATE;
	let parsed: unknown;
	try {
		parsed = JSON.parse(hintsJson);
	} catch {
		return EMPTY_EXTRACTION_OUTAGE_STATE;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return EMPTY_EXTRACTION_OUTAGE_STATE;
	}
	const raw = (parsed as Record<string, unknown>)[EXTRACTION_OUTAGE_HINT_KEY];
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return EMPTY_EXTRACTION_OUTAGE_STATE;
	}
	const record = raw as Record<string, unknown>;
	return {
		since:
			typeof record.since === "number" && Number.isFinite(record.since)
				? record.since
				: null,
		waits:
			typeof record.waits === "number" && Number.isFinite(record.waits)
				? Math.max(0, Math.trunc(record.waits))
				: 0,
	};
}

/**
 * Attempts actually spent ON THE DOCUMENT: every claim, minus the ones that
 * ended in "the backend is not answering". This, not `attempt_count`, is what
 * the budget and the ceiling are measured against.
 */
export function extractionDocumentAttempts(
	attemptCount: number,
	outage: ExtractionOutageState,
): number {
	return Math.max(0, Math.floor(attemptCount) - Math.max(0, outage.waits));
}

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
	return Math.round(capped * jitterFactor(random));
}

/**
 * The outage walk: 5 s, 10 s, 20 s … capped at 5 minutes, jittered like any
 * other backoff so a hundred documents queued behind one dead backend do not
 * all probe it on the same millisecond when it comes back.
 */
export function computeOutageBackoffMs(
	waits: number,
	random: () => number = Math.random,
): number {
	const safeWaits = Math.max(0, Math.floor(waits));
	const raw =
		EXTRACTION_OUTAGE_BACKOFF_BASE_MS *
		EXTRACTION_OUTAGE_BACKOFF_FACTOR ** safeWaits;
	const capped = Math.min(
		EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
		Number.isFinite(raw) ? raw : EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
	);
	return Math.round(capped * jitterFactor(random));
}

function jitterFactor(random: () => number): number {
	return (
		EXTRACTION_BACKOFF_JITTER_MIN +
		clamp01(random()) *
			(EXTRACTION_BACKOFF_JITTER_MAX - EXTRACTION_BACKOFF_JITTER_MIN)
	);
}

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export interface ExtractionRetryDecisionInput {
	code: ExtractionErrorCode;
	/** The extractor's own verdict; falls back to the code's default. */
	retryable?: boolean;
	/** Honoured in place of the computed backoff where it has a meaning. */
	retryAfterMs?: number;
	/** Attempts already consumed, i.e. the job's `attempt_count` after the claim. */
	attemptCount: number;
	maxAttempts: number;
	retryBaseMs: number;
	retryMaxMs: number;
	/** How long a job may keep waiting on an unreachable backend, in total. */
	outageWindowMs: number;
	/** What the ledger remembers about this job's outage, before this failure. */
	outage?: ExtractionOutageState;
	/** Epoch ms of this failure. Injected so the window is testable. */
	nowMs?: number;
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
	/** True while this requeue is a patient wait on an unreachable backend. */
	outageWait: boolean;
	/** The outage state to persist after this failure. */
	outage: ExtractionOutageState;
}

/**
 * The one place that decides "again or done".
 *
 * Three budgets, in order:
 *
 *  1. **The outage budget.** A code that means "the backend is not answering
 *     right now" is not evidence against the document, so it does not touch
 *     the attempt budget at all. It gets an exponential walk from 5 s to 5
 *     minutes for a total of `outageWindowMs` (half an hour by default), after
 *     which the job fails as `unavailable` — user-retryable, because the fix is
 *     someone bringing the backend back and then pressing the button.
 *  2. **The attempt budget**, for ordinary retryable document failures.
 *  3. **The ceiling**, past which nothing is offered. Both are measured in
 *     DOCUMENT attempts: `attempt_count` minus the outage waits.
 *
 * A code that is retryable but has burned its attempts becomes `max_attempts`
 * with `retryable: true` — the failure is terminal for the WORKER but not for
 * the USER, and the DTO must be able to say so. Conflating the two is how a
 * transient outage ends up looking like a permanently broken file.
 */
export function decideExtractionRetry(
	input: ExtractionRetryDecisionInput,
): ExtractionRetryDecision {
	const policy = extractionErrorPolicy(input.code);
	const outage = input.outage ?? EMPTY_EXTRACTION_OUTAGE_STATE;
	const nowMs = input.nowMs ?? Date.now();
	const retryable =
		input.retryable ?? RETRYABLE_EXTRACTION_ERROR_CODES.has(input.code);

	if (policy.autoRetry === "outage" && retryable) {
		return decideOutageWait({ ...input, outage, nowMs });
	}

	// A failure that is not an outage does NOT re-anchor the outage window.
	// Clearing `since` here let a backend that alternates between "not
	// answering" and any other code serve a brand-new half-hour window after
	// every interleaved failure, so a job could wait for hours while the docs —
	// and the DTO the user reads — promised half an hour. The window belongs to
	// the RUN, and only a success or a user-initiated retry starts a new run.
	// `waits` stays for the same reason it always did: those attempts were
	// still not spent on the document.
	const carried: ExtractionOutageState = {
		since: outage.since,
		waits: outage.waits,
	};
	const attempts = extractionDocumentAttempts(input.attemptCount, carried);
	const attemptsLeft = attempts < input.maxAttempts;

	// The ceiling is checked before anything else: past it the job is done,
	// whatever the code says and however many times the user presses Retry.
	if (attempts >= extractionAttemptCeiling(input.maxAttempts)) {
		return {
			requeue: false,
			delayMs: 0,
			jobErrorCode: "max_attempts",
			jobRetryable: false,
			outageWait: false,
			outage: carried,
		};
	}

	if (retryable && attemptsLeft) {
		return {
			requeue: true,
			delayMs: computeBackoffMs(
				attempts,
				input.retryBaseMs,
				input.retryMaxMs,
				input.random,
			),
			jobErrorCode: input.code,
			jobRetryable: true,
			outageWait: false,
			outage: carried,
		};
	}

	const cappedOut = retryable && !attemptsLeft;
	return {
		requeue: false,
		delayMs: 0,
		jobErrorCode: cappedOut ? "max_attempts" : input.code,
		// "The system gave up" and "you may not try" are different facts: an
		// `auth_failed` is never worth an automatic retry, but the moment an
		// admin fixes the key it is exactly what the user should be able to do.
		jobRetryable: cappedOut ? true : policy.userRetryable,
		outageWait: false,
		outage: carried,
	};
}

function decideOutageWait(
	input: ExtractionRetryDecisionInput & {
		outage: ExtractionOutageState;
		nowMs: number;
	},
): ExtractionRetryDecision {
	const since = input.outage.since ?? input.nowMs;
	const elapsed = Math.max(0, input.nowMs - since);
	const windowMs = Math.max(0, input.outageWindowMs);
	const spent: ExtractionOutageState = {
		since,
		waits: input.outage.waits + 1,
	};

	if (elapsed >= windowMs) {
		// Half an hour of an unreachable backend is long enough to stop guessing
		// on the user's behalf. The verdict is `unavailable` whichever outage
		// code got us here: "the document service was not reachable" is the true
		// statement, and a rate limit that never lifted is a species of that.
		return {
			requeue: false,
			delayMs: 0,
			jobErrorCode: "unavailable",
			jobRetryable: true,
			outageWait: false,
			outage: { since: null, waits: spent.waits },
		};
	}

	const remaining = windowMs - elapsed;
	const honoured =
		typeof input.retryAfterMs === "number" &&
		Number.isFinite(input.retryAfterMs) &&
		input.retryAfterMs >= 0
			? Math.round(input.retryAfterMs)
			: null;
	const delayMs = Math.min(
		remaining,
		honoured ?? computeOutageBackoffMs(input.outage.waits, input.random),
	);

	return {
		requeue: true,
		delayMs,
		jobErrorCode: input.code,
		jobRetryable: true,
		outageWait: true,
		outage: spent,
	};
}
