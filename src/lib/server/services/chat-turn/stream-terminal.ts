import type { StreamErrorCode } from "$lib/services/stream-protocol";
import type { NormalChatCompletion } from "$lib/shared/normal-chat-completion";
import type { ChatTurnRequestError } from "./types";
export type UpstreamEndReason = "done_signal" | "end_event" | "stream_closed";
export type StreamPhaseOutcome = "success" | "error" | "stopped";
export type CompleteSuccessOptions = {
	streamClosedWithoutFinish?: boolean;
	paused?: boolean;
	noFinalAnswer?: boolean;
};
export interface StreamTerminalDeps {
	isEnded(): boolean;
	markEnded(): void;
	logPhaseTiming(outcome: StreamPhaseOutcome): void;
	streamId: string | null | undefined;
	clearStreamBuffer(streamId: string): void;
	closeDownstream(): void;
	emitError(code: StreamErrorCode): void;
	emitRequestError(error: ChatTurnRequestError): void;
	runCompleteStreamTurn(args: {
		wasStopped: boolean;
		streamClosedWithoutFinish: boolean;
		paused: boolean;
		noFinalAnswer: boolean;
	}): Promise<void>;
	flushBufferedStreamOutput(): boolean;
	wasStopRequested(): boolean;
	getCompletion(): NormalChatCompletion | undefined;
}
export function createStreamTerminal(deps: StreamTerminalDeps) {
	const completeSuccess = async (
		wasStopped = false,
		options: CompleteSuccessOptions = {},
	) => {
		if (deps.isEnded()) return;
		deps.markEnded();
		deps.logPhaseTiming(
			options.streamClosedWithoutFinish || options.noFinalAnswer
				? "error"
				: wasStopped
					? "stopped"
					: "success",
		);
		await deps.runCompleteStreamTurn({
			wasStopped,
			streamClosedWithoutFinish: options.streamClosedWithoutFinish === true,
			paused: options.paused === true,
			noFinalAnswer: options.noFinalAnswer === true,
		});
	};
	const fail = (emit: () => void) => {
		if (deps.isEnded()) return;
		deps.markEnded();
		deps.logPhaseTiming("error");
		// Emit terminal truth before releasing the journal holding reconnect listeners.
		emit();
		if (deps.streamId) deps.clearStreamBuffer(deps.streamId);
		deps.closeDownstream();
	};
	return {
		completeSuccess,
		failStream: (code: StreamErrorCode) => fail(() => deps.emitError(code)),
		failPreparedTurnStream: (error: ChatTurnRequestError) =>
			fail(() => deps.emitRequestError(error)),
		async completeAfterUpstreamEnd(reason: UpstreamEndReason) {
			if (!deps.flushBufferedStreamOutput()) return;
			const completion = deps.getCompletion();
			if (deps.wasStopRequested() || completion?.outcome === "stopped") {
				await completeSuccess(true);
				return;
			}
			if (!completion) {
				fail(() => deps.emitError("backend_failure"));
				return;
			}
			await completeSuccess(false, {
				paused: completion.outcome === "paused",
				noFinalAnswer:
					completion.outcome === "failed" ||
					completion.outcome === "incomplete",
				streamClosedWithoutFinish: reason === "stream_closed",
			});
		},
	};
}
export type StreamTerminal = ReturnType<typeof createStreamTerminal>;
