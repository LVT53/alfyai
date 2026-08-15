import {
	classifyErrorCause,
	isAbortErrorCause,
} from "$lib/server/services/error-cause";
import { isModelTimeoutError } from "$lib/server/services/normal-chat-failover";

/**
 * Non-stream fallback policy.
 *
 * The stream orchestrator used to re-derive "should we abandon the streaming
 * attempt and retry through the non-stream provider run?" at five different
 * sites, each with slightly different guards. This module owns that decision.
 *
 * The two shared building blocks live here exactly once:
 *  - {@link shouldFallbackToNonStreaming} classifies whether an *error* is the
 *    kind of transient/transport failure a non-stream retry could recover from.
 *  - {@link passesBaseGate} is the canonical guard
 *    `!attemptedNonStreamFallback && !wasStopRequested && !hasVisibleAssistantAnswerOutput`.
 *
 * Each call site is expressed as a named decision built on those two pieces,
 * carrying only the extra, site-specific signal it needs. Behaviour is
 * identical to the previous inline expressions.
 */

/**
 * Classifies whether an error is a transient stream transport failure that a
 * non-stream provider run could plausibly recover from. E1 — delegates to
 * the shared cause -> code seam (error-cause.ts) instead of re-deriving its
 * own "abort"/"timed out"/"connection" substring scan over `error.message`.
 */
export function shouldFallbackToNonStreaming(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}

	if (isModelTimeoutError(error) || isAbortErrorCause(error)) {
		return true;
	}

	// A bare "abort" in the message text (no structured AbortError name)
	// still counts here. Unlike failover.ts's retryable/non-retryable
	// classification — where a message-text "prompt"/"abort" match could
	// wrongly strand a turn as non-retryable — misclassifying here only
	// costs one extra non-stream retry attempt, so the low-risk text check
	// stays local to this decision instead of feeding the shared
	// non-retryable cause vocabulary.
	if (error.message.toLowerCase().includes("abort")) {
		return true;
	}

	const cause = classifyErrorCause(error);
	return cause === "timeout" || cause === "network";
}

/**
 * The canonical fallback gate shared by the upstream-error, outer-catch and
 * abrupt-termination sites: we only fall back when we have not already
 * attempted a fallback, the user has not requested a stop, and we do not yet
 * have a visible assistant answer worth keeping.
 */
export interface NonStreamFallbackBaseGate {
	attemptedNonStreamFallback: boolean;
	wasStopRequested: boolean;
	hasVisibleAssistantAnswerOutput: boolean;
}

function passesBaseGate(gate: NonStreamFallbackBaseGate): boolean {
	return (
		!gate.attemptedNonStreamFallback &&
		!gate.wasStopRequested &&
		!gate.hasVisibleAssistantAnswerOutput
	);
}

/**
 * Site 1 — the initial streaming provider connect failure (the model-run
 * request itself threw before any events were read). Here we have not yet
 * attempted any fallback, so the gate is expressed in terms of the broader
 * "emitted anything at all" signal rather than the narrower visible-answer one.
 */
export function shouldFallbackOnStreamConnectFailure(input: {
	error: unknown;
	wasStopRequested: boolean;
	hasEmittedStreamOutput: boolean;
}): boolean {
	return (
		!input.wasStopRequested &&
		!input.hasEmittedStreamOutput &&
		shouldFallbackToNonStreaming(input.error)
	);
}

/**
 * Site 2 — the upstream stream ended cleanly (finish/end/stream-closed) with a
 * completed non-file tool call but no visible final answer. There is no error
 * to classify here; the recovery is purely about re-running the turn.
 */
export function shouldFallbackAfterUpstreamEndWithCompletedTools(input: {
	attemptedNonStreamFallback: boolean;
	wasStopRequested: boolean;
}): boolean {
	return !input.attemptedNonStreamFallback && !input.wasStopRequested;
}

/**
 * Site 3 — an inline upstream `error` event. Recover only when the error is
 * fallback-eligible and we either produced nothing visible yet or the only
 * visible output was a completed non-file tool call.
 */
export function shouldFallbackOnUpstreamErrorEvent(
	input: NonStreamFallbackBaseGate & {
		error: unknown;
		hasVisibleStreamOutput: boolean;
		hasCompletedNonFileToolCall: boolean;
	},
): boolean {
	return (
		passesBaseGate(input) &&
		shouldFallbackToNonStreaming(input.error) &&
		(!input.hasVisibleStreamOutput || input.hasCompletedNonFileToolCall)
	);
}

/**
 * Site 4 — the upstream idle timeout fired. The idle state machine only needs
 * to know whether a visible answer already exists; if not, it attempts a
 * fallback (and marks {@link upstreamIdleTimedOutBeforeOutput}).
 */
export function shouldFallbackOnIdleTimeout(input: {
	hasVisibleAssistantAnswerOutput: boolean;
}): boolean {
	return !input.hasVisibleAssistantAnswerOutput;
}

/**
 * Site 5a — the outer catch handling a thrown stream error. Broader than the
 * base gate: an idle-timeout-before-output or a model timeout error qualifies
 * outright, otherwise the error must be fallback-eligible *and* nothing visible
 * has streamed.
 */
export function shouldFallbackOnStreamError(
	input: NonStreamFallbackBaseGate & {
		error: unknown;
		hasVisibleStreamOutput: boolean;
		upstreamIdleTimedOutBeforeOutput: boolean;
	},
): boolean {
	return (
		!input.attemptedNonStreamFallback &&
		!input.wasStopRequested &&
		(input.upstreamIdleTimedOutBeforeOutput ||
			isModelTimeoutError(input.error) ||
			(shouldFallbackToNonStreaming(input.error) &&
				!input.hasVisibleStreamOutput)) &&
		!input.hasVisibleAssistantAnswerOutput
	);
}

/**
 * Site 5b — the outer catch, abrupt-upstream-termination branch, after buffered
 * output could not be salvaged. The canonical base gate plus a fallback-eligible
 * error.
 */
export function shouldFallbackOnAbruptTermination(
	input: NonStreamFallbackBaseGate & {
		error: unknown;
	},
): boolean {
	return passesBaseGate(input) && shouldFallbackToNonStreaming(input.error);
}
