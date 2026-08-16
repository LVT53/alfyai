// P4 (ADR-0056) — determinate progress enrichment for the reasoning rail's
// live header, layered on top of P1's spine exactly the way P3c's classified
// step label already is: a separate pure decision, never a modification to
// `deriveReasoningSpineState` itself (reasoning-spine.ts), so standard-depth
// behavior — an empty deliberation plan, `passTotal` never emitted — is
// provably unchanged by construction rather than by a runtime branch that
// could regress it later.
//
// The deliberation pass plan is the one place a Normal Chat Turn genuinely
// KNOWS how much work remains before it starts: `DELIBERATION_PASS_PLAN_BY_PROFILE`
// (deliberation-pass-catalogue.ts) fixes the pass count for `maximum` depth
// before the turn is even sent to a model, so "pass N of M" is a determinate
// fact read off already-computed `passIndex`/`passTotal` fields
// (ResponseActivityEntry, $lib/types) — never a new signal, never a guess.
//
// Once the LAST planned pass has resolved and the turn has moved past
// deliberation into the final answer-generating call —
// `RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER`, which
// streaming-normal-chat-model-run.ts only emits after `runDeliberationIfNeeded`
// has fully awaited every pass, silent or not — that same certainty flips
// into a determinate "concluding" state. This is deliberately NOT keyed off
// `passIndex === passTotal`: several `maximum`-depth pass kinds run silently
// (deliberation-runner.ts's `isLocalOnlyPass`) and never individually emit a
// status, so the last *visible* pass index the client ever sees is often
// well short of the plan's real total. `draftingAnswerReached` is the only
// signal that is true exactly once deliberation — including its silent
// passes — has actually finished.
export type DeliberationProgressState =
	| { kind: "none" }
	| { kind: "pass"; index: number; total: number }
	| { kind: "concluding" };

export interface DeliberationProgressInput {
	/**
	 * The latest live `passIndex` from a "deliberation" data-response-activity
	 * entry this turn, if any. `0` (the workspace-preparation pseudo-pass) and
	 * any non-positive value are treated as "no countable pass yet".
	 */
	passIndex?: number;
	/**
	 * The latest live `passTotal` from the same entry. Only plans with more
	 * than one pass carry any determinate signal here — `standard` depth's
	 * empty plan and `extended`'s single-pass plan both leave this unset or
	 * at 1, which resolves to `{ kind: "none" }` below.
	 */
	passTotal?: number;
	/**
	 * True once `RESPONSE_ACTIVITY_IDS.DRAFTING_ANSWER` has been observed this
	 * turn: every planned deliberation pass (if any) has resolved and the
	 * model is now generating the final visible answer.
	 */
	draftingAnswerReached: boolean;
	/**
	 * True once the assistant's visible answer text has started streaming.
	 * Takes precedence over everything here, mirroring
	 * `deriveReasoningSpineState`'s own `writing_answer` precedence — visible
	 * answer text is itself the most determinate signal available, and P1
	 * already owns presenting it.
	 */
	answerStarted: boolean;
}

/**
 * Resolves the current live deliberation-progress state for the reasoning
 * rail's header. Returns `{ kind: "none" }` whenever there is nothing
 * determinate to add — including, by construction, every `standard`-depth
 * turn (no deliberation plan, `passTotal` never emitted) — in which case the
 * caller falls back to P1's spine label / P3c's classified step label
 * exactly as before this slice.
 */
export function deriveDeliberationProgressState(
	input: DeliberationProgressInput,
): DeliberationProgressState {
	if (input.answerStarted) return { kind: "none" };

	const total = input.passTotal;
	if (typeof total !== "number" || !Number.isInteger(total) || total <= 1) {
		return { kind: "none" };
	}

	if (input.draftingAnswerReached) return { kind: "concluding" };

	const index = input.passIndex;
	if (typeof index !== "number" || !Number.isInteger(index) || index <= 0) {
		return { kind: "none" };
	}
	return { kind: "pass", index, total };
}
