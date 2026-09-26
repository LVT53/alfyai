// The per-suite EVALUATE dispatch seam (decisions.md ruling 56), a sibling
// of scoring.ts's SUITE_SCORERS but deliberately its own file: scoring.ts is
// pure/synchronous/browser-free (scoring.test.ts proves that with no model
// and no browser), and importing a Playwright-driven evaluator into it would
// taint every consumer of scoring.ts with a Playwright dependency, including
// plain unit tests that never want one.
//
// Each type slice that needs a live post-attempt step (today, only `app` —
// slice-2.md A9 Step 3's headless-Chromium pass) registers ONE entry here,
// keyed by its suite name, exactly like SUITE_SCORERS. `getSuiteEvaluator`
// is what `run.ts` calls; it returns `undefined` for a suite with none
// registered, which `run.ts` treats as "resolves null" (see its own
// `deps.evaluate` wiring) — the harness core never has to know which suites
// have an evaluate step.
import { evaluateAppEval } from "./suites/apps";
import type { SuiteEvaluator } from "./types";

export const SUITE_EVALUATORS: Partial<Record<string, SuiteEvaluator>> = {
	app: evaluateAppEval,
};

export function getSuiteEvaluator(suite: string): SuiteEvaluator | undefined {
	return SUITE_EVALUATORS[suite];
}
