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
| Builder check | running | |
| S1 engine | not started | |
| R1 | not started | |
| S2 Atlas | not started | |
| S3 extraction | not started | |
| S4 file production | not started | |
| R2 | not started | |
| Ship | not started | |

## Budget log

| When (UTC) | Weekly % | 5-hour % | Event |
|---|---|---|---|
| 2026-10-15 00:00 | 72 | 6 | start |
| 2026-10-15 00:15 | 73 | 14 | after recon and the caller inventory (Sonnet, 389k tokens) |
