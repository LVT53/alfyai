# Agent W4-V · Slice 5b T9: every artifact suite on the real model, recorded, with the README's numbers

Lesson from Wave 3: evals must measure what the user sees (the canvas eval scored 24/30 against sizes that were never
drawn; after the fix it measured the drawn board). This run is the measured record of every artifact contract before
the final review — Document, App, verification and Canvas. **Slides is shelved (ruling 69): its suite lives on
`feat/artifacts-slides` and is not run here.**

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-w4v`, branch
  `feat/artifacts-s5b-eval` (from `feat/artifacts` `8b5b2e7e`: the sampling fix, the tours, FU-1, FU-2, W4-B, W4-E and TR-D3 are in), label `w4v`, real-model
  tunnel local port **30402** (model `qwen3-6-27b`, now vLLM v0.31 + FP8 KV).
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/5c073247-a423-47a9-b825-91f05ce97740/scratchpad/w4/w4v-report.md`
  (raw runs beside it in `…/scratchpad/w4/w4v-runs/`).
- Read first: `docs/plans/claude-at-home-2/wave-4/common.md` (+ the Wave 3 rules it points to); rulings 25, 44, 54, 56,
  59, 62, 65 in `decisions.md`; `slice-5.md` 669–789 (the harness) and 1256–1294 (T9); the harness's own
  `scripts/eval-artifact-contracts/README.md` (it says how each suite runs live and what each one measured before).

## Steps

1. **Known-bad first, from disk (ruling 59).** For every suite, check that each known-bad case is a hand-written,
   committed answer served from disk and never sent to the model, and that the runner refuses to count a run in which a
   known-bad case passes. Where a suite still builds a known-bad case by asking the model to misbehave, replace it with a
   recorded answer and a test. Check too that the harness sends the same sampling as the app's real path (the sampling
   fix merged just before you: the shared helper it added) — if it does not, make it, with a test; a measurement taken
   at a different temperature than the product runs at is not a measurement of the product.
2. **The live run.** Every suite, sequential, one retry at most, stop after two consecutive 429/5xx, through the
   tunnel in the same command as the run. Use the real tool path where the suite has one (`run-tool-suite.ts`); if a
   suite still talks to the model outside the real tool catalogue (check the Document suite), say so, and run it through
   the tool path too if the harness already supports that, otherwise report rather than build it. `--repeat 3` where a
   rate matters (Canvas, Document). Record the answers (`--write-responses`) and re-score them with `--replay`.
3. **The record and the wiring.** The README's measured table (per suite: cases, good / acceptable / bad, known-bad
   refused, date, model, the failing fixtures named and why); commit the recorded responses. Confirm `npm test` never
   runs the live harness and CI (`.github/workflows/ci.yml`) runs only the replay form. **If a suite is below its bar,
   do not change the bar or tune the fixture to pass: stop and report** — that is an owner decision (slice 5 T9, ADR-0066).

Gates once at the end: `npm run check`, biome, `npm test`, Fallow (0 new), `npm run eval:artifacts:replay` green.
No Playwright run is needed unless you change app code (say if you did).

**Runs beside you:** TR-D4 (the board's keyboard reveal, `canvas/**`) — no shared files. The model server is the owner's
production model: keep runs sequential and bounded.
