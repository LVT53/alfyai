import { shouldFallbackAfterUpstreamEndWithCompletedTools } from "$lib/server/services/chat-turn/stream-fallback-policy";
import type { ChatTurnRequestError } from "$lib/server/services/chat-turn/types";
import type { StreamErrorCode } from "$lib/services/stream-protocol";

/**
 * Terminal completion.
 *
 * Owns the three ways a chat stream can end plus the "upstream ended, now what?"
 * decision tree that used to be four sibling closures in the orchestrator:
 *  - {@link StreamTerminal.completeSuccess} — happy-path / stopped / paused (the reply asked
 *    the person and stops there) / closed-without-finish
 *    finalization (delegates the actual finalize payload to the driver via
 *    {@link StreamTerminalDeps.runCompleteStreamTurn}, so the `completeStreamTurn`
 *    boundary is not widened here — that is C5's concern).
 *  - {@link StreamTerminal.failStream} — emit an error frame and close.
 *  - {@link StreamTerminal.failPreparedTurnStream} — emit a structured request-error frame and close.
 *  - {@link StreamTerminal.completeOrRecoverAfterUpstreamEnd} — the branch that,
 *    after the upstream stream ends, decides between success, a non-stream
 *    fallback recovery, or a hard failure.
 *
 * The `ended` latch stays a driver-owned lifecycle flag (it is read from several
 * non-terminal sites — response-activity emission, the read loop, the outer
 * catch and the idle timer), so it is injected here through
 * {@link StreamTerminalDeps.isEnded} / {@link StreamTerminalDeps.markEnded}
 * rather than owned by this module.
 */
export type UpstreamEndReason = "done_signal" | "end_event" | "stream_closed";
export type StreamPhaseOutcome = "success" | "error" | "stopped";

type FallbackRunner = (
	reason: "stream_connect_failure" | "stream_read_failure",
	attempt: number,
	error: unknown,
) => Promise<null>;

export interface StreamTerminalDeps {
	isEnded: () => boolean;
	markEnded: () => void;
	logPhaseTiming: (outcome: StreamPhaseOutcome) => void;
	streamId: string | null | undefined;
	clearStreamBuffer: (streamId: string) => void;
	closeDownstream: () => void;
	emitError: (code: StreamErrorCode) => void;
	emitRequestError: (error: ChatTurnRequestError) => void;
	/**
	 * Builds and awaits the `completeStreamTurn` finalize call from driver state.
	 * Kept driver-side so the finalize boundary is untouched by this slice.
	 */
	runCompleteStreamTurn: (args: {
		wasStopped: boolean;
		streamClosedWithoutFinish: boolean;
		/** The reply asked the person and stops there: it is saved as a paused segment. */
		paused: boolean;
	}) => Promise<void>;
	// completeOrRecoverAfterUpstreamEnd collaborators
	flushNativeToolCalls: () => void;
	flushBufferedStreamOutput: () => boolean;
	wasStopRequested: () => boolean;
	/**
	 * The model run asked the person (`ask_user`) and its own stop condition ended
	 * it: the reply is paused for the answer, not finished and not failed.
	 */
	isPaused: () => boolean;
	hasVisibleAssistantAnswerOutput: () => boolean;
	hasCompletedFileProductionToolCall: () => boolean;
	hasCompletedNonFileToolCall: () => boolean;
	getAttemptedNonStreamFallback: () => boolean;
	getFallbackRunner: () => FallbackRunner | null;
	getLatestUpstreamAttempt: () => number;
	upstreamEndLog: {
		conversationId: string;
		streamId: string | undefined;
		modelId: string | undefined;
	};
	getUpstreamEndSnapshot: () => {
		thinkingLength: number;
		toolCallCount: number;
		completedToolCallCount: number;
		hasCompletedNonFileToolCall: boolean;
	};
}

export interface StreamTerminal {
	completeSuccess: (
		wasStopped?: boolean,
		options?: { streamClosedWithoutFinish?: boolean; paused?: boolean },
	) => Promise<void>;
	failStream: (code: StreamErrorCode) => void;
	failPreparedTurnStream: (error: ChatTurnRequestError) => void;
	completeOrRecoverAfterUpstreamEnd: (
		reason: UpstreamEndReason,
	) => Promise<void>;
}

export function createStreamTerminal(deps: StreamTerminalDeps): StreamTerminal {
	const completeSuccess = async (
		wasStopped = false,
		options: { streamClosedWithoutFinish?: boolean; paused?: boolean } = {},
	) => {
		if (deps.isEnded()) return;
		deps.markEnded();
		deps.logPhaseTiming(
			options.streamClosedWithoutFinish
				? "error"
				: wasStopped
					? "stopped"
					: "success",
		);
		await deps.runCompleteStreamTurn({
			wasStopped,
			streamClosedWithoutFinish: options.streamClosedWithoutFinish === true,
			paused: options.paused === true,
		});
	};

	const failStream = (code: StreamErrorCode) => {
		if (deps.isEnded()) return;
		deps.markEnded();
		deps.logPhaseTiming("error");
		// The error goes out BEFORE the buffer is cleared: the buffer holds the
		// listeners of a browser that reconnected to this run (a reload a few
		// hundred milliseconds after a first turn that fails at once), and clearing
		// it first left that connection open on heartbeats with no terminal event,
		// the reader's turn spinning for ever.
		deps.emitError(code);
		if (deps.streamId) {
			deps.clearStreamBuffer(deps.streamId);
		}
		deps.closeDownstream();
	};

	const failPreparedTurnStream = (error: ChatTurnRequestError) => {
		if (deps.isEnded()) return;
		deps.markEnded();
		deps.logPhaseTiming("error");
		deps.emitRequestError(error);
		if (deps.streamId) {
			deps.clearStreamBuffer(deps.streamId);
		}
		deps.closeDownstream();
	};

	const completeOrRecoverAfterUpstreamEnd = async (
		reason: UpstreamEndReason,
	) => {
		deps.flushNativeToolCalls();
		if (!deps.flushBufferedStreamOutput()) {
			return;
		}
		if (deps.wasStopRequested()) {
			await completeSuccess(true);
			return;
		}
		// A reply that asked the person stops where it asks, on purpose, and is
		// saved as it is. This is decided here, after the stop (a stop asked first
		// wins) and before the checks below: a run that asked before saying a word
		// has no visible answer but a completed tool call, which the branch below
		// reads as a run that died after its tools and answers with a second,
		// whole generation that would ask again or answer for the person.
		if (deps.isPaused()) {
			await completeSuccess(false, {
				streamClosedWithoutFinish: reason === "stream_closed",
				paused: true,
			});
			return;
		}
		if (
			deps.hasVisibleAssistantAnswerOutput() ||
			deps.hasCompletedFileProductionToolCall()
		) {
			await completeSuccess(false, {
				streamClosedWithoutFinish: reason === "stream_closed",
			});
			return;
		}
		if (deps.hasCompletedNonFileToolCall()) {
			const fallbackRunner = deps.getFallbackRunner();
			if (
				shouldFallbackAfterUpstreamEndWithCompletedTools({
					attemptedNonStreamFallback: deps.getAttemptedNonStreamFallback(),
					wasStopRequested: deps.wasStopRequested(),
				}) &&
				fallbackRunner
			) {
				const snapshot = deps.getUpstreamEndSnapshot();
				console.warn(
					"[STREAM] Upstream stream ended before final assistant answer",
					{
						conversationId: deps.upstreamEndLog.conversationId,
						streamId: deps.upstreamEndLog.streamId,
						modelId: deps.upstreamEndLog.modelId,
						reason,
						thinkingLength: snapshot.thinkingLength,
						toolCallCount: snapshot.toolCallCount,
						completedToolCallCount: snapshot.completedToolCallCount,
						hasCompletedNonFileToolCall: snapshot.hasCompletedNonFileToolCall,
					},
				);
				await fallbackRunner(
					"stream_read_failure",
					deps.getLatestUpstreamAttempt(),
					new Error("Upstream stream ended before final assistant answer"),
				);
				return;
			}
		}
		failStream("backend_failure");
	};

	return {
		completeSuccess,
		failStream,
		failPreparedTurnStream,
		completeOrRecoverAfterUpstreamEnd,
	};
}
