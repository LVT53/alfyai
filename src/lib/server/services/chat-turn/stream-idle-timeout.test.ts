import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUpstreamIdleTimeout } from "./stream-idle-timeout";

function createHarness(
	overrides: { hasVisibleAssistantAnswerOutput?: () => boolean } = {},
) {
	const onIdleTimeout = vi.fn();
	const unref = vi.fn();
	const fsm = createUpstreamIdleTimeout({
		idleTimeoutMs: 1000,
		log: { conversationId: "c1", streamId: "s1", modelId: "m1" },
		snapshot: () => ({
			responseLength: 3,
			thinkingLength: 5,
			toolCallCount: 1,
		}),
		hasVisibleAssistantAnswerOutput:
			overrides.hasVisibleAssistantAnswerOutput ?? (() => false),
		onIdleTimeout,
		unref,
	});
	return { fsm, onIdleTimeout, unref };
}

describe("createUpstreamIdleTimeout", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.spyOn(console, "warn").mockImplementation(() => undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("fires the idle callback with willAttemptFallback=true when no visible answer", () => {
		const { fsm, onIdleTimeout } = createHarness({
			hasVisibleAssistantAnswerOutput: () => false,
		});
		fsm.schedule(1);
		expect(onIdleTimeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1000);
		expect(onIdleTimeout).toHaveBeenCalledWith(1, {
			willAttemptFallback: true,
		});
		expect(fsm.timedOutBeforeOutput).toBe(true);
	});

	it("fires with willAttemptFallback=false and leaves the flag unset when a visible answer exists", () => {
		const { fsm, onIdleTimeout } = createHarness({
			hasVisibleAssistantAnswerOutput: () => true,
		});
		fsm.schedule(2);
		vi.advanceTimersByTime(1000);
		expect(onIdleTimeout).toHaveBeenCalledWith(2, {
			willAttemptFallback: false,
		});
		expect(fsm.timedOutBeforeOutput).toBe(false);
	});

	it("unrefs the scheduled timer", () => {
		const { fsm, unref } = createHarness();
		fsm.schedule(1);
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("does not fire after clear()", () => {
		const { fsm, onIdleTimeout } = createHarness();
		fsm.schedule(1);
		fsm.clear();
		vi.advanceTimersByTime(5000);
		expect(onIdleTimeout).not.toHaveBeenCalled();
	});

	it("reschedules (debounces) on markActivity so only the latest window fires", () => {
		const { fsm, onIdleTimeout } = createHarness();
		fsm.schedule(1);
		vi.advanceTimersByTime(600);
		fsm.markActivity(1);
		vi.advanceTimersByTime(600); // 1200 total, but only 600 since last activity
		expect(onIdleTimeout).not.toHaveBeenCalled();
		vi.advanceTimersByTime(400); // now 1000 since markActivity
		expect(onIdleTimeout).toHaveBeenCalledTimes(1);
	});

	it("advances lastActivityAt on markActivity", () => {
		const { fsm } = createHarness();
		const before = fsm.lastActivityAt;
		vi.advanceTimersByTime(500);
		fsm.markActivity(1);
		expect(fsm.lastActivityAt).toBeGreaterThan(before);
		fsm.clear();
	});
});
