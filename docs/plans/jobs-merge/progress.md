# Job engine run: progress

The live state of the run that implements [`design.md`](design.md) through [`plan.md`](plan.md). A fresh orchestrator session resumes from here.

## Owner decisions

- 2026-10-14: merge the three job systems behind one module with a small typed interface ("a structured API").
- 2026-10-15: "I preapprove of the implementation plan as long as it follows the initial goal set in my first prompt here. Start the work when you wrote it with subagents. Then deploy the finished state to ai.dev on the box and test whether all affected system areas still function."

## Standing rules

- Sonnet agents in worktrees, one slice each.
- Opus only for R1 (engine) and R2 (data path).
- Agents report their model ID.
- Push only `dev`, and only for the ai.dev deploy the owner asked for. Production is untouched.
- Check `get_usage` before every dispatch. Do not start a slice that would take the weekly limit past 94%.
- S4 (file production) waits until the upload-analysis session (`Add analysis of uploaded files in the sandbox`) has been checked for work in flight in `file-production/`.

## Branches

- Integration: `feat/jobs-engine` (worktree `.claude/worktrees/wizardly-tharp-ee691a`), from `dev` = `11b0496d7`.
- Slices branch from it and merge back into it.
- `dev` gets the whole run at Ship.

## State

| Step | State | Notes |
|---|---|---|
| Design + ADR-0069 | done, `87cb83b2b` | |
| Plan | done, `1e8e8177a` | |
| Builder check | done | 7 questions; 6 settled as my calls in design.md and plan.md; the push scope asked of the owner |
| S1 engine | done, merged `50d58309e` | 14 commits, 264 engine tests; gates at `884a14257`: check 0/17, vitest 19,173, smoke 236/236, Fallow 0 new. Sonnet, 872k tokens, 78 min |
| R1 | done, merged `7747381ed` | Opus, 507k tokens, 38 min: 7 engine fixes with failing tests first; 4 design points settled in design.md ('After the engine review') |
| S2 Atlas | done, merged `527c48928` | Sonnet, 661k tokens, 38 min; gates at `be7c1769c`: check 0/17, vitest 19,206, Playwright 37/37, Fallow 0 new. Two findings went to the touch-up agent |
| S3 extraction | done, merged `7416f58c4` | Sonnet, 392k tokens, 78 min; gates at `7b97e2e27`: check 0/17, vitest 19,205, Playwright 74/74, Fallow 0 new. After the merge with the touch-ups: 84 files / 1,426 tests pass (jobs, extraction, atlas, mineru integration, backfill script, db). `db/compat.ts` joined ALLOWED (the shim). The reverse SQL stays manual |
| S2b touch-ups | done, merged `e742522d9` | Sonnet, 498k tokens, 29 min, 6 fixes test-first; gates at `2772f8ff7`: vitest 19,219, Playwright 27/27. Extraction and file production keep their own dead-worker check until S3/S4 remove it |
| S4 file production | running (Sonnet, branch `jobs/s4-file-production`) | Coordination checked 2026-10-15 03:05 UTC: the upload-analysis session (local_3cfe1b3e) last ran 2026-10-14 18:47, has no branch or worktree, and no branch but this run's touches `file-production/`. Nothing in flight; S4 may go after S3 |
| R2 | running | Opus, branch `jobs/r2-data-review`: migrations 114/115, the shim, the rollbacks, the cutover; migration 116 checked by the orchestrator after S4 |
| Ship | not started | |

## Budget log

| When (UTC) | Weekly % | 5-hour % | Event |
|---|---|---|---|
| 2026-10-15 00:00 | 72 | 6 | start |
| 2026-10-15 00:15 | 73 | 14 | after recon and the caller inventory (Sonnet, 389k tokens) |
| 2026-10-15 01:42 | 77 | 41 | S1 merged; R1 dispatched alone (5-hour window resets 04:50) |
| 2026-10-15 03:00 | 79 | 58 | S2 merged; S3 and the touch-up agent dispatched together |
| 2026-10-15 04:21 | 82 | 85 | S3 merged; S4 held until the 5-hour window resets at 04:50 |
| 2026-10-15 04:50 | 82 | 0 (reset) | S4 and R2 dispatched side by side |
