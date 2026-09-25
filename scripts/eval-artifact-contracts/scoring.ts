// The pure scoring module (unit-tested in CI, no model, no browser).
// `scoreArtifactEvalAttempt` is the generic, honest placeholder Slice 0
// shipped: it catches the one universal failure every suite shares (an empty
// or whitespace-only answer) and otherwise says plainly that no
// suite-specific rule exists yet, rather than fabricating a verdict a real
// suite has not earned.
//
// `SUITE_SCORERS` below is the per-suite dispatch seam (decisions.md ruling
// 44): each type slice registers its OWN scorer here as it lands —
// `document` (Slice 1), `app`/`verification` (Slice 2), `canvas` (Slice 3),
// `slides` (Slice 4) — and `getSuiteScorer` is what `run.ts` calls, so the
// runner never has to know which suites exist. Empty in Slice 5a: every
// suite falls back to the generic scorer above until its own lands.
import type {
	EvalAttempt,
	EvalCase,
	EvalScoreResult,
	SuiteScorer,
} from "./types";

export function scoreArtifactEvalAttempt(
	evalCase: EvalCase,
	attempt: EvalAttempt,
): EvalScoreResult {
	if (attempt.response.trim().length === 0) {
		return {
			verdict: "bad",
			reasons: [`case ${evalCase.id}: the response was empty`],
		};
	}

	// No suite-specific scorer exists yet — say so rather than fabricating a
	// verdict a real suite has not earned.
	return {
		verdict: "acceptable",
		reasons: [
			`case ${evalCase.id}: no suite-specific scorer is registered for "${evalCase.suite}" yet`,
		],
	};
}

/**
 * The per-suite scorer registry. Empty here on purpose — each type slice
 * appends ONE entry, keyed by its suite name, and only here; `run.ts` never
 * imports a type slice's scorer directly.
 */
export const SUITE_SCORERS: Partial<Record<string, SuiteScorer>> = {};

/** What `run.ts` calls for every case: a suite's own scorer when one is
 * registered, else the generic placeholder above. Never throws for an
 * unregistered suite — that is exactly the "not measured yet" state the
 * placeholder is honest about. */
export function getSuiteScorer(suite: string): SuiteScorer {
	return SUITE_SCORERS[suite] ?? scoreArtifactEvalAttempt;
}
