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
