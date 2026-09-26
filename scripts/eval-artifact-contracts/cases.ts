// The per-suite case registry. Each type slice appends its own suite's cases
// as it lands — `document` (Slice 1), `app` and `verification` (Slice 2,
// below), `canvas` (Slice 3), `slides` (Slice 4). See decisions.md ruling 44.
import { APP_EVAL_CASES } from "./suites/apps";
import { VERIFICATION_EVAL_CASES } from "./suites/verification";
import type { EvalCase } from "./types";

/**
 * Throws when a suite's own case list repeats an id. Each suite is expected
 * to construct an internally consistent list (ruling 44's "one entry in
 * cases.ts's EVAL_CASES" assumes the entry itself has no collisions) — a
 * suite that cannot tell two of its own cases apart cannot be trusted to
 * score or replay them independently. Returns the list unchanged so a suite
 * can wrap its export in this call without an extra local variable.
 */
export function assertUniqueCaseIds(
	suite: string,
	cases: EvalCase[],
): EvalCase[] {
	const seen = new Set<string>();
	for (const evalCase of cases) {
		if (seen.has(evalCase.id)) {
			throw new Error(`duplicate case id "${evalCase.id}" in suite "${suite}"`);
		}
		seen.add(evalCase.id);
	}
	return cases;
}

export const EVAL_CASES: Record<string, EvalCase[]> = {
	app: assertUniqueCaseIds("app", APP_EVAL_CASES),
	verification: assertUniqueCaseIds("verification", VERIFICATION_EVAL_CASES),
};
