import { shouldFallbackOnIdleTimeout } from "$lib/server/services/chat-turn/stream-fallback-policy";

/**
 * Upstream idle-timeout state machine.
 *
 * Owns the "no upstream activity for too long" timer plus the two pieces of
 * state that used to be loose `let`s in the orchestrator closure:
 *  - the pending timer handle, and
 *  - `timedOutBeforeOutput` — whether the idle timeout fired before any visible
 *    assistant answer existed (later read by the outer catch to force a
 *    non-stream fallback).
 *
 * When the timer fires it logs, decides via {@link shouldFallbackOnIdleTimeout}
 * whether a fallback should be attempted (i.e. no visible answer yet), records
 * that decision as `timedOutBeforeOutput`, and hands control back to the driver
 * through {@link UpstreamIdleTimeoutDeps.onIdleTimeout} so the driver can run its
 * fallback-or-fail collaborators. Timing and idle-state ownership live here;
 * the terminal action stays with the driver.
 */
export interface UpstreamIdleTimeoutSnapshot {
	responseLength: number;
	thinkingLength: number;
	toolCallCount: number;
}

export interface UpstreamIdleTimeoutDeps {
	idleTimeoutMs: number;
	log: {
		conversationId: string;
		streamId: string | undefined;
		modelId: string | undefined;
	};
	snapshot: () => UpstreamIdleTimeoutSnapshot;
	hasVisibleAssistantAnswerOutput: () => boolean;
	/**
	 * Runs the driver's fallback-or-fail branch. `willAttemptFallback` mirrors
	 * `timedOutBeforeOutput`: true when the timeout fired with no visible answer.
	 */
	onIdleTimeout: (
		attempt: number,
		context: { willAttemptFallback: boolean },
	) => void;
	unref?: (timer: ReturnType<typeof setTimeout>) => void;
}

export interface UpstreamIdleTimeout {
	schedule(attempt: number): void;
	markActivity(attempt: number): void;
	clear(): void;
	readonly timedOutBeforeOutput: boolean;
	readonly lastActivityAt: number;
}

export function createUpstreamIdleTimeout(
	deps: UpstreamIdleTimeoutDeps,
): UpstreamIdleTimeout {
	let timeoutId: ReturnType<typeof setTimeout> | null = null;
	let lastActivityAt = Date.now();
	let timedOutBeforeOutput = false;

	const clear = () => {
		if (!timeoutId) return;
		clearTimeout(timeoutId);
		timeoutId = null;
	};

	const schedule = (attempt: number) => {
		clear();
		timeoutId = setTimeout(() => {
			const now = Date.now();
			console.warn("[STREAM] Upstream stream idle timeout", {
				conversationId: deps.log.conversationId,
				streamId: deps.log.streamId,
				modelId: deps.log.modelId,
				attempt,
				idleTimeoutMs: deps.idleTimeoutMs,
				elapsedSinceLastUpstreamMs: now - lastActivityAt,
				...deps.snapshot(),
			});
			const willAttemptFallback = shouldFallbackOnIdleTimeout({
				hasVisibleAssistantAnswerOutput: deps.hasVisibleAssistantAnswerOutput(),
			});
			if (willAttemptFallback) {
				timedOutBeforeOutput = true;
			}
			deps.onIdleTimeout(attempt, { willAttemptFallback });
		}, deps.idleTimeoutMs);
		deps.unref?.(timeoutId);
	};

	const markActivity = (attempt: number) => {
		lastActivityAt = Date.now();
		schedule(attempt);
	};

	return {
		schedule,
		markActivity,
		clear,
		get timedOutBeforeOutput() {
			return timedOutBeforeOutput;
		},
		get lastActivityAt() {
			return lastActivityAt;
		},
	};
}
