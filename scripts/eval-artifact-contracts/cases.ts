// The per-suite case registry. Each type slice appends its own suite's
// cases as it lands — `document` (Slice 1), `app` and `verification`
// (Slice 2), `canvas` (Slice 3), `slides` (Slice 4). See decisions.md
// ruling 44.
import { DOCUMENT_EVAL_CASES } from "./suites/document";
import type { EvalCase } from "./types";

/**
 * A silent id collision would quietly shrink a suite's real gate (two cases
 * sharing an id means only the LAST one's fixture/response is ever
 * exercised, with no signal that the first one stopped running) — this
 * throws at load time instead, so a duplicate is a build-time failure, not a
 * silently-smaller suite (slice-1.md Task T13, Step 1.2).
 */
export function assertNoDuplicateCaseIds(
	suite: string,
	cases: EvalCase[],
): void {
	const seen = new Set<string>();
	for (const evalCase of cases) {
		if (seen.has(evalCase.id)) {
			throw new Error(
				`Duplicate eval case id "${evalCase.id}" in suite "${suite}" — a silent overwrite would quietly shrink the gate.`,
			);
		}
		seen.add(evalCase.id);
	}
}

assertNoDuplicateCaseIds("document", DOCUMENT_EVAL_CASES);

export const EVAL_CASES: Record<string, EvalCase[]> = {
	document: DOCUMENT_EVAL_CASES,
};
