// The pure scoring module (unit-tested in CI, no model, no browser). This
// slice ships a generic, honest placeholder: no suite is registered yet
// (cases.ts is empty), so there is no per-suite scoring rule to apply. Each
// type slice adds its own suite-specific scorer here as `cases.ts` grows —
// see decisions.md ruling 44. Until then this only catches the one universal
// failure every suite shares: an empty or whitespace-only answer.
import type { EvalAttempt, EvalCase, EvalScoreResult } from "./types";

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
