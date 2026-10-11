# FG — fast gates: the release gates from ~51 minutes to ~15, with the same coverage

The owner finds the development process far too slow (memory `alfyai-dev-process-speed`). The release gates take ~51
minutes and every agent waited ~45 minutes on Playwright before reporting. Make them fast without losing coverage.
Read `docs/plans/claude-at-home-2/phase-5/common.md` and the two files it names first.

- Branch / worktree: `infra/fast-gates` in `.claude/worktrees/art-fg` (made for you from `feat/artifacts`, `node_modules`
  linked, e2e DB prepared). Base port **5450**: ports 5450–5469 are yours for parallel workers.
- Report: `<scratchpad>/p5/fg-report.md` (`<scratchpad>` is the path in common.md). Commit after each step.

## The "before" (measured, do not re-measure it)

M3 release gates, `dev` = `7cb27654`, worktree `dev-int`, this Mac (14 cores: 10 performance + 4 efficiency, 24 GiB),
2026-10-07, total **51m13s**:
- The static gates already ran in parallel from an orchestrator script (`docs/plans/claude-at-home-2/wave-2-5/gates.sh`
  is the older serial version of it): `npm run check` ~22 s, biome ~1 s, `check:migrations` ~1 s, vitest 17,408 tests
  ~2m30s, `npm run build` ~2m46s then `check:artifact-chunks`, Fallow ~2m50s. All done by 2m51s.
- Then Playwright: the 66 spec files listed in `<scratchpad>/p5/release-set-m3.txt`, **686 passed + 23 skipped in
  48.3 min**, `workers: 1`, `fullyParallel: false`, against `vite dev` (`playwright.config.ts`'s `webServer`), one
  database (`data/playwright-e2e-chat.db`, prepared by `DATABASE_PATH=… npm run db:prepare` before the run) and one
  shared e2e admin that `tests/e2e/global-setup.ts` seeds (it also marks every tour seen). The whole suite is 119 spec
  files; the other 53 are not in the release set today.

## Step 1 — the chat route's closure check replaces its fixed-byte baseline (~30 min)

`check:artifact-chunks` (`scripts/check-artifact-chunks.mjs`, flags in `package.json`) holds the chat route within
2,048 B of a fixed byte baseline (`--chat-baseline 542004`). It moved nine times in Wave 4 (ruling 68's notes in
`decisions.md`), each a measured re-baseline, and it reads ~660 B heavier on the server's build. Replace it with a
closure check: **no heavy library in the chat route's first paint** — Chart.js, MapLibre, Mermaid, the flow library
(`@xyflow/*`) and Tiptap/ProseMirror (and the Canvas editor's own entry) must not be reachable through static imports
from `/(app)/chat/[conversationId]`; lazy (`import()`) chunks are allowed, which is how the chat already loads Chart.js
and Mermaid. Keep the editor's first-paint ceiling (`--max-gzip 72704`), its own forbid list and `--max-target-gzip`
unchanged. Print the chat route's size as information (no budget). Prove the check: a unit test with a small fixture
manifest, and one deliberate violation on a real build (a static import of `chart.js` into a chat component, seen
failing, reverted, never committed). Update the sentences that describe the gate in AGENTS.md (the Canvas subsection's
"a size gate holds the line" bullet) and `wave-3/common.md`'s gate 4 is the orchestrator's to update; say what changed
in your report.

## Step 2 — Playwright against the production build, parallel workers, a database per worker (the big one)

- **Production build.** The gate builds once (`npm run build`, which the static gates already do) and the e2e servers
  run the built app (`node build`, adapter-node) instead of `vite dev`. Find what the specs rely on from dev mode and
  keep it working: `PLAYWRIGHT_TEST=1` short-circuits (e.g. the title route), `HOME_SUMMARY_CACHE_TTL_MS=0`, any
  `import.meta.env.DEV` / `dev` branch a spec depends on, the e2e fake provider, adapter-node's `ORIGIN` (SvelteKit's
  CSRF check on form posts), `BODY_SIZE_LIMIT` (`scripts/patch-body-size-limit.mjs`), static asset paths, the App
  sandbox, the worker assets (`check:worker-assets`). Keep `vite dev` selectable (e.g. `E2E_SERVER=dev`) for an agent
  iterating on UI code, where a rebuild per change would be slower; the gate and an agent's final run use the build.
- **A database and a server per worker.** Each worker gets its own server process on `E2E_PORT + parallelIndex` and its
  own SQLite file copied from a template that global setup prepares once (migrations, the seeded admin, the tours-seen
  rows). Use `TEST_PARALLEL_INDEX` (stable per slot), not `TEST_WORKER_INDEX`. Specs that import `$lib/server/db` into
  the runner process (see the comment at the top of `playwright.config.ts`) must open their own worker's file.
  Chat files, campaign assets and any other on-disk state (`data/chat-files`, `data/campaign-assets`, `test-data/`) must
  be per worker too if specs write them.
- **Cross-file coupling.** With one worker every spec saw every earlier spec's leftovers. Find specs that depend on
  another file's side effects, or on global singletons (a fixed port: `atlas-job-flow`, `chat-scroll-on-load`,
  `conversation-refresh`, `home-compact`, `instruction-suggestions` and `live-citation-audit` start their own servers;
  check whether any of those are in the release set and give them free ports), and make each spec self-sufficient.
  `fullyParallel` stays `false` unless you prove a file safe: tests inside a file keep their order.
- **Worker count.** Measure the release set at 2, 4, 6 and 8 workers (or until the gain stops), note the load, and pick
  a default; make it overridable (`E2E_WORKERS`). Agents running beside each other will use fewer: recommend a number.
- **Stability is the requirement, speed is the goal.** Run the release set at least three times at the chosen count,
  green each time, before you call it done. A test that fails only in parallel is a real bug in the test (shared state,
  a mid-animation measurement: `waitForStableBoundingBox`, `waitForMotionToSettle`, `expectTopmost` in
  `tests/e2e/helpers.ts`) or in the app; fix the cause. **Never** delete a test, weaken an assertion, add a blanket
  retry, or raise the global timeout to get green; a targeted wait for a real condition is fine. If one test resists,
  quarantine it by name with the reason in your report and keep going rather than grinding for hours.
- Note: `node_modules` (and so `node_modules/.vite`) is shared by every worktree through the symlink; if that cache
  causes cross-worktree trouble, a per-worktree `cacheDir` is in scope.

## Step 3 — one gate runner, tiered tests, the measurement (~45 min)

- **`scripts/gates.sh`** (in the repo; or `.mjs` if you prefer, with no new dependency): `release` mode runs every gate
  with the independent ones in parallel (check, biome `src scripts tests` — not `npm run lint`, which breaks on nested
  worktrees —, migrations, vitest, build → chunks → Playwright, Fallow compared against
  `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json` the way `wave-2-5/gates.sh` does), schedules them so the
  machine is not oversubscribed (measure: vitest and Playwright both want every core), and writes a one-screen summary
  with each step's exit code, its numbers and **its duration**, plus the logs, into a directory it is given.
  `agent` mode runs the static gates plus the specs it is given plus the smoke set. The release mode's Playwright set:
  **the whole suite minus an explicit quarantine list** (a file in the repo, each entry with its reason), so a new spec
  joins the gate by existing. Run the whole suite once to build that list; report the specs outside today's release set
  that fail on `feat/artifacts` and why, but do not fix product behaviour for them.
- **The smoke set:** tag about 15–25 existing tests `@smoke` (title tag) that together touch the main flows (sign in,
  send and stream a chat turn, open each kind in the panel, a Document edit and its version, a Canvas block, a tour card,
  the knowledge library, settings), finishing in under three minutes on the build. Add `npm run test:e2e:smoke`.
- **Docs:** AGENTS.md's "Mandatory Verification" section (the Playwright commands and the new tiers) and README's
  testing lines if it has any. Keep it short.
- **The "after":** run `scripts/gates.sh release` on your branch twice with nothing else of yours running, and report
  wall clock per step and in total next to the "before", the worker count, the machine's load (`uptime`) at start and
  end (other agents may be running: the versioning capture agent uses port 5410 with `vite dev` for about an hour), and
  the counts (passed/skipped/failed, same 66 specs for the comparison, plus the whole-suite number). Target ≤ 15 min.

## Owns / does not own

Owns: `playwright.config.ts`, `tests/e2e/global-setup.ts`, `tests/e2e/helpers.ts` and a new fixtures module beside it,
spec files only to remove cross-file coupling or add `@smoke`, `scripts/check-artifact-chunks.mjs` and its test,
`scripts/gates.sh` (new), the quarantine list (new), `package.json` scripts, `vite.config.ts` only for `cacheDir`, the
named AGENTS.md/README lines. Does not own: product code under `src/` (if a parallel-only failure is a real app bug,
report it with a repro; fix it only if it is small and obvious), `docs/plans/**`, `drizzle/`.

## Report

`fg-report.md`: per step what changed and where; the before/after table; the worker-count measurements; every flaky or
coupled test found and how it was fixed; the quarantine list with reasons; the specs outside the release set that fail
today; how an agent should run its tests now (the exact commands, the recommended worker count beside one or two other
agents); the commands the orchestrator runs at the integration gate. Final reply at most 12 lines: status, **your model
ID**, commit range, before → after, concerns.
