// The per-suite case registry. Empty here on purpose (Slice 0 ships the
// skeleton only): each type slice appends its own suite's cases as it lands
// — `document` (Slice 1), `app` and `verification` (Slice 2), `canvas`
// (Slice 3), `slides` (Slice 4). See decisions.md ruling 44.
import type { EvalCase } from "./types";

export const EVAL_CASES: Record<string, EvalCase[]> = {};
