# Wave 4 (the sampling fix, the tours, S5b, the final) — rules for every agent

**Read `docs/plans/claude-at-home-2/wave-3/common.md` first. It still applies in full, with the changes below.**

## What changed since Wave 3

- **Scope.** This phase is: the sampling fix on internal model calls (branched from `dev`, not Feature 2), the tours
  (Slice 6's remainder: three tours, Document, App and Canvas, ruling 69), then Slice 5b (evidence rows, the project
  bundle, the doc fixes, the all-suite live eval) and the final review. **Slides is shelved** (ruling 69): nothing you
  write may advertise, list, seed or render Slides; never touch `feat/artifacts-slides`.
- **Migrations.** The only new table of this phase is the tours' `artifact_tour_states` (`1777140000112`, already on
  `feat/artifacts-tours`). If you believe you need another column or table, stop and report.
- **Baseline gates** (on `dev` = `27274c0e`, release gates of 2026-10-01): check 0 errors / 17 warnings; 15,977 unit
  tests; build 32 `Unused CSS selector` + 2 `must have an ARIA role`; chunk gate OK (editor first paint ceiling 71,680 B,
  ~71,267 used; chat route within 2,048 B of its baseline); Fallow 124 issues / 4 circular; Playwright (chat,
  conversation, every artifact suite, knowledge) 443 passed + 23 skipped. Known pre-existing failure outside the gate
  set: `tests/e2e/settings-admin.spec.ts:411` (two `confirm-delete` buttons during a fade-out).
- **Real input, red first (the owner's walk found five gaps every gate had passed).** Every UI flow you build or fix is
  reproduced in Playwright with real pointer and keyboard input (`page.mouse`, `locator.click()`, `page.keyboard`,
  touch where the brief says phone) — never by calling component callbacks, dispatching synthetic events or setting
  state through `page.evaluate`. Write the test, see it fail on the unfixed tree, then fix.
- **Commit trailer:** `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (unchanged), and say your model ID in
  your final reply.
- **Reports** go where your brief says (the orchestrator's scratchpad), screenshots beside them; never under
  `docs/plans/**` and never as files Fallow would see.

## Context economy (the owner's weekly token budget is the binding constraint)

Read by range (`grep -n`, `sed -n`), never whole large files or whole specs; pipe long output through `tail -40`; run
targeted tests while iterating and the full gates once at the end; do not re-read a file you just edited; commit after
each working step so an interruption loses little. Your brief is sized for two or three steps: do those, report, stop.
