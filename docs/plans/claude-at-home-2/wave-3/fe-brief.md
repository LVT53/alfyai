# Small agent F-E · size budgets are a gate, not a deploy step

The dev deploy of the Canvas failed on the server: `npm run build` ends with `npm run check:artifact-chunks`, and its
chat-route comparison against a fixed byte baseline (`--chat-baseline 535771`, measured on a developer machine) reads
+2,129 B on the server's build (limit 2,048) where the same code measures +1,467 B locally — the server's build
environment adds ~660 B to every route. The budgets are development gates; a deploy of reviewed, gated code must not
fail on them.

- Worktree `/Users/lvt53/Nextcloud/Documents/DOYUN-FOLDER/Dev/alfyai/.claude/worktrees/art-fxe3`, branch
  `fix/artifacts-budget-gate` (from `feat/artifacts`), label `fe`. No e2e needed.
- Report: `/private/tmp/claude-501/-Users-lvt53-Nextcloud-Documents-DOYUN-FOLDER-Dev-alfyai/cabde459-204b-43f4-96fb-60f3639a68a8/scratchpad/w3/fe-report.md`

## Do

1. `package.json`: `build` keeps `vite build`, the body-size patch and `check:worker-assets` (a correctness check), and
   no longer runs `check:artifact-chunks`; the `check:artifact-chunks` script itself is unchanged (same budgets). If any
   test pins the build script's text, update it with the reason.
2. Make the gates run it: `docs/plans/claude-at-home-2/wave-2-5/gates.sh` runs `npm run check:artifact-chunks` right
   after `npm run build` and reports its exit on its own summary line; `docs/plans/claude-at-home-2/wave-3/common.md`
   gate 4 says the budgets run as their own step. If the repo has a CI workflow or README section listing the build's
   checks, add the step there too (grep for `check:worker-assets`).
3. Prove: `npm run build` exits 0 without running the chunk check; `npm run check:artifact-chunks` still passes and still
   fails when a budget is exceeded (run it once with a lowered `--max-gzip` on the command line to see it fail — do not
   commit that). `npm run check`, `npx biome check src scripts tests`, and the vitest files for the chunk script.

Commit each step with a message that says why. Final reply at most 6 lines: status, your model ID, commits, what you ran.
