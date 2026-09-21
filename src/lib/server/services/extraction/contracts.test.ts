import { describe, expect, it } from "vitest";
import {
	abortDiscardsRemoteWork,
	DocumentExtractionError,
	ExtractionAbortError,
	isDocumentExtractionError,
	parseExtractionHandle,
	readExtractionAbortReason,
	serializeExtractionHandle,
	toDocumentExtractionError,
} from "./contracts";

describe("DocumentExtractionError", () => {
	it("falls back to the code's default retryability", () => {
		expect(
			new DocumentExtractionError({ code: "unavailable", message: "down" })
				.retryable,
		).toBe(true);
		expect(
			new DocumentExtractionError({ code: "auth_failed", message: "401" })
				.retryable,
		).toBe(false);
	});

	it("lets an extractor override the default per throw", () => {
		const error = new DocumentExtractionError({
			code: "too_large",
			message: "too big for this tier, smaller tier may work",
			retryable: true,
		});
		expect(error.retryable).toBe(true);
	});

	it("defaults handleUnknown to false and keeps the cause", () => {
		const cause = new Error("root");
		const error = new DocumentExtractionError({
			code: "protocol",
			message: "bad payload",
			cause,
		});
		expect(error.handleUnknown).toBe(false);
		expect(error.cause).toBe(cause);
		expect(isDocumentExtractionError(error)).toBe(true);
		expect(isDocumentExtractionError(new Error("plain"))).toBe(false);
	});
});

describe("toDocumentExtractionError", () => {
	it("passes an already-mapped error through untouched", () => {
		const error = new DocumentExtractionError({
			code: "rate_limited",
			message: "slow down",
			retryAfterMs: 5000,
		});
		expect(toDocumentExtractionError(error)).toBe(error);
	});

	it("maps an AbortError to canceled, not to a retryable fault", () => {
		const mapped = toDocumentExtractionError(
			new DOMException("aborted", "AbortError"),
		);
		expect(mapped.code).toBe("canceled");
		expect(mapped.retryable).toBe(false);
	});

	it("recognises an abort by name, not by instanceof", () => {
		// The regression this pins: `instanceof DOMException` is false for the
		// abort reason under jsdom, and false across any realm boundary. An abort
		// that fell through to the `internal` branch would be a non-retryable
		// permanent failure for a document the user merely cancelled.
		const alienAbort = { name: "AbortError", message: "aborted" };
		expect(toDocumentExtractionError(alienAbort).code).toBe("canceled");
		expect(toDocumentExtractionError(alienAbort).retryable).toBe(false);
	});

	it("maps a TimeoutError to a RETRYABLE timeout, never to canceled", () => {
		// `AbortSignal.timeout` rejects with a TimeoutError, and this used to
		// share the cancel branch: one leaked request timeout therefore failed a
		// document permanently as "Extraction was canceled." — a final verdict,
		// on a transient fault, in words that blame a user who did nothing.
		const alienTimeout = Object.assign(new Error("timed out"), {
			name: "TimeoutError",
		});
		expect(toDocumentExtractionError(alienTimeout).code).toBe("timeout");
		expect(toDocumentExtractionError(alienTimeout).retryable).toBe(true);
		expect(toDocumentExtractionError(alienTimeout).message).not.toMatch(
			/cancel/i,
		);

		// A real DOMException takes the same branch; the structural check is a
		// widening, never a replacement.
		const real = toDocumentExtractionError(
			new DOMException("t", "TimeoutError"),
		);
		expect(real.code).toBe("timeout");
		expect(real.retryable).toBe(true);
	});

	it("labels an abort with the reason that decides whether remote work dies", () => {
		const cancel = new AbortController();
		cancel.abort(new ExtractionAbortError("user-cancel"));
		expect(abortDiscardsRemoteWork(cancel.signal)).toBe(true);
		expect(readExtractionAbortReason(cancel.signal.reason)).toBe("user-cancel");
		expect(toDocumentExtractionError(cancel.signal.reason).code).toBe(
			"canceled",
		);

		for (const reason of ["claim-lost", "shutdown"] as const) {
			const controller = new AbortController();
			controller.abort(new ExtractionAbortError(reason));
			// A lost claim and a shutdown both abort; neither means the remote job
			// is garbage, because the stored handle is what the next attempt
			// resumes from.
			expect(abortDiscardsRemoteWork(controller.signal)).toBe(false);
			expect(toDocumentExtractionError(controller.signal.reason).code).toBe(
				"canceled",
			);
		}

		// A bare abort carries no reason, and the conservative reading wins:
		// keeping a remote job nobody reads costs a queue slot, deleting one that
		// is still wanted costs the whole parse.
		const bare = new AbortController();
		bare.abort();
		expect(abortDiscardsRemoteWork(bare.signal)).toBe(false);
		expect(abortDiscardsRemoteWork(new AbortController().signal)).toBe(false);
		expect(abortDiscardsRemoteWork(null)).toBe(false);
	});

	it("maps a failed fetch to unavailable", () => {
		const mapped = toDocumentExtractionError(new TypeError("fetch failed"));
		expect(mapped.code).toBe("unavailable");
		expect(mapped.retryable).toBe(true);
	});

	it("maps a refused connection to unavailable", () => {
		const error = Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		});
		expect(toDocumentExtractionError(error).code).toBe("unavailable");
	});

	it("maps anything else to a non-retryable internal error", () => {
		const mapped = toDocumentExtractionError(new Error("something odd"));
		expect(mapped.code).toBe("internal");
		expect(mapped.retryable).toBe(false);
		expect(mapped.message).toBe("something odd");
	});

	it("never throws, whatever it is handed", () => {
		for (const value of [null, undefined, 42, "boom", {}, Symbol("x")]) {
			expect(() => toDocumentExtractionError(value)).not.toThrow();
		}
		expect(toDocumentExtractionError("boom").message).toBe("boom");
	});
});

describe("handle serialization", () => {
	it("round-trips a handle", () => {
		const handle = {
			extractor: "fake",
			version: 1 as const,
			remoteJobId: "job-1",
			data: { tier: "standard" },
		};
		const json = serializeExtractionHandle(handle);
		expect(parseExtractionHandle(json)).toMatchObject({
			extractor: "fake",
			remoteJobId: "job-1",
			data: { tier: "standard" },
		});
	});

	it("discards a handle another extractor produced", () => {
		// Resuming into a foreign handle is the one way this seam could corrupt
		// a live remote job, so it is refused rather than tolerated.
		const json = serializeExtractionHandle({
			extractor: "other",
			version: 1,
			remoteJobId: "job-1",
		});
		expect(parseExtractionHandle(json, "fake")).toBeNull();
		expect(parseExtractionHandle(json, "other")).not.toBeNull();
	});

	it("discards an unknown version, malformed JSON and null", () => {
		expect(
			parseExtractionHandle('{"extractor":"fake","version":2}'),
		).toBeNull();
		expect(parseExtractionHandle("{not json")).toBeNull();
		expect(parseExtractionHandle("[]")).toBeNull();
		expect(parseExtractionHandle(null)).toBeNull();
		expect(serializeExtractionHandle(null)).toBeNull();
	});
});
