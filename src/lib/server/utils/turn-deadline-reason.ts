/**
 * The reason on the completion engine's own timer when the time for the model's
 * work runs out (`normal-chat-model/completion.ts`: the working deadline, which
 * is the turn's total less its reserve for the closing, and the final one). The
 * engine aborts the attempt's signal with it, so a tool that is running at that
 * instant can tell the engine's clock from the person's Stop (`UserStopReason`),
 * the stream watchdog, a storage failure and the first-output timer, which all
 * abort with other reasons.
 *
 * The tool envelope reads it (`executeToolWithEnvelope`, `abortedByTurnDeadline`):
 * a tool that only reads and is cut off by this clock has failed, a settled
 * outcome the model reads and answers from, where any other abort leaves the call
 * uncertain.
 *
 * Its name and message are bare on purpose. Model Run's failover classifier
 * (`normal-chat-model/failover.ts`) reads an error's name and message, and an
 * error that said "timed out" would hand the turn to a fallback provider, which
 * may be a cloud one: the engine's own deadline is not a provider failing.
 * (`normal-chat-failover.test.ts` holds that.) Pure: no I/O, no state.
 */
export class TurnDeadlineReason extends Error {
	constructor() {
		super("deadline");
		this.name = "TurnDeadlineReason";
	}
}

/** True when `signal` was aborted by the engine's own deadline timer and by nothing before it. */
export function abortedByTurnDeadline(
	signal: AbortSignal | undefined,
): boolean {
	return (
		signal?.aborted === true && signal.reason instanceof TurnDeadlineReason
	);
}
