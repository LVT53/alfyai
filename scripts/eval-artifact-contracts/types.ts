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
	 * The language this case's fixture declares, when the suite is
	 * language-sensitive (ruling 55 — today, `app`). Generation is asked to
	 * answer in this language (mirroring how production passes the turn's
	 * own resolved language, never a per-message guess), and a suite's
	 * scorer may check the response actually came back in it.
	 */
	language?: "en" | "hu";
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

/** The provider's own completion usage, mirrored from `client.ts`'s
 * `EvalArtifactsUsage` rather than imported from it — `types.ts` has no
 * runtime dependency on `client.ts` (only `run.ts` and `client.ts` itself do)
 * and this shape is small enough that duplicating it is cheaper than adding
 * one. */
export interface EvalUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
}

/** One case's actual model output, ready for scoring. */
export interface EvalAttempt {
	caseId: string;
	suite: string;
	response: string;
	durationMs?: number;
	/** Absent when the endpoint's response carried no `usage` block. */
	usage?: EvalUsage;
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
	usage?: EvalUsage;
}

/** A committed evaluate-step result for `--replay` (ruling 56), one file per
 * case under `fixtures/<suite>/evaluations/<caseId>.json`. Committed
 * alongside the response so a replay run re-scores both with no model call
 * and no browser. Absent for a suite/case with no evaluate step. */
export interface EvalCommittedEvaluation {
	evaluation: unknown;
}

/** One suite's pure scorer: `(case, attempt) -> verdict + reasons`, with no
 * model and no browser (decisions.md ruling 25). The optional third
 * parameter is a suite's own `evaluate` step's result (ruling 56), when one
 * ran — the scorer only ever READS it synchronously; it never runs the
 * evaluate step itself. Suites with no evaluate step (document, canvas,
 * slides, verification today) simply never receive one. */
export type SuiteScorer = (
	evalCase: EvalCase,
	attempt: EvalAttempt,
	evaluation?: unknown,
) => EvalScoreResult;

/**
 * One suite's optional ASYNC per-case step (ruling 56 — today, `app`'s
 * headless-Chromium pass): runs AFTER the model attempt exists, and its
 * result is recorded next to the response and handed to the (still
 * synchronous) scorer above. Suite-shaped on purpose — the harness core
 * never inspects what a suite's evaluation record contains, only that one
 * exists or not.
 */
export type SuiteEvaluator = (
	evalCase: EvalCase,
	attempt: EvalAttempt,
) => Promise<unknown | null>;

/** One case's outcome inside a run report — the score, or a call that never
 * produced an attempt to score (no committed response in replay, no client
 * configured, or a call that failed after its one retry). */
export interface EvalCaseOutcome {
	caseId: string;
	verdict: EvalVerdict;
	reasons: string[];
	/** The suite's evaluate step's result, when one ran (ruling 56) — recorded
	 * next to the response, not folded into `reasons`. */
	evaluation?: unknown;
	/** The generation call's own usage, when the endpoint reported one —
	 * recorded per case so a run's `results.json` can be compared against P1's
	 * measured 2,486–3,607 completion tokens per app. */
	usage?: EvalUsage;
	/** Wall-clock time for the winning attempt's call (ms) — the harness
	 * already measures this per attempt (`attemptCase`/`recordSuiteResponses`)
	 * but dropped it before it reached the report; recorded here so a run can
	 * be compared against P1's measured 12.7–23.0s per app. */
	durationMs?: number;
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
