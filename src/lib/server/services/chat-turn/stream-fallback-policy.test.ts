import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	shouldFallbackAfterUpstreamEndWithCompletedTools,
	shouldFallbackOnAbruptTermination,
	shouldFallbackOnIdleTimeout,
	shouldFallbackOnStreamConnectFailure,
	shouldFallbackOnStreamError,
	shouldFallbackOnUpstreamErrorEvent,
	shouldFallbackToNonStreaming,
} from "./stream-fallback-policy";

vi.mock("$lib/server/services/normal-chat-failover", () => ({
	isModelTimeoutError: vi.fn(() => false),
}));

async function getIsModelTimeoutError() {
	const { isModelTimeoutError } = await import(
		"$lib/server/services/normal-chat-failover"
	);
	return isModelTimeoutError as ReturnType<typeof vi.fn>;
}

describe("shouldFallbackToNonStreaming", () => {
	beforeEach(async () => {
		(await getIsModelTimeoutError()).mockReturnValue(false);
	});

	it("returns false for non-Error values", () => {
		expect(shouldFallbackToNonStreaming("socket terminated")).toBe(false);
		expect(shouldFallbackToNonStreaming(null)).toBe(false);
		expect(shouldFallbackToNonStreaming(undefined)).toBe(false);
	});

	it("recovers from transport-shaped error messages", () => {
		for (const message of [
			"socket hang up",
			"fetch failed",
			"the connection was reset",
			"upstream terminated",
			"request timed out",
			"operation abort",
		]) {
			expect(shouldFallbackToNonStreaming(new Error(message))).toBe(true);
		}
	});

	it("recovers from AbortError by name even without a matching message", () => {
		const error = new Error("no keywords here");
		error.name = "AbortError";
		expect(shouldFallbackToNonStreaming(error)).toBe(true);
	});

	it("recovers when the model-timeout classifier flags the error", async () => {
		(await getIsModelTimeoutError()).mockReturnValue(true);
		expect(shouldFallbackToNonStreaming(new Error("anything"))).toBe(true);
	});

	it("does not recover from unrelated errors", () => {
		expect(shouldFallbackToNonStreaming(new Error("bad request 400"))).toBe(
			false,
		);
	});
});

describe("shouldFallbackOnStreamConnectFailure", () => {
	const eligibleError = new Error("socket hang up");

	it("falls back only when nothing was emitted, no stop, and error is eligible", () => {
		expect(
			shouldFallbackOnStreamConnectFailure({
				error: eligibleError,
				wasStopRequested: false,
				hasEmittedStreamOutput: false,
			}),
		).toBe(true);
	});

	it("does not fall back once anything has been emitted", () => {
		expect(
			shouldFallbackOnStreamConnectFailure({
				error: eligibleError,
				wasStopRequested: false,
				hasEmittedStreamOutput: true,
			}),
		).toBe(false);
	});

	it("does not fall back when a stop was requested", () => {
		expect(
			shouldFallbackOnStreamConnectFailure({
				error: eligibleError,
				wasStopRequested: true,
				hasEmittedStreamOutput: false,
			}),
		).toBe(false);
	});

	it("does not fall back for ineligible errors", () => {
		expect(
			shouldFallbackOnStreamConnectFailure({
				error: new Error("nope"),
				wasStopRequested: false,
				hasEmittedStreamOutput: false,
			}),
		).toBe(false);
	});
});

describe("shouldFallbackAfterUpstreamEndWithCompletedTools", () => {
	it("falls back when no prior fallback and no stop", () => {
		expect(
			shouldFallbackAfterUpstreamEndWithCompletedTools({
				attemptedNonStreamFallback: false,
				wasStopRequested: false,
			}),
		).toBe(true);
	});

	it("does not fall back twice", () => {
		expect(
			shouldFallbackAfterUpstreamEndWithCompletedTools({
				attemptedNonStreamFallback: true,
				wasStopRequested: false,
			}),
		).toBe(false);
	});

	it("does not fall back after a stop", () => {
		expect(
			shouldFallbackAfterUpstreamEndWithCompletedTools({
				attemptedNonStreamFallback: false,
				wasStopRequested: true,
			}),
		).toBe(false);
	});
});

describe("shouldFallbackOnUpstreamErrorEvent", () => {
	const base = {
		error: new Error("socket terminated"),
		attemptedNonStreamFallback: false,
		wasStopRequested: false,
		hasVisibleAssistantAnswerOutput: false,
		hasVisibleStreamOutput: false,
		hasCompletedNonFileToolCall: false,
	};

	it("falls back when the base gate passes and nothing visible streamed", () => {
		expect(shouldFallbackOnUpstreamErrorEvent(base)).toBe(true);
	});

	it("falls back when visible output is only a completed non-file tool call", () => {
		expect(
			shouldFallbackOnUpstreamErrorEvent({
				...base,
				hasVisibleStreamOutput: true,
				hasCompletedNonFileToolCall: true,
			}),
		).toBe(true);
	});

	it("does not fall back when visible non-tool output already streamed", () => {
		expect(
			shouldFallbackOnUpstreamErrorEvent({
				...base,
				hasVisibleStreamOutput: true,
				hasCompletedNonFileToolCall: false,
			}),
		).toBe(false);
	});

	it("does not fall back when a visible assistant answer exists", () => {
		expect(
			shouldFallbackOnUpstreamErrorEvent({
				...base,
				hasVisibleAssistantAnswerOutput: true,
			}),
		).toBe(false);
	});

	it("does not fall back for ineligible errors", () => {
		expect(
			shouldFallbackOnUpstreamErrorEvent({ ...base, error: new Error("nope") }),
		).toBe(false);
	});

	it("does not fall back after a prior fallback attempt", () => {
		expect(
			shouldFallbackOnUpstreamErrorEvent({
				...base,
				attemptedNonStreamFallback: true,
			}),
		).toBe(false);
	});
});

describe("shouldFallbackOnIdleTimeout", () => {
	it("falls back when there is no visible answer", () => {
		expect(
			shouldFallbackOnIdleTimeout({ hasVisibleAssistantAnswerOutput: false }),
		).toBe(true);
	});

	it("does not fall back when a visible answer exists", () => {
		expect(
			shouldFallbackOnIdleTimeout({ hasVisibleAssistantAnswerOutput: true }),
		).toBe(false);
	});
});

describe("shouldFallbackOnStreamError", () => {
	const base = {
		error: new Error("plain error"),
		attemptedNonStreamFallback: false,
		wasStopRequested: false,
		hasVisibleAssistantAnswerOutput: false,
		hasVisibleStreamOutput: false,
		upstreamIdleTimedOutBeforeOutput: false,
	};

	it("falls back when an idle-timeout-before-output preceded the error", () => {
		expect(
			shouldFallbackOnStreamError({
				...base,
				upstreamIdleTimedOutBeforeOutput: true,
			}),
		).toBe(true);
	});

	it("falls back when the model-timeout classifier flags the error", async () => {
		(await getIsModelTimeoutError()).mockReturnValue(true);
		expect(shouldFallbackOnStreamError(base)).toBe(true);
		(await getIsModelTimeoutError()).mockReturnValue(false);
	});

	it("falls back for an eligible error only when nothing visible streamed", () => {
		expect(
			shouldFallbackOnStreamError({
				...base,
				error: new Error("socket terminated"),
			}),
		).toBe(true);
		expect(
			shouldFallbackOnStreamError({
				...base,
				error: new Error("socket terminated"),
				hasVisibleStreamOutput: true,
			}),
		).toBe(false);
	});

	it("does not fall back once a visible answer exists", () => {
		expect(
			shouldFallbackOnStreamError({
				...base,
				upstreamIdleTimedOutBeforeOutput: true,
				hasVisibleAssistantAnswerOutput: true,
			}),
		).toBe(false);
	});

	it("does not fall back after a prior fallback or a stop", () => {
		expect(
			shouldFallbackOnStreamError({
				...base,
				upstreamIdleTimedOutBeforeOutput: true,
				attemptedNonStreamFallback: true,
			}),
		).toBe(false);
		expect(
			shouldFallbackOnStreamError({
				...base,
				upstreamIdleTimedOutBeforeOutput: true,
				wasStopRequested: true,
			}),
		).toBe(false);
	});
});

describe("shouldFallbackOnAbruptTermination", () => {
	const base = {
		error: new Error("socket terminated"),
		attemptedNonStreamFallback: false,
		wasStopRequested: false,
		hasVisibleAssistantAnswerOutput: false,
	};

	it("falls back when the base gate passes and the error is eligible", () => {
		expect(shouldFallbackOnAbruptTermination(base)).toBe(true);
	});

	it("does not fall back for ineligible errors", () => {
		expect(
			shouldFallbackOnAbruptTermination({ ...base, error: new Error("nope") }),
		).toBe(false);
	});

	it("does not fall back when a visible answer exists", () => {
		expect(
			shouldFallbackOnAbruptTermination({
				...base,
				hasVisibleAssistantAnswerOutput: true,
			}),
		).toBe(false);
	});
});
