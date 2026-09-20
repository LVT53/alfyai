import { describe, expect, it } from "vitest";
import {
	EXTRACTION_ERROR_CODES,
	RETRYABLE_EXTRACTION_ERROR_CODES,
} from "$lib/shared/extraction-status";
import { computeBackoffMs, decideExtractionRetry } from "./retry-policy";

/** Pins the jitter so an exponent bug cannot hide inside a range assertion. */
const noJitter = () => 0.5;
const minJitter = () => 0;
const maxJitter = () => 1;

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

describe("decideExtractionRetry", () => {
	const base = {
		attemptCount: 1,
		maxAttempts: 3,
		retryBaseMs: 2000,
		retryMaxMs: 60000,
		random: noJitter,
	};

	it("requeues a retryable code that has attempts left", () => {
		expect(decideExtractionRetry({ ...base, code: "unavailable" })).toEqual({
			requeue: true,
			delayMs: 2000,
			jobErrorCode: "unavailable",
			jobRetryable: true,
		});
	});

	it("honours retryAfterMs for rate_limited instead of the computed backoff", () => {
		expect(
			decideExtractionRetry({
				...base,
				code: "rate_limited",
				retryAfterMs: 45_000,
			}).delayMs,
		).toBe(45_000);
	});

	it("ignores retryAfterMs for any other code", () => {
		// A retry-after only has a defined meaning for a rate limit; honouring it
		// elsewhere would let one odd header stall an unrelated failure.
		expect(
			decideExtractionRetry({
				...base,
				code: "timeout",
				retryAfterMs: 45_000,
			}).delayMs,
		).toBe(2000);
	});

	it("turns an exhausted retryable code into max_attempts, still user-retryable", () => {
		expect(
			decideExtractionRetry({ ...base, code: "unavailable", attemptCount: 3 }),
		).toEqual({
			requeue: false,
			delayMs: 0,
			jobErrorCode: "max_attempts",
			jobRetryable: true,
		});
	});

	it("fails a non-retryable code on the first attempt, with its own code", () => {
		expect(decideExtractionRetry({ ...base, code: "too_large" })).toEqual({
			requeue: false,
			delayMs: 0,
			jobErrorCode: "too_large",
			jobRetryable: false,
		});
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
