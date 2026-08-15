// E1 — failover.ts had no dedicated test file before this slice (only
// exercised indirectly through normal-chat-failover.test.ts, which imports
// via the ../normal-chat-failover re-export shim). This file targets
// isRetryableNormalChatFallbackError's classification directly and proves:
//   1. The old `message.includes("prompt")` / `message.includes("abort")`
//      landmine is gone — a message that merely *mentions* either word no
//      longer forces a non-retryable verdict.
//   2. The new structured classification (HTTP status, `.name`, AI SDK
//      error classes) still correctly identifies real aborts/invalid
//      prompts/auth failures as non-retryable.
import { InvalidPromptError, LoadAPIKeyError } from "ai";
import { describe, expect, it } from "vitest";
import { isRetryableNormalChatFallbackError } from "./failover";

describe("isRetryableNormalChatFallbackError — prose-substring landmine removed", () => {
	it("no longer forces non-retryable just because the message mentions 'abort'", () => {
		// Before E1 this returned false purely because the message contained
		// the substring "abort" — even though it is really a retryable
		// connection failure whose text happens to mention an unrelated abort.
		const error = new Error("connection reset (client abort)");
		expect(isRetryableNormalChatFallbackError(error)).toBe(true);
	});

	it("no longer forces non-retryable just because the message mentions 'prompt'", () => {
		const error = new Error("connection reset while sending prompt");
		expect(isRetryableNormalChatFallbackError(error)).toBe(true);
	});

	it("does not misclassify user-authored text that happens to contain 'abort' or 'prompt'", () => {
		// A provider that echoes request content back into an error message
		// (or a message that otherwise happens to contain either word) must
		// not be treated as a structural abort/invalid-prompt signal.
		const echoedUserText = new Error(
			"fetch failed: request body included 'please abort and use a shorter prompt'",
		);
		expect(isRetryableNormalChatFallbackError(echoedUserText)).toBe(true);
	});
});

describe("isRetryableNormalChatFallbackError — structured classification", () => {
	it("still treats a genuine AbortError (structured name) as non-retryable", () => {
		const abort = Object.assign(new Error("The operation was aborted"), {
			name: "AbortError",
		});
		expect(isRetryableNormalChatFallbackError(abort)).toBe(false);
	});

	it("treats a real InvalidPromptError instance as non-retryable", () => {
		const error = new InvalidPromptError({
			prompt: [],
			message: "Invalid prompt: too many messages",
		});
		expect(isRetryableNormalChatFallbackError(error)).toBe(false);
	});

	it("treats a real LoadAPIKeyError instance as non-retryable", () => {
		const error = new LoadAPIKeyError({ message: "Missing API key" });
		expect(isRetryableNormalChatFallbackError(error)).toBe(false);
	});

	it("keys auth/rate-limit/server-error classification off HTTP status, not message text", () => {
		expect(
			isRetryableNormalChatFallbackError(
				Object.assign(new Error("nope"), { statusCode: 401 }),
			),
		).toBe(false);
		expect(
			isRetryableNormalChatFallbackError(
				Object.assign(new Error("nope"), { statusCode: 403 }),
			),
		).toBe(false);
		expect(
			isRetryableNormalChatFallbackError(
				Object.assign(new Error("nope"), { statusCode: 429 }),
			),
		).toBe(true);
		expect(
			isRetryableNormalChatFallbackError(
				Object.assign(new Error("nope"), { statusCode: 503 }),
			),
		).toBe(true);
	});

	it("still recognizes narrow technical-term transport/timeout text with no structured signal", () => {
		expect(isRetryableNormalChatFallbackError(new Error("fetch failed"))).toBe(
			true,
		);
		expect(
			isRetryableNormalChatFallbackError(new Error("request timed out")),
		).toBe(true);
		expect(
			isRetryableNormalChatFallbackError(
				new Error("stream ended unexpectedly"),
			),
		).toBe(true);
	});

	it("defaults unrecognized, unstructured errors to non-retryable", () => {
		expect(
			isRetryableNormalChatFallbackError(new Error("something odd happened")),
		).toBe(false);
	});
});
