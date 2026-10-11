# FG report: fast gates (FG, finished by FG-2)

Branch `infra/fast-gates`, worktree `.claude/worktrees/art-fg`, base `eb03dc69`. No file under `src/`, `static/` or `drizzle/` is
changed; the branch is tests, scripts, `playwright.config.ts`, `package.json` scripts, a `cacheDir` line in `vite.config.js`, and the
named AGENTS.md / README / tests/AGENTS.md lines. Model of the finishing agent: claude-sonnet-5-5.

Commits, oldest first. FG: `cae39413` (step 1), `462096c2` (step 2), `913a8b89`, `3477a490` (step 3 start), `eaf65d1a`.
FG-2: `cb46f8ee`, `97a3cad6`, `b0610449`, `3ee1eff0`, `66349820`, `3eef50a1`, `575ed0fb`, `6ee25bc2` (docs), `cf7852bc` (conventions
test), `59de2ff7` (release overlaps vitest by default). Range `cae39413..59de2ff7`.

## Status

DONE_WITH_CONCERNS (concerns at the end). Gate time **51m13s -> 8m25s..8m34s** (four runs) with the default (overlap) schedule, 10m40s..10m54s phased (the whole Playwright
suite, not only the old 66 files, plus every static gate); the same 66 specs in **7m32s** (was 48.3 min), 686 passed + 23 skipped
both times.

## The before / after table

Machine: this Mac, 14 cores (10 performance + 4 efficiency), 24 GiB. "Load" is `uptime`'s 1/5/15-minute averages; other agents
(the versioning agents, ports 5400-5429) were running beside me for most of it, which the load shows.

| | before (M3, `dev` 7cb27654, 2026-10-07) | after (this branch) |
|---|---|---|
| Whole gate | 51m13s | **8m26s / 8m34s / 8m25s / 8m28s** with `--schedule overlap` (the release default, gate-8..11) and **10m51s / 10m54s / 10m40s / 10m40s** phased (gate-3, 4, 6, 7); all green |
| Static gates | 2m51s (parallel, an orchestrator script) | phased: +2m42s..+3m01s until the e2e run starts (build 17 s, then check 40-45 s and vitest 2m25s-2m44s side by side; biome 1-2 s, migrations 0-1 s, Fallow 6 s); overlap: the e2e run starts at +17 s |
| Playwright | 48.3 min, 66 files, **686 passed + 23 skipped**, `workers: 1`, `vite dev` | **7m32s, the same 66 files, 686 passed + 23 skipped, 0 failed**, 6 workers, production build |
| Playwright, whole suite | not run (53 files were outside the gate) | 7m58s..8m15s in the gates: **966 passed + 60 skipped, 0 failed** (118 files; 3 tests in 2 files quarantined) |
| Smoke tier | none | 25 tests, **28 s at 6 workers, 31 s at 4, 46 s at 2** (all 25 pass; load 4-5) |
| An agent's final run | ~45 min of Playwright | `scripts/gates.sh agent` with 2 spec files: **3m46s** (load 12.9 at start) |

The three gate runs, step by step (`scripts/gates.sh release <dir> --port 5450`, 6 workers, schedule "phased"):

| | gate-3 | gate-4 | gate-6 | gate-7 |
|---|---|---|---|---|
| commit | 66349820 | 66349820 | 3eef50a1 | 575ed0fb |
| load at start / end | 4.2 10.2 10.5 / 10.3 10.4 10.8 | 10.3 10.4 10.8 / 9.9 9.8 10.6 | 7.1 11.2 11.5 / 8.0 8.6 10.1 | 6.4 6.8 8.4 / 8.9 8.5 8.9 |
| check | 43 s | 43 s | 40 s | 40 s |
| biome (`src scripts tests`) | 1 s | 2 s | 1 s | 1 s |
| migrations | 0 s | 0 s | 0 s | 0 s |
| build (then chunks 0 s) | 17 s | 18 s | 17 s | 17 s |
| vitest | 2m31s, 17,480 passed | 2m32s, 17,480 | 2m25s, 17,486 | 2m24s, 17,486 |
| Fallow | 6 s, 124 issues / 4 circular, 0 new | same | same | 5 s, same |
| Playwright | 8m03s, 965 + 60 | 8m04s, 965 + 60 | 7m58s, 966 + 60 | 8m00s, 966 + 60 |
| **total** | **10m51s** | **10m54s** | **10m40s** | **10m40s** |

The overlap schedule (`--schedule overlap`, the release default since `59de2ff7`: the e2e run starts when the build is done, vitest
runs beside it on three threads), same machine, same 6 workers:

| | gate-8 | gate-9 | gate-10 | gate-11 (no flags, final commit) |
|---|---|---|---|---|
| commit | 6ee25bc2 | cf7852bc | cf7852bc | 59de2ff7 |
| load at start / end | 5.1 6.7 8.1 / 10.2 9.7 9.0 | 8.1 9.2 8.8 / 12.0 12.0 10.3 | 12.0 12.0 10.3 / 10.1 10.8 10.3 | 7.6 10.1 10.0 / 11.5 10.8 10.3 |
| check | 35 s | 35 s | 36 s | 36 s |
| vitest | 7m02s | 7m37s | 7m09s | 7m15s |
| Playwright (starts at +17 s) | 8m08s, 966 + 60 | 8m17s, 966 + 60 | 8m08s, 966 + 60 | 8m11s, 966 + 60 |
| **total** | **8m26s** | **8m34s** | **8m25s** | **8m28s** |

Vitest hides behind the browsers (7 minutes on three threads against 2.5 on every core) and the e2e step costs 8-19 s more than when it
has the machine to itself. For an agent's run (a few specs, a minute of e2e) overlap would make vitest the longest step, so `agent`
stays phased. Gate-11 is the plain command with no flags on the final commit.

Runs that did not pass, and why, are in "Flaky and coupled tests found" below: gate-2 (12m01s, two timeouts on a machine at load 24
while another agent ran vitest; fixed), gate-5 (11m16s, one mobile-design measurement; fixed). The very first gate run served an app
that did not hydrate (below) and was stopped after 20 minutes.

Three consecutive green runs on the final code at 6 workers: gate-6, a plain whole-suite run (7m57s, 966 + 60), gate-7. (The
mobile-design fix, a spec-only edit, landed during gate-6 / the whole-suite run; gate-7 ran on the final commit `575ed0fb`, and the
only commit after it is documentation.) Earlier green whole-suite runs at 6 workers: 8m20s, 8m07s on the first code states.

## Worker-count measurements

Whole suite (118 files, 965 passed + 60 skipped), `E2E_PORT=5450`, quarantine applied, alone on the Playwright side (other agents
beside me; load at start in brackets):

| workers | wall clock | note |
|---|---|---|
| 4 | 11m46s (706 s) | green [8.9] |
| 6 | 8m07s / 8m08s (487 s, 488 s); 8m20s earlier on the first code | green [14.9, 3.5 .. 8.0] |
| 8 | 6m30s (390 s) | green [3.2] |
| 10 | 5m51s (351 s) | one failure, the poster-copy strict-mode violation (fixed, `3ee1eff0`) [6.7] |

The same 66 files as the M3 gate (`release-set-m3.txt`):

| workers | wall clock | result |
|---|---|---|
| 2 | 21m45s (1305 s) | FG's measurement, taken before the last fixes (some failures then) |
| 4 | 10m20s (620 s) | 686 passed + 23 skipped, 0 failed [6.8] |
| 6 | 7m32s (452 s) | 686 + 23, 0 failed [8.4] |
| 8 | 6m28s (388 s) | 686 + 23, 0 failed [8.0] |

Per-worker busy time is level at 6 workers (477-488 s each of 487), so the wall clock is the sum of the tests' own time divided by the
workers until the machine saturates: 2,900 s of test time, and the load average passes 9 at 6 workers and 12 at 8. The longest file
(`artifact-canvas.spec.ts`, 200 s) is not a limit below about 14 workers.

**Default: 6** (`DEFAULT_BUILD_WORKERS` in `tests/e2e/e2e-env.ts`; `E2E_WORKERS` or `--workers` overrides). Eight is another 1.5 minutes
and was green once, but it leaves no room for another agent's run, and the whole point of this job is a gate that does not flake.
**Beside one or two other agents: `E2E_WORKERS=4`** (an agent's own run is a few spec files plus the smoke set: 56 s at 4 workers).
A quiet machine at the integration gate can take `--workers 8`.

## Step 1: the chat route's closure rule (FG's `cae39413`, reviewed and re-proved)

`scripts/check-artifact-chunks.mjs` no longer holds the chat route within 2,048 B of a fixed byte count. `--chat-route ID` plus
`--chat-forbid PKG` (repeated) holds a rule: none of Chart.js, MapLibre, Mermaid, `@xyflow`, Tiptap/ProseMirror
(`prosemirror-view`, `prosemirror-model`, `@tiptap/core`) and the Canvas editor's own entry (`--name`) is in any chunk the route's root
layout, layouts and page load through static imports; `import()` chunks are allowed (that is how the chat loads Chart.js and
Mermaid). The route's size is printed ("543,863 bytes gzip in 79 chunks (information only, no budget)"). The editor's
`--max-gzip 72704`, `--max-target-gzip 65000` and `--forbid` list are unchanged (editor closure 70.9 kB). Unknown options now fail
instead of being skipped. FG also found that the old Chart.js fingerprint (`chartjs-`) is not in Chart.js itself: a chat route carrying
the whole library passed; it now keys on `$chartjs` + `_adapters`.

Review: the closure walks `imports` only (not `dynamicImports`), the fingerprints are looked for in every chunk and intersected with
the route's closure, a missing route node fails, and 279 lines of tests with a fixture manifest cover each library, a leak through a
layout, a static page import, the editor entry, a lazy-only entry, absent packages and the report. **Proved again on real builds by FG-2:**
one temporary static import of `chart.js/auto`, `maplibre-gl`, `mermaid`, `@xyflow/svelte`, `prosemirror-view`,
`prosemirror-model` and `@tiptap/core` into `src/lib/client/conversation-session.ts` (a module the chat page imports) built and was
refused with seven lines, one per library, `FAIL (chat-route) <pkg> is in <chunk>, which the chat route loads statically with its first
paint`, exit 1 (the editor leak check fired too); reverted, never committed; the clean tree builds and exits 0. (Namespace imports:
`import maplibregl from` breaks SvelteKit's post-build analysis in Node, which is not the check's business.)

**For the orchestrator, `wave-3/common.md` gate 4:** replace "...the chat route within 2 KiB of its baseline" with "...and the chat
route's first paint free of every heavy library (Chart.js, MapLibre, Mermaid, the flow library, Tiptap/ProseMirror, the Canvas editor
entry): a rule, no byte baseline; its size is printed as information". `--chat-baseline` and `--chat-tolerance` no longer exist. The
AGENTS.md Canvas bullet ("a size gate holds the line") already says this.

## Step 2: Playwright on the production build, a server and a database per worker

Where: `tests/e2e/e2e-env.ts` (what a slot is), `e2e-servers.ts` (build check, databases, servers), `global-setup.ts`,
`playwright.config.ts` (evaluated again in every worker, so each worker's `baseURL` and `DATABASE_PATH` follow its
`TEST_PARALLEL_INDEX`), `build-assets.ts`, `run-lock.ts`, `build-probe.ts`, `immediate-transactions.cjs` / `sqlite-immediate.cjs`.

- Slot N = Playwright's stable `TEST_PARALLEL_INDEX`: server on `E2E_PORT + N` (`node build/index.js`, `PLAYWRIGHT_TEST=1`,
  `HOME_SUMMARY_CACHE_TTL_MS=0`, `ORIGIN`, `PORT`, `HOST`), database `data/playwright-e2e-chat[-wN].db`, freshly migrated and seeded
  with its own admin (random id) and that admin's tours marked seen; everything starts in parallel in global setup (about 6 s).
  `E2E_SERVER=dev` keeps `vite dev` (one worker, a Vite cache per server via `VITE_CACHE_DIR`); `PLAYWRIGHT_REUSE_EXISTING_SERVER`
  still reuses a listening server. A build older than `src/` is refused before any server starts.
- **Deviation from the brief: no template database copy.** A copy gives every slot the same admin id, and the app keys on-disk state
  and per-user cleanup (`data/knowledge/<userId>/`, "forget everything") on that id, so a slot's cleanup could delete another slot's
  files. Each slot seeds its own admin instead (the seed is the migrations plus one insert).
- On-disk state under `data/` (chat files, knowledge uploads, campaign assets, avatars) is shared between slots without sharing a path:
  every key is a random conversation, user, artifact or campaign id, and the server's own orphan clean-up is driven by its own
  database's rows. The three mock servers the brief names (`atlas-job-flow`, `live-citation-audit`, the provider harness) listen on
  port 0; `chat-scroll-on-load`, `conversation-refresh`, `home-compact` and `instruction-suggestions` start no server at all.
- Reviewed: the spec edits FG made are real fixes (no assertion weakened, no blanket wait, global timeout 60 s and `retries`
  unchanged).

## Step 3: the gate runner, the quarantine list, the smoke set

- `scripts/gates.sh` (`gates.mjs`, no dependency): `release <dir>` and `agent <dir> [--workers N] [--port P] [--skip a,b]
  [--schedule phased|overlap] [spec ...]`. The build always runs alone with respect to check and vitest (with biome, migrations and Fallow
  beside it); then check, vitest and the chunk check start. Phased (the agent default): the e2e run starts when vitest is done, on a
  machine with nothing else of ours on it. Overlap (the release default): the e2e run starts with them and vitest runs on three
  threads beside it. Writes
  `summary.txt` / `summary.json` and one log per step into the directory: exit code, numbers, duration and start offset per step.
  Fallow is compared with `~/.cache/alfyai-artifacts/fallow-baseline-00ef6d2a.json` finding by finding, position keys dropped.
  Agent mode runs the named files in full plus the `@smoke` tests of every other file in one Playwright run (two projects sharing the
  workers). 33 unit tests hold the readers, the schedule and its defaults.
- `tests/e2e/quarantine.json`: the whole suite minus an explicit list, each entry with its reason; a unit test refuses an entry
  without a reason or naming something absent. Two files, three tests (below). `E2E_APPLY_QUARANTINE=1` (set by the gate and by
  `npm run test:e2e:smoke`) applies it; naming a spec on the command line still runs it.
- `@smoke`: 25 existing tests in 18 files: login; chat send/stream/retry (`chat`, `streaming`, `core-user-flows-smoke`); a rename;
  the Document opens and edits (autosave and reload); the one-version-number walk; the in-chat artifact card; the artifacts count
  button and File row; an App in its sandboxed frame; a Canvas seeded, inserted into and dragged, and Keep on a change; a tour on
  first open; the knowledge page and an artifact-family row; search by kind; settings (prompt save, users pane); a project and the
  home projects row. `npm run test:e2e:smoke`: 25 passed in 29 s.
- Docs: AGENTS.md "Mandatory Verification" (rewritten, short), README's testing line, `tests/AGENTS.md`.

## Flaky and coupled tests found, and how each was fixed

None by deleting a test, weakening an assertion, a retry or a longer timeout. In the order they were met:

1. **A build that exits 0 and does not hydrate (FG-2, `cb46f8ee`, the serious one).** The first `gates.sh release` run failed 369 of
   its first 372 Playwright tests on 15-second timeouts. `npm run check` (`svelte-kit sync`) and vitest (its SvelteKit plugin syncs at
   start) both rewrite `.svelte-kit/` while `vite build` reads it; started together, the build exits 0, passes its chunk check, and
   the app it made throws "Cannot read properties of undefined (reading 'data')" while hydrating, so every input stays disabled.
   Intermittent (reproduced 2 of 3 times; not when check starts a few seconds after the build). The old gate never noticed because
   its e2e ran on `vite dev`. Fixed three ways: the gate's check and vitest wait for the build (a unit test holds that in both
   schedules); global setup loads the built app's login page and waits for `#svelte-announcer` before any test runs, so a broken build
   stops the run in two seconds with the cause (seen working on a real broken build); AGENTS.md says never to run check or test beside
   a build. Also: an aborted gate left six servers on their ports (Playwright tears down only on SIGINT); SIGTERM and SIGHUP now kill
   the servers and free the run lock, and `gates.sh` sends SIGINT first.
2. **The first turn of a conversation made through the landing page (FG partly, FG-2 `97a3cad6`).** ~35 specs call
   `createConversation` (it sends a first message to the e2e servers' unreachable default model), seed rows into the database, then
   clear `pending-chat-message:<id>` from sessionStorage so the chat will not send it. Who gets to the key first is a race: measured
   25 of 25 for the spec in a quiet single-worker run, but under load the page wins, a turn starts and fails a few hundred ms later,
   and a reload that lands in that window never gets a terminal event back (below, "app findings"). It broke two tests in a gate run at
   load 24 (`artifact-document-comments:796`, `artifact-tours-arrival:437`, 60 s timeouts in `reload({waitUntil:"networkidle"})`). FG
   moved the live-edit specs to `createEmptyConversation` (the draft the landing page prepares, without the send; same title);
   FG-2 moved the other 32 files that clear the key (138 call sites). The specs that really send a first message wait for its answer
   and are untouched.
3. **FG: the model remembered per conversation** (34 tests on the build) and **lazy modules matched by source path** (2 tests, vite
   dev only): the open-chat helpers no longer race the first send; `moduleUrlPattern` in `build-assets.ts` asks the build's manifest.
4. **State left for the next file on the same worker (FG one, FG-2 four, `b0610449`).** A worker keeps its database from one file to
   the next. `composer-chips` left four admin overrides (broke `settings-admin`'s "only the edited key was written"). The audit of
   the twelve slot databases after a green run found `live-citation-audit` and `live-evidence-metadata` leaving a provider each, the
   admin's preferred model pointing at it (a mock server that was gone) and, for the first, `PARALLEL_API_KEY/BASE_URL`;
   `composer-command-v1` and `instruction-command` leaving `COMPOSER_COMMAND_REGISTRY_ENABLED=true`. Each now restores its own
   (`clearAdminConfig`, `deleteProvidersWithPrefix` in `helpers.ts`, the existing model snapshot helpers); after those files the
   worker databases end with no override, the seeded provider and the seeded model.
5. **A hidden copy of a block in `<body>` (FG-2, `3ee1eff0`).** At 10 workers one test failed with a strict-mode violation:
   `canvas-map` > `map-route-card` matched two elements for five seconds. While a map, App, photo or live-web block gets its poster,
   `pictures-controller.svelte.ts` keeps an `aria-hidden`, `inert`, off-screen copy of it in `<body>` with the same test ids, through
   the image wait, font embedding and upload. The specs mean the block on the board: `liveBlock(page, id)` (the id inside the flow's
   wrapper), 24 locators in four specs.
6. **`SqliteError: database is locked` (FG-2, `3eef50a1`).** One whole-suite run in ten failed a seeding call 489 ms into
   `artifact-versions.spec.ts:363`. Specs seed by calling the app's services in their own Playwright worker, against the file their
   server writes too; better-sqlite3 begins transactions deferred, so a read-then-write transaction whose snapshot the server
   outdates is refused at once, and the 10-second busy timeout does not apply. Reproduced deterministically with two connections (a test
   in `tests/integration`). `tests/e2e/immediate-transactions.cjs` makes every transaction take its write lock at BEGIN; the servers
   load it with `node -r` (an absolute path) and the Playwright config loads it in each worker. Test infrastructure only.
7. **A mid-slide measurement (FG-2, `575ed0fb`).** `mobile-design.spec.ts` "Chat Area and Input Area": the composer sheet's grabber
   read 43.99997 px against a floor of 44. `waitForStableBoundingBox` before each measurement of a sheet or menu in that file. There
   are 70 more `>= 44` measurements in 19 other files; none has failed in 14 runs, but this class can recur (see concerns).

## Quarantine (tests/e2e/quarantine.json)

Both fail the same way on `vite dev` (FG-2 re-ran them there on this branch, whose `src/` is identical to its base) and on the build,
and are outside the M3 gate set:

- `everyday-redesign-screens.spec.ts` "knowledge documents tab (" (the light and dark tests): the row the spec seeds
  (`nextcloud-folder-audit.csv`) shows "Failed - This document was added before processing was tracked" where the spec expects a
  dash: its seed predates the extraction ledger (a seeded document has no extraction state, so the page reads it as unprocessed). Back
  in when the seed rows carry an extraction state or the expectation says what a legacy row shows.
- `map-route-card.spec.ts` "draws the route line from a worker the build actually serves": on the build the page logs a report-only
  Content-Security-Policy violation (`script-src` has no `'unsafe-eval'` and something evaluates a string as JavaScript while the
  route card draws; MapLibre's style expressions are the likely source, not traced), and the spec asserts the policy refuses nothing;
  on `vite dev` it fails earlier (it is about a worker only the build serves). Report-only, so no user sees it; a product decision.

**Specs outside the M3 set that fail on feat/artifacts today: exactly those three tests.** Every other spec in the 52 files outside the
M3 set passes (the 32 `zz-capture-*`, `admin-system-screenshots` and `zz-knowledge-polish-capture` tests skip without their env switch).

## Findings in the app (not fixed here; `src/` is the orchestrator's)

1. **Reconnect after a reload during a first turn that fails at once never receives its terminal event.** Server log of a failing
   run: one `start called` for stream 8bbefa2c, the upstream `Cannot connect to API` error and the non-stream fallback; a second
   `start called` with the same stream id 224 ms later; a third that logs `Reconnect to same stream`, `Replaying buffer ... {
   hasContent: true, tokens: 0 }` and `Reconnect done, subscribed`, and then the original run's `Non-stream fallback failed` a
   millisecond later. No further log for that conversation for 60 s: the reconnect request stays open (heartbeats), the chat shows a
   running turn that never ends, and `networkidle` is never reached. Found by the e2e servers' default model being unreachable, but a
   provider that refuses a connection quickly would do it to a user who reloads within a few hundred ms of sending.
   `src/lib/server/services/chat-turn/stream-reconnect.ts` (`doReconnect`: replay the buffer, then subscribe) is where to look.
2. The `map-route-card` CSP violation above (`unsafe-eval` on the production build).
3. Any second process writing the live database (a maintenance script) can meet the same "database is locked" on a deferred
   read-then-write transaction (`updateArtifactBody` is one); `db.transaction(..., { behavior: "immediate" })` is the cure there too.

## How an agent runs its tests now

- Final run, once: `scripts/gates.sh agent <out-dir> --port <base> [--workers 4] <the e2e spec files you changed or added>` (static
  gates, your specs in full, the 25 smoke tests of the other files; about 4 minutes, vitest is most of it). `--skip` leaves steps out.
- While iterating: `npm run check`, `npm test`, `npm run build`; `npx biome check src scripts tests` (not `npm run lint`);
  `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test <spec>` against a fresh build; `E2E_SERVER=dev E2E_PORT=<port> npx playwright test
  <spec>` while editing UI code (one worker, no rebuild); `E2E_PORT=<port> npm run test:e2e:smoke` for a 30-second look at the main
  flows. **Never run check or test while a build runs.**
- Beside one or two other agents: `E2E_WORKERS=4` at most. A run takes `E2E_WORKERS` ports from `E2E_PORT`, one e2e run per
  worktree at a time (a lock names the holder).

## For the orchestrator

- Integration gate: `scripts/gates.sh release <dir> --port <base>` (add `--workers 8` on a quiet machine, `--schedule phased` for the
  e2e run alone on the machine); read `<dir>/summary.txt`. About 8.5 minutes (10.7 phased). It fails as a whole if any step's numbers move (build warnings above 32 + 2, Fallow findings not in the
  baseline, a fifth cycle, any failed or flaky e2e test).
- `phase-5/common.md`, "Your Playwright scope is tiered": replace by the agent command above, and the `wave-3/common.md` gate 5 by
  the same; gate 4 as written in "Step 1".
- The M3 baselines in `phase-5/common.md` stay true: check 0 errors / 17 warnings, build 32 + 2, Fallow 124 / 4 (all reproduced
  above); vitest is now 17,480-17,486 tests in 1,040-1,041 files because this branch adds tests; Playwright is 966 + 60 on 118 files.

- `tests/integration/e2e-conventions.test.ts` (in the vitest step) fails, naming the file and the fix, for a spec that calls
  `createConversation` and clears the pending first message, or addresses a map / App / photo / live-web block with
  `page.getByTestId`. The versioning and History UI agents will write specs: their branches may carry the old habits after the
  merge; the test says exactly where.
- The 32-file `createConversation` -> `createEmptyConversation` change is mechanical; if a merge conflicts in a spec that other
  agents also touched, re-apply it with a replace of the call and the import (titles are kept).

## Concerns

- The gate is only as stable as the machine is quiet. The two non-green gate runs that were not code defects of the gate (gate-2) ran
  with another agent's vitest and Playwright beside them (load 24); the cure was in the specs (finding 2), but a 60-second timeout
  under heavier load than that is still possible. Eight workers is not the default for that reason.
- More mid-animation measurements likely exist (70 `>= 44` floors in 19 files); each that fails should get `waitForStableBoundingBox`.
- The poster-copy and first-turn findings are app behaviours the specs now step around; the reconnect hang (finding 1) is a real
  defect for users on a fast-failing provider.
- Not measured: a run with the owner's other apps under load (browser, editor), where timings may move.

## Final state

Branch `infra/fast-gates` at `59de2ff7`, worktree clean, nothing pushed. Last full run: gate-11, ALL GATES PASSED, 8m28s.
