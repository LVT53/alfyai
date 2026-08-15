// P1 (ADR-0056) — the deterministic reasoning-phase spine's *live* sub-state.
//
// The full spine (depth resolved -> context prepared -> reasoning started ->
// live -> writing the answer -> done) is assembled across two existing
// surfaces: the pre-thinking "preparing"/"drafting" status already driven by
// `data-response-activity` in MessageBubble.svelte, and — once reasoning
// text has actually started arriving — the ThinkingBlock header. This module
// is the pure decision for that second, "live" part: given only real turn
// lifecycle signals (has the visible answer started; has reasoning growth
// genuinely stalled), which state is the header in right now?
//
// No model call, no timer-driven display value, and nothing here decides
// *when* those inputs flip — ThinkingBlock.svelte derives `deltaStalled` from
// real reasoning-delta/content growth via a watchdog that resets on every
// real event (never a free-running clock). That keeps this function itself
// trivially unit-testable without any Svelte or streaming machinery, per the
// ADR-0056 requirement that the spine be asserted without a model call.
export type ReasoningSpineLiveState =
	| "reasoning_active"
	| "reasoning_stalled"
	| "writing_answer";

export interface ReasoningSpineLiveInput {
	/** True once the assistant's visible answer text has started streaming. */
	answerStarted: boolean;
	/**
	 * True when no new reasoning growth (and no currently-running tool call)
	 * has been observed for the stall window. Ignored once `answerStarted` is
	 * true — visible answer text is itself proof of progress.
	 */
	deltaStalled: boolean;
}

/**
 * Resolves the current live reasoning-phase state. Always returns a truthy
 * state — there is no "empty" value, which is what makes the reasoning rail
 * never an empty surface: even with zero deliberation passes and zero tool
 * calls (the `standard`-depth, no-tools case this exists for), the result is
 * always one of the three states above.
 */
export function deriveReasoningSpineState(
	input: ReasoningSpineLiveInput,
): ReasoningSpineLiveState {
	if (input.answerStarted) return "writing_answer";
	if (input.deltaStalled) return "reasoning_stalled";
	return "reasoning_active";
}
