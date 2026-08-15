import { InvalidPromptError, LoadAPIKeyError } from "ai";
import { describe, expect, it } from "vitest";
import {
	classifyErrorCause,
	isAbortErrorCause,
	isRetryableErrorCause,
	readErrorHttpStatus,
} from "./error-cause";

describe("classifyErrorCause", () => {
	it("classifies a structured AbortError by name, not message text", () => {
		const abort = Object.assign(new Error("cancelled"), {
			name: "AbortError",
		});
		expect(classifyErrorCause(abort)).toBe("abort");
	});

	it("does NOT classify a bare message mentioning 'abort' as an abort cause", () => {
		// E1 — the old failover.ts landmine: message.includes("abort") matched
		// any prose containing the word, including a completely unrelated
		// network failure. A real AbortController-fired abort always sets
		// `.name === "AbortError"`; text alone is not a reliable signal.
		const notAnAbort = new Error("connection reset (client abort)");
		expect(classifyErrorCause(notAnAbort)).not.toBe("abort");
		expect(classifyErrorCause(notAnAbort)).toBe("network");
	});

	it("does NOT classify a bare message mentioning 'prompt' as invalid_request", () => {
		const notInvalidPrompt = new Error("connection reset while sending prompt");
		expect(classifyErrorCause(notInvalidPrompt)).not.toBe("invalid_request");
		expect(classifyErrorCause(notInvalidPrompt)).toBe("network");
	});

	it("classifies a real InvalidPromptError instance as invalid_request", () => {
		const error = new InvalidPromptError({
			prompt: [],
			message: "Invalid prompt: too many messages",
		});
		expect(classifyErrorCause(error)).toBe("invalid_request");
	});

	it("classifies a real LoadAPIKeyError instance as auth", () => {
		const error = new LoadAPIKeyError({ message: "Missing API key" });
		expect(classifyErrorCause(error)).toBe("auth");
	});

	it("classifies HTTP status codes structurally, ahead of message text", () => {
		expect(
			classifyErrorCause(Object.assign(new Error("nope"), { statusCode: 401 })),
		).toBe("auth");
		expect(
			classifyErrorCause(Object.assign(new Error("nope"), { statusCode: 403 })),
		).toBe("auth");
		expect(
			classifyErrorCause(Object.assign(new Error("nope"), { statusCode: 429 })),
		).toBe("rate_limit");
		expect(
			classifyErrorCause(Object.assign(new Error("nope"), { statusCode: 503 })),
		).toBe("provider_unavailable");
		expect(
			classifyErrorCause(Object.assign(new Error("nope"), { statusCode: 400 })),
		).toBe("invalid_request");
	});

	it("walks the cause chain for a structured HTTP status", () => {
		const wrapped = new Error("wrapped", {
			cause: Object.assign(new Error("inner"), { statusCode: 503 }),
		});
		expect(classifyErrorCause(wrapped)).toBe("provider_unavailable");
	});

	it("falls back to narrow technical-term text matching with no structured signal", () => {
		expect(classifyErrorCause(new Error("request timed out"))).toBe("timeout");
		expect(classifyErrorCause(new Error("fetch failed"))).toBe("network");
		expect(classifyErrorCause(new Error("too many requests"))).toBe(
			"rate_limit",
		);
		expect(classifyErrorCause(new Error("service unavailable"))).toBe(
			"provider_unavailable",
		);
		expect(classifyErrorCause(new Error("stream ended unexpectedly"))).toBe(
			"premature_completion",
		);
	});

	it("classifies unrecognized errors as unknown", () => {
		expect(classifyErrorCause(new Error("something odd happened"))).toBe(
			"unknown",
		);
		expect(classifyErrorCause(null)).toBe("unknown");
		expect(classifyErrorCause("a bare string")).toBe("unknown");
	});
});

describe("isAbortErrorCause", () => {
	it("is true only for a structured AbortError name", () => {
		expect(
			isAbortErrorCause(Object.assign(new Error("x"), { name: "AbortError" })),
		).toBe(true);
		expect(isAbortErrorCause(new Error("operation abort"))).toBe(false);
		expect(isAbortErrorCause(null)).toBe(false);
	});

	it("walks the cause chain", () => {
		const wrapped = new Error("wrapped", {
			cause: Object.assign(new Error("inner"), { name: "AbortError" }),
		});
		expect(isAbortErrorCause(wrapped)).toBe(true);
	});
});

describe("readErrorHttpStatus", () => {
	it("reads statusCode or status, preferring statusCode", () => {
		expect(
			readErrorHttpStatus(Object.assign(new Error("x"), { statusCode: 418 })),
		).toBe(418);
		expect(
			readErrorHttpStatus(Object.assign(new Error("x"), { status: 502 })),
		).toBe(502);
		expect(readErrorHttpStatus(new Error("no status"))).toBeNull();
	});
});

describe("isRetryableErrorCause", () => {
	it("treats transient causes as retryable", () => {
		for (const cause of [
			"timeout",
			"rate_limit",
			"network",
			"provider_unavailable",
			"premature_completion",
		] as const) {
			expect(isRetryableErrorCause(cause)).toBe(true);
		}
	});

	it("treats terminal/unknown causes as non-retryable", () => {
		for (const cause of [
			"abort",
			"auth",
			"invalid_request",
			"provider_error",
			"unknown",
		] as const) {
			expect(isRetryableErrorCause(cause)).toBe(false);
		}
	});
});
