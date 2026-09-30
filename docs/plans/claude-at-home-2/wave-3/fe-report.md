# F-E report: the size budgets are a gate, not a deploy step

**Status: DONE.** Model: `claude-sonnet-5-5`. Worktree `.../.claude/worktrees/art-fxe3`, branch
`fix/artifacts-budget-gate` (3 commits on top of the brief's `22db095d`). Nothing pushed, merged or rebased.

## Commits

| Commit | What | Why (in the message too) |
|---|---|---|
| `1695097c` | `package.json`: `build` = `vite build` + body-size patch + `check:worker-assets`; `check:artifact-chunks` no longer chained. The `check:artifact-chunks` script line is byte-for-byte unchanged (same budgets). | The chat-route comparison is a fixed byte baseline (535,771) taken on a developer machine; the server's build environment reads ~660 B heavier per route (+2,129 vs +1,467 locally, limit 2,048), so a deploy failed on a number that says nothing about the release. |
| `0f6bfd17` | `docs/plans/claude-at-home-2/wave-2-5/gates.sh`: runs `npm run check:artifact-chunks` right after `npm run build` and prints its own `chunks` summary line (exit, editor closure, chat-route delta; FAIL lines on failure; the log's last line if it never measured). `wave-3/common.md` gate 4: the budgets run as their own step, must exit 0, reported on their own line, and why they are not in the build. | With the budgets out of the build nothing in the dev flow would run them. |
| `02b519dd` | `AGENTS.md` (Canvas rule 68 paragraph) and the header comment of `tests/e2e/artifact-canvas-perf.spec.ts`: both said the check is part of / ends `npm run build`. Now: a development gate on a finished build, deliberately not in the build, and why. | A reader would look for the budgets in the build output, find nothing and assume they were dropped. |

No test pins the build script's text (grepped `scripts.build`, `package.json` readers, the deploy tests); nothing to update there.

## Proof (all in this worktree, node 22.23.3)

- `npm run build` **exit 0, 15 s**; output shows `[worker-assets] OK — 5 worker reference(s), all emitted`; **0** `artifact-chunks` lines;
  warnings 32 `Unused CSS selector` + 2 `must have an ARIA role` = the baseline.
- `npm run check:artifact-chunks` on that build, **exit 0**: CanvasEditor chunk 60.0 kB gzip, what it loads on its own 67.7 kB
  (69,359 B of 69,632); chat route 537,247 B gzip = **+1,476 B** against 535,771 (2,048 allowed).
- Fails when a budget is exceeded (command line only, nothing committed):
  - `npm run check:artifact-chunks -- --max-gzip 60000` -> **exit 1**,
    `FAIL (budget) what the CanvasEditor chunk loads on its own is 69359 bytes gzip, over the 60000 allowed`.
  - `npm run check:artifact-chunks -- --chat-baseline 534000` (the server's failure mode) -> **exit 1**,
    `FAIL (chat-route) ... grew to 537247 bytes gzip, 3247 over its baseline of 534000 (2048 allowed)`.
- The new gates.sh block, extracted and run four ways (real pass; stubbed `npm` replaying the two failing logs with exit 1; a
  no-manifest log): `chunks     exit=0 :: editor closure 67.7 kB gzip;chat route +1476 B (of 2048);`, the two FAIL lines, and the
  last-line fallback. `bash -n gates.sh` OK; file mode unchanged (755). The whole gates.sh was not run (it is the full suite).
- `npm run check`: exit 0, 8327 files, **0 errors, 17 warnings in 3 files** (ToolActivityRow 10, ThinkingBlock 6, RouteItinerary 1) = baseline.
- `npx biome check src scripts tests`: clean, 2,424 files.
- `npx vitest run scripts/check-artifact-chunks.test.ts`: 34 passed. Also `scripts/deploy.test.ts` (reads the deploy scripts, which
  still call `npm run build`) and `src/lib/server/services/app-version.test.ts` (reads package.json): 124 passed across the three files.
- Not run (config/doc-only change, not asked): `npm test` in full, Playwright, Fallow, `check:migrations`.

## For the orchestrator

1. **Fresh worktree gotcha (not caused by this change):** `npm run build` ends its Vite step with SvelteKit's `analyse`, which opens the
   SQLite file at `DATABASE_PATH` (default `./data/chat.db`). In a worktree with no `data/` directory the build dies in ~7 s with
   `TypeError: Cannot open database because the directory does not exist`. I built with `DATABASE_PATH` pointing at a file in the
   scratchpad (no `data/` created in the worktree). `gates.sh`'s build step has the same dependency: its `db:prepare` (which creates
   `data/`) runs *after* the build, so a worktree that never had `data/` fails the build line there. The server has `DATABASE_PATH` from `.env`.
2. **Headroom, now that they only gate development:** editor closure 273 B under its 69,632 B ceiling; chat route 572 B under its
   +2,048 B tolerance. If the server's +~660 B per route applies to the editor's closure too, that budget would also have failed there.
3. **Left alone on purpose:** `scripts/check-artifact-chunks.mjs` (brief: unchanged; its header still says "Build guard ... a build
   error", read it as "a failing check"); README (its Development section lists check/lint/test/build and describes the body-size patch;
   it never listed the build's checks); CI (`.github/workflows/ci.yml` runs check, lint, test:ci and never builds; `check:worker-assets`
   is not there either); `decisions.md` ruling 68 ("enforced by `check:artifact-chunks`" is still true; if you want the move recorded, it is
   a one-line amendment: the check runs as a gate, not in the build); older agent reports that say "also in `npm run build`" (history).
