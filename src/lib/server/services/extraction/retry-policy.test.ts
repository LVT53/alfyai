import { describe, expect, it } from "vitest";
import {
	EXTRACTION_ERROR_CODES,
	EXTRACTION_ERROR_POLICIES,
	RETRYABLE_EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";
import {
	computeBackoffMs,
	computeOutageBackoffMs,
	decideExtractionRetry,
	EXTRACTION_OUTAGE_BACKOFF_BASE_MS,
	EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
	EXTRACTION_USER_RETRY_GRANTS,
	extractionAttemptCeiling,
	extractionDocumentAttempts,
	readExtractionOutageState,
} from "./retry-policy";

/** Pins the jitter so an exponent bug cannot hide inside a range assertion. */
const noJitter = () => 0.5;
const minJitter = () => 0;
const maxJitter = () => 1;

const WINDOW_MS = 1_800_000;

describe("computeBackoffMs", () => {
	it("triples per attempt", () => {
		expect(computeBackoffMs(1, 2000, 60000, noJitter)).toBe(2000);
		expect(computeBackoffMs(2, 2000, 60000, noJitter)).toBe(6000);
		expect(computeBackoffMs(3, 2000, 60000, noJitter)).toBe(18000);
		expect(computeBackoffMs(4, 2000, 60000, noJitter)).toBe(54000);
	});

	it("stops at the ceiling", () => {
		expect(computeBackoffMs(9, 2000, 60000, noJitter)).toBe(60000);
		expect(computeBackoffMs(99, 2000, 60000, noJitter)).toBe(60000);
	});

	it("jitters within ±20%", () => {
		expect(computeBackoffMs(1, 2000, 60000, minJitter)).toBe(1600);
		expect(computeBackoffMs(1, 2000, 60000, maxJitter)).toBe(2400);
	});

	it("tolerates a nonsense attempt number or random source", () => {
		expect(computeBackoffMs(0, 2000, 60000, noJitter)).toBe(2000);
		expect(computeBackoffMs(-5, 2000, 60000, noJitter)).toBe(2000);
		expect(computeBackoffMs(1, 2000, 60000, () => Number.NaN)).toBe(1600);
	});
});

describe("computeOutageBackoffMs", () => {
	it("doubles from five seconds and stops at five minutes", () => {
		expect(computeOutageBackoffMs(0, noJitter)).toBe(
			EXTRACTION_OUTAGE_BACKOFF_BASE_MS,
		);
		expect(computeOutageBackoffMs(1, noJitter)).toBe(10_000);
		expect(computeOutageBackoffMs(2, noJitter)).toBe(20_000);
		// 5 s × 2^6 would be 320 s; the cap bites first.
		expect(computeOutageBackoffMs(6, noJitter)).toBe(
			EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
		);
		expect(computeOutageBackoffMs(99, noJitter)).toBe(
			EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
		);
	});
});

describe("the error policy table", () => {
	it("derives the auto-retry set from the table, with no second opinion", () => {
		expect([...RETRYABLE_EXTRACTION_ERROR_CODES].sort()).toEqual(
			[
				"job_failed",
				"protocol",
				"rate_limited",
				"stale_worker",
				"timeout",
				"unavailable",
			].sort(),
		);
	});

	// The live failure: after an admin fixed MINERU_API_URL, or the key, or the
	// tier, every document that failed in the meantime answered 404 to Retry.
	it("makes every configuration failure user-retryable but never auto-retried", () => {
		for (const code of [
			"auth_failed",
			"tier_unavailable",
			"backend_misconfigured",
		] as const) {
			expect(EXTRACTION_ERROR_POLICIES[code], code).toEqual({
				autoRetry: "none",
				userRetryable: true,
			});
		}
	});

	it("offers nothing at all for a permanent fact about the document", () => {
		for (const code of [
			"unsupported_type",
			"too_large",
			"empty_result",
		] as const) {
			expect(EXTRACTION_ERROR_POLICIES[code], code).toEqual({
				autoRetry: "none",
				userRetryable: false,
			});
		}
	});
});

describe("decideExtractionRetry", () => {
	const base = {
		attemptCount: 1,
		maxAttempts: 3,
		retryBaseMs: 2000,
		retryMaxMs: 60000,
		outageWindowMs: WINDOW_MS,
		nowMs: 0,
		random: noJitter,
	};

	it("requeues a retryable document failure that has attempts left", () => {
		expect(
			decideExtractionRetry({ ...base, code: "job_failed" }),
		).toMatchObject({
			requeue: true,
			delayMs: 2000,
			jobErrorCode: "job_failed",
			jobRetryable: true,
			outageWait: false,
		});
	});

	it("turns an exhausted retryable code into max_attempts, still user-retryable", () => {
		expect(
			decideExtractionRetry({ ...base, code: "job_failed", attemptCount: 3 }),
		).toMatchObject({
			requeue: false,
			delayMs: 0,
			jobErrorCode: "max_attempts",
			jobRetryable: true,
		});
	});

	// Each user Retry grants one more attempt, which is what makes the button
	// useful once the automatic budget runs out. Without a ceiling on top,
	// one user with one broken document can generate unbounded backend work by
	// pressing it.
	it("stops offering Retry once the total-attempt ceiling is reached", () => {
		const ceiling = extractionAttemptCeiling(base.maxAttempts);
		expect(ceiling).toBe(base.maxAttempts + EXTRACTION_USER_RETRY_GRANTS);

		expect(
			decideExtractionRetry({
				...base,
				code: "job_failed",
				attemptCount: ceiling - 1,
			}),
		).toMatchObject({ jobErrorCode: "max_attempts", jobRetryable: true });

		expect(
			decideExtractionRetry({
				...base,
				code: "job_failed",
				attemptCount: ceiling,
			}),
		).toMatchObject({
			requeue: false,
			jobErrorCode: "max_attempts",
			jobRetryable: false,
		});
	});

	it("fails a non-retryable code on the first attempt, with its own code", () => {
		expect(decideExtractionRetry({ ...base, code: "too_large" })).toMatchObject(
			{
				requeue: false,
				delayMs: 0,
				jobErrorCode: "too_large",
				jobRetryable: false,
			},
		);
	});

	it("keeps a non-retryable code non-retryable even at the cap", () => {
		expect(
			decideExtractionRetry({
				...base,
				code: "empty_result",
				attemptCount: 3,
			}).jobErrorCode,
		).toBe("empty_result");
	});

	// Ruling 2. The verdict a wrong key gets is terminal for the WORKER and
	// open for the USER; conflating the two left every document stuck.
	it("offers the user a retry on a configuration failure the worker will not retry", () => {
		for (const code of [
			"auth_failed",
			"tier_unavailable",
			"backend_misconfigured",
		] as const) {
			expect(decideExtractionRetry({ ...base, code }), code).toMatchObject({
				requeue: false,
				jobErrorCode: code,
				jobRetryable: true,
			});
		}
	});

	it("lets an extractor's explicit verdict override the code default", () => {
		expect(
			decideExtractionRetry({ ...base, code: "too_large", retryable: true })
				.requeue,
		).toBe(true);
		expect(
			decideExtractionRetry({
				...base,
				code: "unavailable",
				retryable: false,
			}).requeue,
		).toBe(false);
	});

	it("defaults every code's retryability to the shared set", () => {
		for (const code of EXTRACTION_ERROR_CODES) {
			const decision = decideExtractionRetry({ ...base, code });
			expect(decision.requeue, code).toBe(
				RETRYABLE_EXTRACTION_ERROR_CODES.has(code),
			);
		}
	});
});

// ---------------------------------------------------------------------------
// Ruling 1: the outage budget
// ---------------------------------------------------------------------------

describe("the outage budget", () => {
	const base = {
		attemptCount: 1,
		maxAttempts: 3,
		retryBaseMs: 2000,
		retryMaxMs: 60000,
		outageWindowMs: WINDOW_MS,
		random: noJitter,
	};

	// The live failure: MAX_ATTEMPTS 3 with a 2 s base backoff tolerates about
	// ten seconds of downtime. A MinerU restart took 54 s, and every in-flight
	// document was permanently failed 37 s before the backend came back.
	it("keeps waiting well past the point the attempt budget would have given up", () => {
		let outage = { since: null as number | null, waits: 0 };
		let nowMs = 0;
		for (let i = 0; i < 10; i++) {
			const decision = decideExtractionRetry({
				...base,
				code: "unavailable",
				attemptCount: i + 1,
				outage,
				nowMs,
			});
			expect(decision.requeue, `wait ${i}`).toBe(true);
			expect(decision.outageWait, `wait ${i}`).toBe(true);
			outage = decision.outage;
			nowMs += decision.delayMs;
		}
		// Ten waits in, and still going: far more than ten seconds of tolerance.
		expect(nowMs).toBeGreaterThan(600_000);
	});

	it("does not spend the document's attempt budget while it waits", () => {
		const outage = { since: 0, waits: 12 };
		expect(extractionDocumentAttempts(13, outage)).toBe(1);

		// Thirteen claims, twelve of them outage waits. The FOURTEENTH failure is
		// an ordinary one and must still be the document's second attempt, not
		// its fourteenth.
		expect(
			decideExtractionRetry({
				...base,
				code: "job_failed",
				attemptCount: 13,
				outage,
				nowMs: 100,
			}),
		).toMatchObject({ requeue: true, jobErrorCode: "job_failed" });
	});

	it("gives up after the window and asks the user, not the worker, to try again", () => {
		const decision = decideExtractionRetry({
			...base,
			code: "timeout",
			attemptCount: 9,
			outage: { since: 0, waits: 8 },
			nowMs: WINDOW_MS,
		});
		expect(decision).toMatchObject({
			requeue: false,
			jobErrorCode: "unavailable",
			jobRetryable: true,
			outageWait: false,
		});
		// The wait is still counted, so the user's Retry budget survived it.
		expect(decision.outage).toEqual({ since: null, waits: 9 });
	});

	it("honours Retry-After, but never past the end of the window", () => {
		expect(
			decideExtractionRetry({
				...base,
				code: "rate_limited",
				retryAfterMs: 45_000,
				outage: { since: 0, waits: 0 },
				nowMs: 0,
			}).delayMs,
		).toBe(45_000);

		expect(
			decideExtractionRetry({
				...base,
				code: "rate_limited",
				retryAfterMs: 3_600_000,
				outage: { since: 0, waits: 0 },
				nowMs: WINDOW_MS - 10_000,
			}).delayMs,
		).toBe(10_000);
	});

	it("does not re-anchor the window when something other than an outage happens", () => {
		// The window belongs to the RUN, not to the last outage failure: an
		// ordinary failure in the middle of an outage is not evidence that the
		// backend came back, so it must not buy another half hour.
		const decision = decideExtractionRetry({
			...base,
			code: "job_failed",
			attemptCount: 5,
			outage: { since: 1000, waits: 4 },
			nowMs: 5000,
		});
		expect(decision.outage).toEqual({ since: 1000, waits: 4 });
	});

	it("cannot serve more than one window when codes alternate", () => {
		// The live shape: a backend that answers some claims with "not
		// answering" and drops others as `stale_worker`. Re-basing `since` on
		// the `stale_worker` gave the `unavailable` run a brand-new half hour
		// every other failure, so one job could wait for hours.
		//
		// `maxAttempts` is set high enough that the DOCUMENT budget cannot be
		// what stops the loop — the window has to.
		let outage = { since: null as number | null, waits: 0 };
		let nowMs = 0;
		let attemptCount = 0;
		let lastCode = "";
		let terminal = false;
		for (let i = 0; i < 200 && !terminal; i++) {
			attemptCount += 1;
			const decision = decideExtractionRetry({
				...base,
				maxAttempts: 500,
				code: i % 2 === 0 ? "unavailable" : "stale_worker",
				attemptCount,
				outage,
				nowMs,
			});
			outage = decision.outage;
			lastCode = decision.jobErrorCode;
			terminal = !decision.requeue;
			nowMs += decision.delayMs;
		}

		expect(terminal).toBe(true);
		expect(lastCode).toBe("unavailable");
		// One window, not two: the last wait may end at most one full outage
		// backoff past the window's end.
		expect(nowMs).toBeLessThanOrEqual(
			WINDOW_MS + EXTRACTION_OUTAGE_BACKOFF_MAX_MS,
		);
	});

	it("gives a user retry a fresh window after an exhausted one", () => {
		// `retryExtractionJob` / `requestReextraction` write back `since: null`
		// with `waits` carried, which is the state this asserts on: the next
		// outage failure anchors a new window at the moment it happens.
		const exhausted = decideExtractionRetry({
			...base,
			code: "unavailable",
			attemptCount: 9,
			outage: { since: 0, waits: 8 },
			nowMs: WINDOW_MS,
		});
		expect(exhausted.requeue).toBe(false);

		const afterUserRetry = { since: null, waits: exhausted.outage.waits };
		const decision = decideExtractionRetry({
			...base,
			code: "unavailable",
			attemptCount: 10,
			outage: afterUserRetry,
			nowMs: WINDOW_MS + 60_000,
		});
		expect(decision).toMatchObject({ requeue: true, outageWait: true });
		expect(decision.outage.since).toBe(WINDOW_MS + 60_000);
	});

	it("still ends the document's budget and the ceiling exactly as before", () => {
		// The carried `since` must not leak into the attempt arithmetic: three
		// ordinary failures still exhaust `maxAttempts`, and the ceiling still
		// counts DOCUMENT attempts only.
		expect(
			decideExtractionRetry({
				...base,
				code: "job_failed",
				attemptCount: 3,
				outage: { since: 1000, waits: 0 },
				nowMs: 5000,
			}),
		).toMatchObject({
			requeue: false,
			jobErrorCode: "max_attempts",
			jobRetryable: true,
		});

		expect(
			decideExtractionRetry({
				...base,
				code: "job_failed",
				attemptCount: 3 + EXTRACTION_USER_RETRY_GRANTS + 12,
				outage: { since: 1000, waits: 12 },
				nowMs: 5000,
			}),
		).toMatchObject({
			requeue: false,
			jobErrorCode: "max_attempts",
			jobRetryable: false,
		});
	});
});

describe("readExtractionOutageState", () => {
	it("reads the reserved key back out of a hints blob", () => {
		expect(
			readExtractionOutageState(
				JSON.stringify({ tier: "basic", $outage: { since: 42, waits: 3 } }),
			),
		).toEqual({ since: 42, waits: 3 });
	});

	it("answers empty for anything it cannot read", () => {
		for (const json of [null, "", "not json", "[]", '{"tier":"basic"}']) {
			expect(readExtractionOutageState(json)).toEqual({
				since: null,
				waits: 0,
			});
		}
	});
});
