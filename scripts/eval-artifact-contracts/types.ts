// Shared types for the artifact-contract eval harness (Feature 2 · Artifacts).
// This slice ships the skeleton only: the shapes below are what every type
// slice's suite/scorer/case will use, but no suite is registered yet (see
// cases.ts) and no live orchestration exists yet (ruling 44 — config.ts and
// client.ts are Slice 5a's).

/** One scripted prompt/scenario a suite runs. `knownBad` cases must score "bad" before a suite's real scores count (ruling 25). */
export interface EvalCase {
	id: string;
	suite: string;
	description: string;
	prompt: string;
	/** A fixture the suite expects to FAIL, proving the harness can see a failure. */
	knownBad?: boolean;
	/**
	 * Qwen defaults to thinking ON; App generation is thinking-off by policy
	 * (spec §2.9) and a suite may need the same. Defaults to the harness's
	 * configured `EVAL_ARTIFACTS_THINKING` (client.ts sends
	 * `chat_template_kwargs: { enable_thinking: false }` for "off") when a
	 * case does not say — most suites want one fixed policy for every case,
	 * so this is an escape hatch, not something every suite must set.
	 */
	thinking?: "on" | "off";
}

/** One case's actual model output, ready for scoring. */
export interface EvalAttempt {
	caseId: string;
	suite: string;
	response: string;
	durationMs?: number;
}

export type EvalVerdict = "good" | "acceptable" | "bad";

export interface EvalScoreResult {
	verdict: EvalVerdict;
	reasons: string[];
}

// The pieces run.ts's runner needs beyond the skeleton above. Still shipped
// with no real suite (Slice 5a, ruling 44): a type slice's own `suites/*.ts`
// registers a `SuiteScorer` in `scoring.ts`'s dispatch table, never here.

/** A committed model response for `--replay`, one file per case under
 * `fixtures/<suite>/responses/<caseId>.json`. */
export interface EvalCommittedResponse {
	response: string;
	durationMs?: number;
}

/** One suite's pure scorer: `(case, attempt) -> verdict + reasons`, with no
 * model and no browser (decisions.md ruling 25). */
export type SuiteScorer = (
	evalCase: EvalCase,
	attempt: EvalAttempt,
) => EvalScoreResult;

/** One case's outcome inside a run report — the score, or a call that never
 * produced an attempt to score (no committed response in replay, no client
 * configured, or a call that failed after its one retry). */
export interface EvalCaseOutcome {
	caseId: string;
	verdict: EvalVerdict;
	reasons: string[];
}

export interface EvalSuiteReport {
	suite: string;
	/** False when a declared known-bad fixture did NOT score "bad" — the
	 * runner refuses to trust `results` in that case (it is empty). */
	knownBadFailedAsExpected: boolean;
	/** Ids of known-bad cases that did not fail as declared. Empty when the
	 * gate passed (or the suite declared none). */
	knownBadFailures: string[];
	results: EvalCaseOutcome[];
	/** True when the run stopped before every case ran — the two-consecutive-
	 * 429/5xx circuit breaker tripped. */
	stoppedEarly: boolean;
}
