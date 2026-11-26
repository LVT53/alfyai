# Faster Development Cycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An agent's gate run takes about 2 minutes and the release gate 10 minutes or less on an idle Mac. The release gate runs the same tests, and the Mac stays usable while a gate runs.

**Architecture:**
- `scripts/gates.mjs` stays the one runner. It gains four small modules beside it: the cost readers, the queue, the Mac sampler and the history.
- A selection module picks the unit tests for an agent's run. `vitest.config.ts` reads the same module.
- Browser specs sign in by making a session directly. A separate form helper keeps the real sign-in for the specs that test it.
- Unit tests run in Node unless a per-file comment asks for jsdom. A guard test keeps that honest.

**Tech Stack:** Node 22 ESM scripts, Vitest 4.1.12, Playwright 1.59.1, SvelteKit, Drizzle on better-sqlite3, git.

**Spec:** `docs/superpowers/specs/2026-11-23-dev-cycle-speed-design.md`, which the owner approved on 2026-11-23. Read it first: this plan argues from it, and its sections are cited as "spec §N".

**Docs checked.** These sessions have no Context7 or Svelte MCP, and vitest.dev documents v5, so every point below was checked in the installed packages.

Vitest 4.1.12, in `node_modules/vitest/dist`:
- `--changed <ref>` lists `git diff --name-only <ref>...HEAD`, then adds staged, unstaged and untracked files.
- `vitest related <paths>` resolves its paths against the root, and passes when no test is related.
- It follows static and dynamic imports. It skips `node_modules`, and any import with a query such as `?raw`.
- `forceRerunTriggers` replaces the default list, and is matched against absolute paths. The setup files are not triggers.
- `// @vitest-environment <name>` is read anywhere in a file.
- A jsdom file is transformed in Vite's `client` environment, and a node file in its `ssr` environment.

Playwright 1.59.1 (its type declarations):
- `JSONReportTestResult` has `parallelIndex`, `startTime`, `duration` and `steps`.
- `test.step(title, body, { box })`.
- `BrowserContext.addCookies` takes a cookie with a `url`.

**Measured while planning** on 2026-11-23, on an idle Mac with the gate's priority at 31:
- `vitest list --filesOnly` lists 1,507 files in 1 s.
- With `--changed origin/main`, walking the imports of all of them takes 14.3 s wall time (21 s CPU, 2.2 GB peak). That is under the spec's 30 s bar.
- A one-line change to `src/lib/server/services/auth.ts` selects 40 files.

The unit-test files today:
- 179 read files or start processes.
- 450 use a DOM, Svelte or `$app` directly.
- 953 sit under `src/lib/server`, `src/routes/api`, `scripts`, `tests/integration` or `tests/cross-cutting`.
- 72 already say `@vitest-environment node`, and 2 say `jsdom`.

## Global Constraints

- **Versions.** Vitest stays at 4.1.12 and Playwright at 1.59.1. Vitest gets no `isolate: false` and no threads pool.
- **Tests keep what they check.** To save time, no test may be deleted, skipped, quarantined, retried, given a longer timeout, or given a weaker assertion. A test may move to another file and change how it signs in; nothing more.
- **The release gate stays whole.** It always runs every step and every test. Selection and fail-fast apply only to `agent` mode.
- **No settings changes.** Never use background QoS (`taskpolicy -b` or `-c background`). Agents never change system or app settings (`defaults write`, launchd jobs); only the owner does.
- **Gate state** lives in `<git rev-parse --git-common-dir>/alfyai-gates/`, never in `$TMPDIR`. Every use of it fails open, with a line that says so.
- **What counts as a measured run.** Its summary must show all of these:
  - the queue was held;
  - no other vitest or Playwright run was seen;
  - the priority never dropped below 31;
  - no swap was in use at the start.
- **Targets.** The release gate takes at most 10 minutes on an idle Mac. An agent run takes about 2.
- **Selection base.** The default base for picking unit tests is `origin/main`. The comparison runs from its merge-base with HEAD. `--base <ref>` names another ref.
- **Full-run triggers.** A change to any of these runs every unit test: `package.json`, `package-lock.json`, `vitest.config.ts`, `vite.config.js`, `svelte.config.js`, `tsconfig.json`, `src/vitest-setup.ts`, `src/vitest-global-setup.ts`, `drizzle/**`, `scripts/unit-test-selection.mjs`.
- **The AGENTS.md gates hold for every commit that ends a task:**
  - `npm run check` shows 0 errors and 0 warnings.
  - `npx biome check src scripts tests` is clean. Format the files you touched with `npx biome check --write <files>`.
  - `npm run build` prints no warnings.
  - Fallow reports nothing new against `.fallow/baseline.json`. So every new export is imported by code or by a test, and no new import cycle appears.
  - Never run `check` or `npm test` while `npm run build` runs.
- **Node 22 for every command.** Start with `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`. Building a browser spec needs `npm run build` first.
- **Importing a new `.mjs` module from a TS test** uses the same comment `scripts/gates.test.ts` uses: `// @ts-expect-error — plain .mjs script, no type declarations`.
- **Commits.**
  - One logical change each, with a message that says why.
  - Each ends with the trailer `Speed-Task: <N>` and `Co-Authored-By: <the session's model> <noreply@anthropic.com>`.
  - Nothing is pushed. Merging into `main` is the owner's call.

## Review Focus

1. **No usable base ref:** a clone with no `origin/main`, a ref with no merge-base, or a shallow history. Selection must run every unit test and say why. It must never run nothing. Task 6 tests this.
2. **A deleted or renamed source module whose importers were not updated.** Vitest's walk skips files that no longer exist, so the tests that broke would not be chosen. Run everything, and name the file. Task 6 tests this.
3. **A lock left behind.** Cases:
   - a gate that was killed;
   - a half-written lock file;
   - a PID the system has reused for another program;
   - a git directory that can't be written;
   - a holder that hangs.

   The queue takes the lock over or fails open, and never waits more than 45 minutes. Task 2 tests this.
4. **`login()` asked for something only the form can give:** a user with two-step sign-in on, or a password that was changed earlier in the same test. It must refuse loudly, never sign in quietly. Task 10 tests this.
5. **A unit test that acts differently in Node without touching the DOM.** For example, it reaches a module that reads `browser` from `$app/environment`, checks `typeof window`, or is a `.svelte` or `.svelte.ts` module. In Node it would still pass, but it would be testing the server branch. Task 12's guard keeps such a file in jsdom.

---

## How the work runs

There are three phases. At most two sessions build at once (the owner's rule). Execution is native, with one Opus review of the whole branch at the end (the owner's preference since 2026-11-16).

| Phase | Session | Branch | Tasks | Files it owns |
|---|---|---|---|---|
| 1 | Track A (Opus) | `claude/dev-cycle-speed`, from `claude/dev-cycle-speed-spec` | 1–9 | `scripts/gates*`, `scripts/unit-test-selection*`, `vitest.config.ts`, `AGENTS.md`, `docs/plans/dev-cycle-speed/`, `login()` in `tests/e2e/helpers.ts`, marker comments in unit-test files |
| 2 | Track B (Sonnet) | `claude/dev-cycle-speed-browser`, from Track A's Task 9 commit | 10–11 | `tests/e2e/**` |
| 2 | Track C (Sonnet) | `claude/dev-cycle-speed-unit-env`, from the same commit | 12 | `vitest.config.ts`, unit-test files' first lines, `scripts/unit-test-environment.test.ts` |
| 3 | Track A | `claude/dev-cycle-speed`, after merging B and C (merge, never cherry-pick) | 13–17 | anything |
| later | a new session | the merged branch | 18 | none |

- **Ports for browser tests:** Track A uses 5400, Track B 5500, and Track C 5600.
- **Running tests while you work:** run single test files directly: `npx vitest run <file>`, or `E2E_PORT=<port> E2E_WORKERS=2 npx playwright test <spec>`. A whole-suite or many-spec run goes through the gate, so that it queues behind other gates.
- **The gate at the end of a track:** each track runs `scripts/gates.sh agent` once, naming its specs.
- **Measured runs** are the release gates in Tasks 5 and 13–17. The session starts them itself. A run that doesn't count stays in the history and is run again later.
- **The session that wrote this plan orchestrates.** It starts the tracks, checks each track's branch and its `Speed-Task:` trailers before it trusts a report of "done", and runs the final review.
- **Dependencies in a new worktree:** when the lockfiles match, clone them from the main checkout:

  ```bash
  cmp -s package-lock.json <main>/package-lock.json && cp -cR <main>/node_modules ./node_modules
  ```

## Files

Create:
- `scripts/gates-measure.mjs`: reads what each suite cost, from Playwright's JSON report and from Vitest's log and JSON report.
- `scripts/gates-queue.mjs`: where the gate's state lives, and the lock that lets one heavy run go at a time.
- `scripts/gates-machine.mjs`: samples swap, free memory, the gate's priority and other test runs, then decides whether a run counts as measured.
- `scripts/gates-history.mjs`: the history file. It appends and reads entries, compares a run with the last release gate, and has a `report` command.
- `scripts/unit-test-selection.mjs`: which unit tests an agent run needs. `vitest.config.ts` reads it too.
- A test beside each new module: `scripts/gates-measure.test.ts`, `scripts/gates-queue.test.ts`, `scripts/gates-machine.test.ts`, `scripts/gates-history.test.ts` and `scripts/unit-test-selection.test.ts`.
- `scripts/unit-test-environment.test.ts`: the guard that keeps tests running in Node away from browser-only modules.
- `tests/e2e/sign-in.ts` and `tests/e2e/sign-in-helpers.spec.ts`: the two sign-in helpers, and their spec.
- `docs/plans/dev-cycle-speed/`: the baseline and the final results.

Modify:
- `scripts/gates.mjs`, `scripts/gates.test.ts` and `vitest.config.ts`;
- `tests/e2e/helpers.ts` and the sign-in specs;
- unit-test files, one comment line each;
- `AGENTS.md` and `tests/AGENTS.md`;
- the spec files that Task 13 splits.

---

## Phase 1: Track A

### Task 1: What each suite costs (spec §8, Part 0)

**Files:**
- Create: `scripts/gates-measure.mjs`, `scripts/gates-measure.test.ts`
- Modify: `scripts/gates.mjs` (`defineSteps` vitest command, `parseVitestLog`, `readPlaywrightReport`, `runSteps`, `main`), `scripts/gates.test.ts`, `tests/e2e/helpers.ts` (`login`)

**Interfaces:**
- Produces `playwrightTimings(report): { files: {file: string, ms: number}[], workers: {slot: number, endMs: number}[], tailMs: number, signInMs: number }`:
  - `files` is sorted slowest first. A file's time runs from its first test's start to its last test's end. Files run whole on one worker.
  - `slot` is `parallelIndex`, and `endMs` is measured from `report.stats.startTime`.
  - `tailMs` is the latest worker end minus the earliest worker end.
  - `signInMs` adds up every step, at any depth, whose title starts with `sign in`.
- Produces `vitestSplit(log: string): Record<string, number> | null`. These are the seconds in each part of Vitest's `Duration … (transform …, setup …, import …, tests …, environment …)` line, with `ms`, `s` and `m` units all read.
- Produces `slowestUnitFiles(report, n = 5): {file: string, ms: number}[]`. It reads `testResults[].{name, startTime, endTime}` from Vitest's JSON report and gives repo-relative names.
- The readers also count:
  - `readPlaywrightReport` returns `counts: { passed, failed, flaky, skipped, workers }`.
  - `parseVitestLog(log, code)` returns `counts: { files, tests }`, the totals in parentheses on Vitest's `Test Files` and `Tests` lines.
- `runSteps` copies a reader's `counts` onto the step's result.
- `summary.json` gains `cost: { playwright?, vitest?: { split, slowest } }`.

- [ ] **Step 1: Write the failing tests** in `scripts/gates-measure.test.ts`:
  - `"times each spec file from its first start to its last end, slowest first"`. The fixture has `a.spec.ts` with two results (0–2,000 ms, slot 0) and `b.spec.ts` with one (500–5,500 ms, slot 1). Then `files` equals `[{file:"b.spec.ts",ms:5000},{file:"a.spec.ts",ms:2000}]`.
  - `"says how long the first worker to finish sat idle before the run ended"`. On the same fixture, `tailMs` is `3500`.
  - `"adds up every sign-in step, nested or not"`. The steps are `sign in` (300 ms, top level), `sign in (form)` (900 ms, inside `setup`) and `open panel` (50 ms). `signInMs` is `1200`.
  - `"reads the worker-time split from Vitest's Duration line"`:
    - `"   Duration  240.31s (transform 123.40s, setup 73.10s, import 865.00s, tests 1237.00s, environment 741.00s)"` gives `{transform:123.4, setup:73.1, import:865, tests:1237, environment:741}`;
    - `"Duration  950ms (transform 120ms, setup 0ms, import 2.1s, tests 1m 3s, environment 0ms)"` gives `tests: 63`.
  - `"has no split when the log has no Duration line, rather than zeros"` returns `null`.
  - `"names the slowest unit-test files"`, from a JSON fixture with two files.

  And in `scripts/gates.test.ts`:
  - `"asks Vitest for its JSON report next to the log, on either schedule"`. For both schedules, the vitest command contains `--reporter=default`, `--reporter=json` and `--outputFile.json=<outDir>/vitest.json`. The phased schedule runs `npx vitest run`, which is what `npm test` runs.
  - `"shows the slowest spec files, the idle tail and sign-in time under the Playwright line"`. Run `readPlaywrightReport` on a fixture file. Its text has the lines `      slowest: b.spec.ts 5s, a.spec.ts 2s` (at most five files, slowest first) and `      workers: 2, the first idle 3s before the end; sign-in 1s in all`.
  - `"adds the worker-time split to the Vitest line"`. The text ends with `; worker time: tests 1237s, import 865s, environment 741s, transform 123s, setup 73s`.
- [ ] **Step 2:** Run `npx vitest run scripts/gates-measure.test.ts scripts/gates.test.ts`. Expected: the new tests fail.
- [ ] **Step 3: Implement** the three readers, and use them in `readPlaywrightReport`, `parseVitestLog` and `main`:
  - `main` reads `vitest.json` and `playwright.json` from the out-dir. If a file is missing or can't be read, its part is left out.
  - Wrap `login()`'s current body in `test.step("sign in", …, { box: true })`.
- [ ] **Step 4:** Run the two test files again. Expected: PASS. Then run `npm run build && E2E_PORT=5400 E2E_WORKERS=2 npx playwright test tests/e2e/login.test.ts tests/e2e/auth.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message "Let the gate report what each suite cost, file by file".

### Task 2: One heavy gate at a time (Part 4, moved forward)

The queue moves ahead of its place in spec §9, because Phase 2's two sessions run gates at the same time. It also lives in `gates.mjs`, the file this track owns.

**Files:**
- Create: `scripts/gates-queue.mjs`, `scripts/gates-queue.test.ts`
- Modify: `scripts/gates.mjs` (`main`, `shutDown`, the header), `scripts/gates.test.ts`, `AGENTS.md`

**Interfaces:**
- `gateStateDir(root: string, env = process.env): string | null`. It returns `env.ALFYAI_GATE_STATE_DIR` when that is set (tests set it). Otherwise it returns `<resolve(root, git rev-parse --git-common-dir)>/alfyai-gates`, or `null` when git fails.
- `takesTheQueue(args): boolean`. True when any of `check`, `vitest`, `build` or `playwright` is still in the run after `--skip`.
- `isGateProcess(pid: number): boolean`. True when the process is alive and `ps -o command= -p <pid>` contains `gates.mjs`.
- `acquireGateLock({ dir, holder, isGate = isGateProcess, sleep, now = Date.now, log = console.log, pollMs = 5000, maxWaitMs = 45 * 60_000 })` resolves to one of:
  - `{ held: true, waitedMs, release() }`;
  - `{ held: false, waitedMs, reason }`.

  How it works:
  - `holder` is `{ pid, mode, worktree, head, since }`.
  - The lock is `<dir>/gate.lock`, created with `writeFileSync(path, json, { flag: "wx" })`.
  - A lock file that can't be parsed is taken over once its mtime is more than 10 s old; until then, the gate waits one poll.
  - `release()` removes the lock only while it still names this process.
- `summary.json` gains `queue: { held, waitedMs, reason? }`.

The exact lines it prints:
- While waiting, at most once a minute: `queue: waiting for the <mode> gate in <worktree, with ~ for $HOME> (process <pid>), running <m>m<ss>s`.
- When it takes over: `queue: the lock of process <pid> is stale (no gate runs as that process); taking it`.
- When it fails open: `queue: could not take the lock (<reason>); running anyway`. After 45 minutes of waiting, the reason is `waited 45m for process <pid>`.
- In the header, after the `machine:` line, one of:
  - `queue: held`
  - `queue: held (waited 3m12s)`
  - `queue: not taken: <reason>`
  - `queue: not needed (no heavy step)`

- [ ] **Step 1: Write the failing tests** in `scripts/gates-queue.test.ts`. They use temp dirs, a fake clock, an instant `sleep`, and a stand-in for `isGate`.
  - `"takes a free lock and gives it back"`. `held` is true, and the lock file names the holder. After `release()`, the file is gone.
  - `"waits while a live gate holds it, says whose run it waits for and for how long, then takes it"`. The holder is alive for three polls. Expect `waitedMs` 15000, and a log line matching `/^queue: waiting for the release gate in .* \(process 4242\), running /`.
  - `"takes over a lock whose process is no gate"`. With `isGate` false, the lock is held at once and the log says it was stale.
  - `"takes over a half-written lock older than ten seconds, and waits on a fresh one"`.
  - `"runs anyway, and says why, when the lock cannot be written"`. `dir` sits under a regular file. Expect `held` false and a `reason` that names the error code.
  - `"stops waiting after 45 minutes and runs anyway, saying so"`.
  - `"never removes a lock another gate holds"`.
  - `"keeps the state in the repository's shared git directory, from a worktree too"`. Make a temp repo and a `git worktree add`. Both give `<repo>/.git/alfyai-gates`.

  And in `scripts/gates.test.ts`: `"a run of only Fallow, Biome, the migration check or the chunk check does not queue"`.
- [ ] **Step 2:** Run the two test files. Expected: FAIL.
- [ ] **Step 3: Implement.** In `main`, take the lock after the out-dir is made and before the steps start. Release it in a `finally`, and in `shutDown`.
- [ ] **Step 4:** Run the two test files again. Expected: PASS.
- [ ] **Step 5: Add one sentence to AGENTS.md "Mandatory Verification":** "Gates take turns: `scripts/gates.sh` waits while another gate on this Mac runs a heavy step (the lock is in the shared git directory, so Claude and Codex worktrees share it), and runs anyway, saying so, when it cannot take the lock. A whole-suite or many-spec test run goes through the gate; a single test file does not need to."
- [ ] **Step 6: Commit**, with the message "Let gates on this Mac take turns instead of fighting for it".

### Task 3: The Mac during a run, and what counts as measured (Part 0)

**Files:**
- Create: `scripts/gates-machine.mjs`, `scripts/gates-machine.test.ts`
- Modify: `scripts/gates.mjs` (`main`, `summarise`), `scripts/gates.test.ts`

**Interfaces:**
- Consumes Task 2's queue result.
- `parseSwapUsedMb(text: string): number | null` reads the output of `sysctl -n vm.swapusage`.
- `otherTestRuns(psText: string, ownPid: number): {pid: number, command: string}[]`:
  - It parses `ps -axo pid=,ppid=,command=`.
  - A test run is a command that matches `/\bvitest\b/` or `/\bplaywright(\.js)?\s+test\b/` and does not match `/@playwright\/mcp|playwright-mcp/`.
  - Processes inside `ownPid`'s own tree are left out.
- `probeMachine(pid): { swapMb, freeMb, priority, others }`:
  - `swapMb` comes from `sysctl`, `freeMb` from `os.freemem()`, `priority` from `ps -o pri= -p <pid>`, and `others` from `otherTestRuns`.
- `startMachineSampler({ pid = process.pid, intervalMs = 5000, probe = probeMachine, now = Date.now } = {})` returns `{ stop(): MachineReport }`:
  - It samples once at the start, then every interval.
  - `MachineReport` is `{ samples, swapStartMb, swapPeakMb, freeLowMb, priorityStart, priorityLowest, clampedMs, others: string[] }`.
  - A sample is clamped when its priority is below 31. Each interval that ends on a clamped sample adds to `clampedMs`.
- `measuredVerdict(machine, queue): { counts: boolean, why: string[] }`.
- `machineLines(machine, measured): string[]` prints these lines:
  - `mac: priority 31 throughout; swap 0 MB at start, 0 MB at peak; free memory down to 1.4 GB`
  - when clamped: `mac: CLAMPED to priority 4 for 3m10s (efficiency cores only: the Claude app was not in front); swap …`
  - `measured: yes`, or `measured: no (<reasons joined by "; ">)`. The reasons are:
    - `the queue was not held`
    - `another test run was going: <command cut to 60 characters>`
    - `clamped for 3m10s`
    - `512 MB of swap in use at the start`
- `summarise({ …, extraLines = [] })` prints `extraLines` after the step lines and before the `total` line.
- `summary.json` gains `machine` and `measured`. The sampler starts after the queue is held, and stops when the steps end.

- [ ] **Step 1: Write the failing tests:**
  - `"reads swap in use from sysctl's line"`:
    - `"total = 2048.00M  used = 1234.50M  free = 813.50M  (encrypted)"` gives `1234.5`;
    - `"total = 0.00M  used = 0.00M  free = 0.00M  (encrypted)"` gives `0`;
    - an unreadable line gives `null`.
  - `"sees another session's vitest or Playwright run, and not this gate's children or the Playwright MCP server"`. The `ps` fixture has:

    | pid | ppid | command | counted |
    |---|---|---|---|
    | 100 | | the gate | |
    | 101 | 100 | `node …/vitest/vitest.mjs run` | no |
    | 200 | | `node /x/node_modules/.bin/playwright test` | yes |
    | 300 | | `npm exec @playwright/mcp --idle-timeout 0` | no |
    | 301 | | `node …/playwright-mcp --idle-timeout 0` | no |
    | 400 | 399 | `node …/vitest/dist/workers/forks.js` | yes |

  - `"keeps the peak swap, the lowest free memory and how long the gate was clamped"`. Four samples 5 s apart, at priorities 31, 4, 4, 31, give `clampedMs` 10000 and `priorityLowest` 4.
  - `"a run counts as measured only alone, unclamped, with no swap at the start and the queue held"`. One case passes. Breaking each condition on its own gives `counts` false, with exactly that condition's reason.
  - In `gates.test.ts`: `"prints the mac and measured lines after the step lines and before the total"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5: Commit**, with the message "Make a gate say when the Mac held it back".

### Task 4: Gate history (Part 0)

**Files:**
- Create: `scripts/gates-history.mjs`, `scripts/gates-history.test.ts`
- Modify: `scripts/gates.mjs` (`main`), `scripts/gates.test.ts`

**Interfaces:**
- Consumes: `gateStateDir` (Task 2); `MachineReport` and `measuredVerdict` (Task 3); `cost` and the step `counts` (Task 1).
- `historyEntry({ mode, head, branch, worktree, startedAt, endedAt, passed, results, cost, machine, measured, queue, selection })` returns:

  ```
  { v: 1, at, mode, head, branch, worktree, totalMs, passed,
    steps: { <name>: { ms, ok } | { skipped } | { blocked } | { stopped } },
    counts: { e2e?, unitFiles?, unitTests? },
    cost, machine, measured, queue, selection? }
  ```

  Task 8 fills in `selection`.
- `appendHistory(dir: string | null, entry): string | null` adds one line to `<dir>/history.jsonl`. It never throws. When it can't write, it returns `history: not written (<reason>)`.
- `readHistory(dir): object[]` skips lines that don't parse.
- `previousRelease(entries, beforeAt: string)` returns the latest `release` entry whose `at` is earlier than `beforeAt`.
- `comparisonLines(entry, previous): string[]` gives:
  - `before: release gate at 652f7f3 on 2026-11-20 14:02 took 15m40s (passed); this one 9m50s (-5m50s)`
  - `e2e tests 1,731 -> 1,745 (+14); unit tests 29,578 -> 29,610 (+32)`
  - `steps: playwright 16m00s -> 8m10s, vitest 3m50s -> 2m10s`
  - or, with no earlier release gate: `before: no earlier release gate in the history`
- `historyReport(entries, { days = 7, now = Date.now() }): string[]`. For each mode it gives:
  - the number of runs, the share that passed, and the median total;
  - clamped runs against unclamped ones: count, share, median total and failures;
  - the number of measured runs.
- A command-line entry: `node scripts/gates-history.mjs report [--days N]` prints `historyReport` for the shared directory.
- In `main`, a release gate reads the history before appending, then adds the comparison lines to `extraLines`. A `history: not written …` note goes there too.

- [ ] **Step 1: Write the failing tests:**
  - `"appends one line per run and reads them back, skipping a broken line"`.
  - `"compares a release gate with the one before it: time, test counts and the two slow steps"`, which checks the exact lines above.
  - `"says when there is no earlier release gate"`.
  - `"the report counts clamped gates, and how much slower and more often failing they were"`. Take four entries: two clamped (20 min failed, 18 min passed) and two not (10 and 11 min, both passed). The report contains `clamped: 2 of 4 runs (50%), median 19m00s, 1 of 2 failed; unclamped: median 10m30s, 0 of 2 failed`.
  - `"never fails the gate when the history cannot be written"`.
  - In `gates.test.ts`: `"a release gate's summary shows the comparison before the total"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5: Commit**, with the message "Keep every gate's numbers where every worktree can read them".

### Task 5: The baseline release gate (Part 0)

**Files:**
- Create: `docs/plans/dev-cycle-speed/baseline-release.txt`, a copy of the run's `summary.txt`.
- Create: `docs/plans/dev-cycle-speed/baseline-costs.json`, the run's `summary.json` `cost` field.

- [ ] **Step 1:** Check that nothing heavy is running: `pgrep -fl 'vitest|playwright test|gates.mjs' | grep -v mcp` prints nothing.
- [ ] **Step 2:** Run `scripts/gates.sh release "$TMPDIR/speed-baseline" --port 5400` in the background, and wait for its exit notification. Don't poll.
- [ ] **Step 3:** The summary must show `measured: yes` and `ALL GATES PASSED`.
  - If it shows `measured: no`, carry on with Task 6, and run this gate again once the reason has passed. The baseline has to exist before Task 13 merges Tracks B and C, but not before Task 6.
  - If tests fail, find the cause under AGENTS.md's flaky-test rule before running again.
- [ ] **Step 4: Commit** the two files, with the message "Record what the release gate costs before the speed work".

### Task 6: Choosing unit tests from a change (Part 1)

The spec names `vitest run --changed <base>`. This plan gets the same result a different way:
- Vitest's own file filters can only narrow a `--changed` run, so `--changed` can't add the always-run set.
- Instead, the gate lists the changed files itself, with the same git commands Vitest uses.
- It then passes those files, plus the always-run set, to `vitest related`.
- `related` follows the same imports, with the same cost (measured at 14 s), and the triggers still apply to it.

**Files:**
- Create: `scripts/unit-test-selection.mjs`, `scripts/unit-test-selection.test.ts`
- Modify: `vitest.config.ts` (`include`, `exclude` and `forceRerunTriggers`, all from the new module)

**Interfaces:**
- `UNIT_TEST_INCLUDE` is `["src/**/*.test.ts", "scripts/**/*.test.ts", "tests/integration/**/*.test.ts", "tests/cross-cutting/**/*.test.ts"]`, and `UNIT_TEST_EXCLUDE` is `["tests/e2e/**"]`.
- `FULL_RUN_TRIGGERS` is the list in Global Constraints. `vitestForceRerunTriggers(): string[]` prefixes each entry with `**/`.
- `isUnitTestFile(path: string): boolean` tests a repo-relative path with `path.matchesGlob` against the include and exclude lists.
- `unitTestFiles(root): string[]` is `git ls-files --cached --others --exclude-standard`, filtered by `isUnitTestFile`.
- `changedSince(root, base)` returns `{ mergeBase, changed: string[], deletedOrRenamed: string[] }`, or `{ error }`:
  - The merge-base is `git merge-base HEAD <base>`.
  - It gathers changes from `git diff --name-status -M <mergeBase> HEAD`, `git diff --cached --name-status -M`, `git diff --name-status -M` and `git ls-files --others --exclude-standard`.
  - `changed` holds every path that exists now: added, modified, the new name of a rename, and untracked files.
  - `deletedOrRenamed` holds deleted paths and the old names of renames.
- `chooseUnitTests({ changes, alwaysRun, base })` returns one of:
  - `{ kind: "all", reason }`;
  - `{ kind: "related", paths, changed: number, alwaysRun: number, base, mergeBase }`.

  It decides in this order:
  1. `changes.error` gives `all`, with the reason `no merge-base with <base> (<error>)`.
  2. A changed or deleted path that matches a trigger gives `all`, with the reason `<path> changed`.
  3. A deleted or renamed file that is not a test gives `all`, with the reason `<path> was deleted or renamed`.
  4. Otherwise it gives `related`. `paths` is the changed files plus `alwaysRun`, without duplicates and sorted.
- `vitest.config.ts` uses `include: UNIT_TEST_INCLUDE`, `exclude: UNIT_TEST_EXCLUDE` and `forceRerunTriggers: vitestForceRerunTriggers()`. Nothing else in it changes in this task.

- [ ] **Step 1: Write the failing tests.** Each runs in a temp git repo: `git init -b main`, one commit of `src/a.ts`, `src/a.test.ts`, `src/b.ts`, `src/c.ts` and `package.json`, then a `feature` branch.
  - `"lists what changed since the merge-base: committed, staged, unstaged and untracked"`. On `feature`, commit a change to `src/a.ts`, stage `src/b.ts`, edit `src/c.ts` without staging, and add an untracked `src/d.ts`. Meanwhile `main` gets a commit that touches `src/z.ts`. Expect `changed` to be `["src/a.ts","src/b.ts","src/c.ts","src/d.ts"]`.
  - `"notes deleted and renamed files apart"`.
  - `"runs every unit test when a trigger changed, and names it"`. Check this for each of `package-lock.json`, `src/vitest-setup.ts`, `drizzle/0007_x.sql` and `vitest.config.ts`.
  - `"runs every unit test when a source file was deleted or renamed, and names it"`. Deleting a test file on its own does not count.
  - `"runs every unit test when the base has no merge-base with HEAD"`. With base `no-such-ref`, the reason starts with `no merge-base with no-such-ref`.
  - `"otherwise runs the changed files and the always-run set"`.
  - `"knows a unit-test file the way vitest.config.ts includes it"`:
    - true for `src/x/y.test.ts`, `src/y.test.ts`, `scripts/gates.test.ts` and `tests/integration/z.test.ts`;
    - false for `tests/e2e/a.test.ts`, `src/a.ts` and `tests/mocks/a.test.ts`.
  - `"vitest.config.ts takes its include list and its full-run triggers from this module"`. The config's text contains `include: UNIT_TEST_INCLUDE` and `forceRerunTriggers: vitestForceRerunTriggers()`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them again. Expected: PASS. Then run `npx vitest list --filesOnly | wc -l`: it still counts 1,507 files.
- [ ] **Step 5: Commit**, with the message "Work out which unit tests a change can reach".

### Task 7: The always-run set (Part 1)

**Files:**
- Modify: `scripts/unit-test-selection.mjs` and its test.
- Add a marker comment to every unit-test file that reads files or starts processes: 179 files today, by the regex below.

**Interfaces:**
- `alwaysRunFiles(root): string[]` gives the unit-test files whose text matches `/^\s*\/\/\s*@always-run:/m`.
- The marker rule:
  - `// @always-run: <what it reads or runs that it does not import>`. Use it when the file reads or runs anything in the repo that it doesn't import: source files it scans, `AGENTS.md`, the i18n tables, fixtures, migrations, or a script it starts.
  - `// @self-contained: <why>`. Use it when everything the file reads or runs is something it made during the test (a temp dir, a file it wrote, a git repo it set up), or lies outside the repo.
  - The marker goes on its own line, above the first import.
  - This is a call the plan makes. The spec lets a test that reads only its own fixtures go unmarked. This plan marks such a test `@always-run` when its fixtures are files in the repo, because otherwise a change to a fixture alone would run nothing.
- The regex for "reads files or starts processes": `/\b(?:readFileSync|readFile|readdirSync|readdir|statSync|opendirSync|globSync|spawnSync|spawn|execSync|execFileSync|execFile|fork)\s*\(|(?<!meta\.)\bglob\s*\(/`.

- [ ] **Step 1: Write the failing tests:**
  - `"every unit test that reads files or starts processes says whether an agent run must always include it"`. It checks every file from `unitTestFiles(root)`. Its failure message lists each file with the fix: `add "// @always-run: <what it reads>" or "// @self-contained: <why>"`. This test file carries `// @always-run: reads every unit-test file`.
  - `"the always-run set is the files that carry the marker"`, on a temp tree.
  - `"puts the gate's own tests, the i18n check and the tool-row words in the always-run set"`. The set includes `scripts/gates.test.ts`, `scripts/validate-i18n.test.ts`, `src/lib/utils/tool-reason-words.test.ts` and `scripts/unit-test-selection.test.ts`.
- [ ] **Step 2:** Run the tests. Expected: the first test fails and lists about 180 files.
- [ ] **Step 3:** Read each listed file, decide which marker fits, and add it. You may split this work among subagents by directory.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run the always-run set on its own: `npx vitest run <the files alwaysRunFiles lists>`. Note its wall time in the commit message, since every agent run carries it.
- [ ] **Step 5: Commit**, with the message "Mark the unit tests a change can reach without importing them".

### Task 8: Agent runs run the chosen unit tests (Part 1)

**Files:**
- Modify: `scripts/gates.mjs` (`parseArgs`, `main`, `defineSteps`, `parseVitestLog`), `scripts/gates.test.ts`, `AGENTS.md`

**Interfaces:**
- Consumes `chooseUnitTests`, `changedSince`, `alwaysRunFiles` and `unitTestFiles` (Tasks 6 and 7).
- `parseArgs` gains `base` (default `"origin/main"`, set with `--base <ref>`) and `allUnitTests` (set with `--all-unit-tests`).
- `main` sets `args.unitSelection` before `defineSteps`:
  - a release gate gets `{ kind: "all", reason: "release gate" }`;
  - `--all-unit-tests` gets `{ kind: "all", reason: "--all-unit-tests" }`;
  - an agent run gets `chooseUnitTests(…)`.

  The selection is also written to `<outDir>/unit-selection.json`, and goes into the history entry.
- The vitest command:
  - for `related`: `["npx","vitest","related","--run", …reporterArgs, …paths]`;
  - for `all`: `["npx","vitest","run", …maxWorkers on overlap, …reporterArgs]`.
- `parseVitestLog(log, code = 0, { selection, total } = {})`. `defineSteps` binds `selection` and `total` (`unitTestFiles(ROOT).length`). The text reads, exactly:
  - `files 52 passed (52) of 1,507; tests 1,204 passed (1,204); chose: 31 changed since 652f7f3 and 48 always-run`
  - `…; chose: all (package-lock.json changed)`
  - `…; chose: all (release gate)`
  - When the log says `No test files found` and the exit code is 0, the step passes with `files 0 of 1,507; chose: …`.

- [ ] **Step 1: Write the failing tests:**
  - `"an agent run's Vitest step runs the related files and the always-run set"`.
  - `"runs every unit test on a release gate, with --all-unit-tests, or when the selection says all"`.
  - `"says how many unit-test files ran, of how many, and why"`, which checks the exact lines above.
  - `"passes a run that found no related test file, and says so"`.
  - `"takes --base and --all-unit-tests"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5: Prove the always-run set works, with uncommitted scratch changes in this worktree.**
  - Add `t("speedcheck.planted")` to one component, without adding the key.
  - Add a new reason code with no words to one tool's server file.
  - For each change, run `scripts/gates.sh agent "$TMPDIR/speed-plant" --port 5400 --skip check,biome,migrations,build,chunks,fallow,playwright`. The vitest line must show that the always-run test catching it ran (`scripts/validate-i18n.test.ts` or `src/lib/utils/tool-reason-words.test.ts`), and the step must fail on it.
  - Undo each change with `git checkout -- <file>`.
- [ ] **Step 6: Prove the fallback.** Add a comment to `vitest.config.ts` and run the same command. The line must say `chose: all (vitest.config.ts changed)`. Undo the comment.
- [ ] **Step 7: Update AGENTS.md "Mandatory Verification":**
  - Where the opening paragraph describes the vitest part of an agent run, say: an agent run runs the unit tests its change can reach (files changed since the merge-base with `origin/main`, or `--base <ref>`, followed through imports), plus every test marked `// @always-run:`. A change to the package files, the Vitest, Vite, Svelte or TS configs, the Vitest setup files or `drizzle/` runs them all, and so does `--all-unit-tests`.
  - Under "Name the specs that cover what you changed", add: "Don't name specs you didn't touch to be safe: the release gate runs them all."
- [ ] **Step 8: Commit**, with the message "Run an agent's unit tests by what its change can reach".

### Task 9: Fail fast in agent runs (Part 1)

**Files:**
- Modify: `scripts/gates.mjs` (`parseArgs`, `runSteps`, `runCommand`, `summarise`), `scripts/gates.test.ts`, `AGENTS.md`

**Interfaces:**
- `FAIL_FAST_STEPS = ["check","biome","migrations","fallow","build"]`.
- `parseArgs` gains `failFast`. It is true by default for agent runs, false with `--no-fail-fast`, and always false for a release gate.
- `run(step, name, outDir, signal: AbortSignal)`. On abort, it sends SIGINT to the step's process group, then SIGKILL after 8 s. It resolves with `{ code, startedAt, endedAt, logPath, stopped: true }`.
- A step's result may be `{ stopped: "<first failed step> failed" }`, whether it never started or was stopped part-way. The summary:
  - prints the line `vitest     stop not finished: check failed`;
  - gives the verdict `FAILED: check (stopped: vitest, playwright)`;
  - exits with code 1.

- [ ] **Step 1: Write the failing tests.** Extend the `gate()` stand-in so that a step can wait on its signal.
  - `"stops the steps still running when a static step fails, and starts none after"`.
  - `"a failing Vitest or Playwright step stops nothing"`.
  - `"--no-fail-fast runs every step to its end, as before"`.
  - `"a release gate never stops early"`.

  The existing test `"does not start the steps that wait for a build that failed"` must still pass unchanged: those steps are blocked, not stopped.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them again. Expected: PASS.
- [ ] **Step 5:** Add one sentence to AGENTS.md: "In an agent run, a failed typecheck, lint, migration check, Fallow or build stops the steps still running (`--no-fail-fast` runs them all anyway); the release gate always runs everything."
- [ ] **Step 6: Commit**, with the message "Stop an agent's gate at the first static failure".
- [ ] **Step 7: The end of Phase 1.** Run `scripts/gates.sh agent "$TMPDIR/speed-a1" --port 5400 tests/e2e/login.test.ts`. Expected: `ALL GATES PASSED`, and a vitest line that shows a chosen set. Report to the orchestrator with the commit SHA.

---

## Phase 2: Tracks B and C, side by side

### Task 10 (Track B): Sign in with a session (Part 2)

**Files:**
- Create: `tests/e2e/sign-in.ts`, `tests/e2e/sign-in-helpers.spec.ts`
- Modify: `tests/e2e/helpers.ts`. Delete the body of `login()` there, and re-export `login`, `loginThroughForm`, `TEST_EMAIL` and `TEST_PASSWORD` from `./sign-in`.

**Interfaces:**
- `tests/e2e/sign-in.ts` owns `TEST_EMAIL` and `TEST_PASSWORD`, and imports nothing from `helpers.ts`. A cycle between the two would be Fallow's fifth, which fails the gate.
- `login(page: Page, email = TEST_EMAIL, password = TEST_PASSWORD): Promise<void>`. Its signature and its end state are unchanged: on `/`, with the composer visible and enabled within 15 s. Inside `test.step("sign in", …, { box: true })`, it:
  1. finds the user by email in this worker's database (`db` from `../../src/lib/server/db`, `users` from its schema);
  2. checks the password with `verifyPassword` from `../../src/lib/server/services/auth`, caching the answer for the worker under the user's id, the password hash and the password;
  3. refuses the account if `isTwoStepEnabled(user.id)` (from `../../src/lib/server/services/two-step/store`) is true;
  4. calls `createSession(user.id, { rememberMe: false })`, which is what today's API call does without remember-me;
  5. calls `page.context().addCookies([{ name: "session", value: token, url: e2eBaseUrl(e2eSlot()), httpOnly: true, sameSite: "Lax", expires: Math.floor(expiresAt.getTime() / 1000) }])`;
  6. calls `page.goto("/", { waitUntil: "domcontentloaded" })`, then waits for the composer to be visible and enabled.
- The exact errors:
  - `` `login(): no account with the email ${email} in this worker's database` ``
  - `` `login(): ${email} does not have that password; a test about passwords signs in with loginThroughForm()` ``
  - `` `login(): ${email} has two-step sign-in on; sign in through the code step, as two-step-sign-in.spec.ts does` ``
- `loginThroughForm(page: Page, email = TEST_EMAIL, password = TEST_PASSWORD): Promise<void>` is today's body: the `/login` page, the POST to `/api/auth/login`, then `/` and the composer. It runs inside `test.step("sign in (form)", …, { box: true })`.

- [ ] **Step 1: Write the failing spec** `tests/e2e/sign-in-helpers.spec.ts`:
  - `"login() lands on / with the composer ready, on a session the app's own hooks accept"`:
    - the admin has one more `sessions` row;
    - `page.request.get("/api/settings")` answers 200;
    - no request went to `/login` or `/api/auth/login` (watch with `page.on("request")`).
  - `"login() refuses a password the account does not have"`:

    ```ts
    await expect(login(page, TEST_EMAIL, "not-the-password")).rejects.toThrow("does not have that password");
    ```

  - `"login() refuses an account with two-step sign-in on"`. Turn two-step on for a new user the way `two-step-sign-in.spec.ts` does: make the user with `/api/admin/users`, then call its `turnOn()`. Or use the confirm call in `src/lib/server/services/two-step/store.ts`.
  - `"loginThroughForm() signs in through /login and the API, as before"`. A POST to `/api/auth/login` gets 200, and the composer is enabled.
- [ ] **Step 2:** Run `npm run build && E2E_PORT=5500 E2E_WORKERS=2 npx playwright test tests/e2e/sign-in-helpers.spec.ts`. Expected: FAIL, because the module doesn't exist yet.
- [ ] **Step 3: Implement** `sign-in.ts`, and switch `helpers.ts` to the re-exports.
- [ ] **Step 4:** Run the new spec with `login.test.ts` and `auth.spec.ts`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message "Sign browser tests in with a session instead of the form".

### Task 11 (Track B): Decide which specs need the form (Part 2)

**Files:** Modify only the specs that need the form.

**The rule:**
- A call becomes `loginThroughForm()` when its test is about signing in or out. That covers the login page, the auth API, wrong passwords, rate limits, two-step sign-in, remember-me, session expiry, redirects to `/login`, and signing back in after a sign-out when that is the thing under test.
- Every other call keeps `login()`.
- A file that posts to `/api/auth/*` itself stays as it is.

**The files to read,** from `grep` on 2026-11-23:
- 16 files call `login()` with more arguments than the page: artifact-panel-motion, artifact-panel-rows, artifact-tours, artifact-tours-admin, artifact-tours-helpers.ts, chat-header-room, campaign-audience, feature-guide, images-switch, feature-note, images, phone-polish, project-panel-over-dialog, read-aloud-voices, sidebar-multi-select and two-step-sign-in.
- 15 files touch the auth API, the form or `logout()`: admin-system-screenshots, artifact-canvas-live, artifact-tours-helpers.ts, atlas-job-flow, auth, document-type, full-user-journey, knowledge-sidebar-clipping, login, project-panel-over-dialog, perf-load, settings-connections, settings-admin-system, two-step-sign-in and zz-capture-hover.

Steps:
- [ ] **Step 1:** Apply the rule to each file. The commit message lists each file you switched with a one-line reason, and each file you kept with the reason it's safe.
- [ ] **Step 2:** Leave the `@smoke` test "submitting valid credentials redirects to main app" in `login.test.ts` alone. It goes through the real form and is the smoke set's form sign-in.
- [ ] **Step 3:** Run `scripts/gates.sh agent "$TMPDIR/speed-b" --port 5500 <every file in the two lists>`. Expected: PASS.
- [ ] **Step 4:** `login()` changed for all 170 files, so run the whole suite once: `scripts/gates.sh release "$TMPDIR/speed-b-release" --port 5500`. It need not count as measured. Expected: PASS.
- [ ] **Step 5: Commit.** Report the branch's tip SHA to the orchestrator.

### Task 12 (Track C): Unit tests run in Node unless they need a browser (Part 3)

The spec leaves a choice: per-file comments or two Vitest projects. This plan picks per-file comments, for three reasons:
- One Vite server, where two projects would start two.
- Each file says what it needs.
- 74 files already pick their environment this way.

**Files:**
- Create: `scripts/unit-test-environment.test.ts`, which carries `// @always-run: reads every unit-test file and the modules they import`.
- Modify: `vitest.config.ts` (`environment: 'node'`).
- Modify: each unit-test file the guard names. Its first line becomes exactly `// @vitest-environment jsdom`.

**Interfaces:**
- These rules are the guard's own; nothing is exported. A file runs in Node unless its text contains `@vitest-environment jsdom` or `happy-dom`.
- A file that runs in Node must not reach a browser-only module. The guard follows:
  - static `import` and `export … from` statements, and `import("literal")` (but not `import type`);
  - `$lib/` as `src/lib/`, and relative paths;
  - the extensions `.ts`, `.js`, `.svelte.ts` and `.svelte.js`, and `/index.ts` and `/index.js`.
- A module is browser-only when it:
  - is a `.svelte`, `.svelte.ts` or `.svelte.js` file;
  - imports `svelte` or `svelte/*`, `$app/*`, `esm-env` or `@testing-library/*`;
  - contains `typeof window`, `typeof document`, `typeof navigator`, `typeof localStorage`, `typeof sessionStorage`, `globalThis.window`, `globalThis.document` or `import.meta.env.SSR`.
- The test file itself must not use `document.`, `window.`, `navigator.`, `HTMLElement` or `customElements`.
- The failure message, one per file: `<file> runs in Node but reaches <module> (<rule>), which acts differently outside a browser: add "// @vitest-environment jsdom" as its first line`.
- **Resolve conditions, settled here.** Node files take Vite's `ssr` defaults, which is how server code runs in production. The top-level `resolve.conditions` keeps serving the jsdom files. Step 4 shows up any difference this makes.

- [ ] **Step 1: Record today's whole unit suite first:** `scripts/gates.sh agent "$TMPDIR/speed-c-before" --all-unit-tests --skip check,biome,migrations,build,chunks,fallow,playwright`. Keep its `vitest.json`.
- [ ] **Step 2: Write the guard's tests:**
  - `"finds a browser-only module through a $lib import, a relative import and an index file"`, on a temp tree;
  - `"leaves a file alone that says jsdom"`;
  - `"does not follow import type"`;
  - `"every unit test that runs in Node reaches no module that acts differently in a browser"`, on the real tree.

  Run them. Expected: the last test fails and names about 450 files.
- [ ] **Step 3: Switch.**
  - Add the pragma to every named file, with a throwaway script in the scratchpad (not committed).
  - Set `environment: 'node'` in `vitest.config.ts`.
  - Run the guard again. Expected: PASS.
- [ ] **Step 4: Compare.** Run the same command as Step 1 into `"$TMPDIR/speed-c-after"`. Compare the two `vitest.json` files with a throwaway script: the same files, the same tests in each file, and the same status for each test.
  - Any file that differs gets the pragma, and its reason goes in the commit message. In this task, a failure that only shows up in Node is never fixed by changing the test.
  - Repeat until the two runs match.
- [ ] **Step 5:** Put the `Duration` split from before and after in the commit message. Environment time should fall.
- [ ] **Step 6: Commit**, with the message "Run unit tests in Node unless they need a browser".
- [ ] **Step 7:** Run `scripts/gates.sh agent "$TMPDIR/speed-c" --port 5600 --all-unit-tests`. Expected: PASS. Report the branch's tip SHA to the orchestrator.

---

## Phase 3: Track A, after merging B and C

### Task 13: Re-measure, and split the long poles (Part 2)

**Files:** the merges; the spec files that get split and their helper modules; `tests/AGENTS.md`; `tests/e2e/quarantine.json`; snapshot folders; and every reference to a split file's old name.

- [ ] **Step 1:** Check that `docs/plans/dev-cycle-speed/baseline-release.txt` exists (Task 5).
- [ ] **Step 2: Merge** `claude/dev-cycle-speed-browser` and `claude/dev-cycle-speed-unit-env`. First confirm their `Speed-Task:` trailers for Tasks 10, 11 and 12, and check each branch with `git merge-base --is-ancestor`.
- [ ] **Step 3:** Run a measured release gate: `scripts/gates.sh release "$TMPDIR/speed-r1" --port 5400`. Compare it with the baseline:
  - the same tests ran, apart from the new tests in this branch;
  - sign-in time is down.
- [ ] **Step 4: The split rule.** When `tailMs` is over 90 s, look at each file still running after the first worker went idle. Split any such file longer than 3 minutes along its top-level `describe` blocks, into files of about 3 minutes or less:
  - Shared setup moves to `<name>-helpers.ts`, as `images-helpers.ts` does today.
  - No assertion changes.
  - `images-motion.spec.ts` is the likely first candidate, but the timeline decides.
- [ ] **Step 5: For each split, check nothing was lost.**
  - Run `npx playwright test --list` before and after. Sorted, the test titles must match one for one, and so must the count; only the file names differ.
  - Move the `<name>.spec.ts-snapshots/` files that the moved tests use.
  - Run `grep -rn "<old name>"` across `tests/`, `src/`, `scripts/`, `AGENTS.md`, `tests/AGENTS.md` and `docs/`, and update every hit: quarantine entries, convention tests, the guide's Show me table, the spec lists in AGENTS.md.
- [ ] **Step 6:** Run another measured release gate. Expected: the tail is under 90 s, or this step names the next file to split.
- [ ] **Step 6a: Decide on a `goto` option for `login()`** (spec §11). If sign-in is still more than 5% of the e2e step's worker time, bring the orchestrator the numbers and a proposal. Otherwise leave `login()` as it is.
- [ ] **Step 7:** Commit each split on its own.

### Task 14: Re-tune the workers and schedules (Parts 1–3)

**Files:**
- Modify: `tests/e2e/e2e-env.ts` (`DEFAULT_BUILD_WORKERS`), `scripts/gates.mjs` (the schedule defaults in `parseArgs`, and `vitestThreads`), `scripts/gates.test.ts` (`"the default schedule"`)

- [ ] **Step 1: Workers.** Compare six-browser, two-Vitest overlap with five-browser, three-Vitest overlap first. Use a seven-browser, one-Vitest overlap or eight-browser phased trial if the timing of the two lanes makes it a candidate. Record the effective allocations from each summary. Raise the default only if the run is faster, passes, and swap stays at 0.
- [ ] **Step 2: The release schedule.** Keep `overlap` if, in Task 13's runs and this one, vitest finished within the e2e step and no unit test timed out. Otherwise choose `phased`.
- [ ] **Step 3: The agent schedule.** Make three scratch changes: a server-only change, a component change, and an i18n string change. Run each under `phased` and under `overlap`, and make the faster the default.
- [ ] **Step 4:** Update the defaults and the `"the default schedule"` tests. Above each changed default, a comment gives the measurements it rests on. Run `npx vitest run scripts/gates.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit**, with the message "Tune the gate's workers and schedules to the lighter suites".

### Task 15: Leave the owner room (Part 4)

**Files:**
- Modify: `scripts/gates.mjs` (a `CAPS` constant, and the header line), `scripts/gates.test.ts`
- Modify: `scripts/gates.sh`, only if `nice` earns its place

- [ ] **Step 1: Set the caps** from the history's samples of the runs since Task 5.
  - Cap vitest's workers with `--maxWorkers`, on both schedules. Cap the e2e workers too.
  - The goal: no measured run swaps, and at least two performance cores stay free while check, vitest and the e2e run overlap.
  - Put the evidence in a comment above `CAPS`. The header line shows the caps.
- [ ] **Step 2:** Write the test `"passes the Vitest worker cap on both schedules"`. Run it. Expected: PASS.
- [ ] **Step 3: Try `nice`.** Run a measured release gate as `nice -n 10 scripts/gates.sh release …` and compare it with the last measured run. Keep it only if both hold:
  - the run is no more than 5% slower;
  - no timing-sensitive spec failed (the motion and read-aloud specs).

  If you keep it, `scripts/gates.sh` runs `exec nice -n 10 node …`, and the header says `nice 10`. Never use `taskpolicy -b`.
- [ ] **Step 4: Commit**, with the numbers in the message.

### Task 16: Keep it fast, and write down the rules (Parts 5–6)

**Files:**
- Modify: `scripts/gates.mjs` (the target flag, and the header comment), `scripts/gates.test.ts`, `AGENTS.md`, `tests/AGENTS.md`
- Modify the memory note `alfyai-dev-process-speed.md` after Task 17.

**Interfaces:**
- `RELEASE_TARGET_MS = 10 * 60_000`.
- When a release gate goes over the target, its `total` line ends with `; OVER THE 10-MINUTE TARGET`, or with `; over 10 minutes, but not a measured run` when it doesn't count as measured. Neither changes the verdict or the exit code.

- [ ] **Step 1: Write the failing tests:** `"flags a release gate over ten minutes on its total line, and still passes it"` and `"never flags an agent run"`. Run them. Expected: FAIL.
- [ ] **Step 2: Implement.** Run the tests. Expected: PASS.
- [ ] **Step 3: AGENTS.md "Mandatory Verification":**
  - what an agent run selects, and when it falls back to everything;
  - fail fast;
  - the release gate as the only full check, run before anything is pushed or deployed;
  - the queue and the caps;
  - the 10-minute target. A run that goes over is fixed in the change that caused it, or in the next one.

  Keep the Fallow-alone command exactly as it is. `scripts/gates.test.ts` checks it.
- [ ] **Step 4: `tests/AGENTS.md`:**
  - the two sign-in helpers, and when to use which;
  - the rule for new browser tests, word for word from spec §8 Part 5;
  - how to split a spec file: Task 13's rule and its checklist.
- [ ] **Step 5: The header comment of `scripts/gates.mjs`:** the modes, selection, fail fast, the queue, the history, and measured runs.
- [ ] **Step 6:** Run `npm run check` and `npx biome check src scripts tests`. Expected: clean. **Commit.**

### Task 17: The final runs, the review, and the handoff (spec §10)

**Files:**
- Create: `docs/plans/dev-cycle-speed/results.md`

- [ ] **Step 1:** Run three measured release gates. Each must:
  - take 10 minutes or less;
  - run the baseline's tests plus the ones added since;
  - not grow swap.
- [ ] **Step 2:** Start a second gate while one of them runs. It must wait, and say whose run it is waiting for.
- [ ] **Step 3:** Run three sample agent runs: a server-only change, a component change, and an i18n string change. They should average about 2 minutes.
- [ ] **Step 4:** Repeat the checks from Task 8, Steps 5 and 6: the planted breaks fail, and a config change runs everything.
- [ ] **Step 5:** Write `results.md`:
  - a table of the baseline against the final runs;
  - the sample agent runs;
  - what each part bought.
- [ ] **Step 6: The review.** A fresh Opus agent reviews the whole branch from the code alone, not from these conclusions. Fix what it finds, then run one final agent gate.
- [ ] **Step 7:** Bring the owner the results and the merge decision. Nothing is pushed.

## Later

### Task 18: A week on, and two weeks on (Part 4 and spec §10)

- [ ] **Step 1: Count the clamp.** A week after the merge, run `node scripts/gates-history.mjs report --days 7`. If clamped gates are 10% or more of all runs, or fail noticeably more often, bring the owner the numbers and two candidate fixes:
  - App Nap off for the Claude app: `defaults write com.anthropic.claudefordesktop NSAppSleepDisabled -bool YES`, undone with `defaults delete com.anthropic.claudefordesktop NSAppSleepDisabled`;
  - a launchd job that runs gates outside the app's process tree.

  The owner makes any change. A controlled test then confirms that the clamp has lifted: priority 31 with the app hidden. After that, run one measured release gate with Task 15's caps and priority in place.
- [ ] **Step 2: Check Codex.** The history should hold a gate run from a `~/.codex/worktrees/` path that either held the lock or said why it couldn't.
- [ ] **Step 3: Two weeks on,** compare the weekly gate hours and the release gate's failure rate with spec §3: 19.2 hours a week, and 47% of release runs failing.
