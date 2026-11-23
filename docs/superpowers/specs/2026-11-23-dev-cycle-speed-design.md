# A faster development cycle: design

Date: 2026-11-23. Status: **draft, waiting for the owner's approval**. Nothing in it is built yet. The builder check raised three questions, about the background clamp, measured runs and Codex. All three are settled here as design calls 9–11 in section 12. Code facts are from origin/main `652f7f3f0`. Vitest is 4.1.12 and Playwright 1.59.1.

## 1. Intent

Development on AlfyAI has been getting slower for about a month. In the owner's words: "I do hate how slow it is and how it takes all of the computer constantly." They also said the tests work: "we haven't had a real regression in months."

So the job is to keep every check the release gate makes, and to make the cycle around it much cheaper. Cheaper means two things: less time spent waiting, and less of the Mac taken over while a gate runs.

## 2. What the owner decided

- Only the release gate has to run everything. Asked which checks are non-negotiable on every change: "Release gate only; agent runs can be selective."
- Every gate stays on the owner's Mac. Moving the release gate to the cachyos box was offered and declined.
- The owner has not built the gates or tests for about half a year: "It's always the agents doing it." The how is left to the agents.

Everything else in this document was decided in the design session. Section 12 lists those calls so the owner can check them.

## 3. Where the time goes today

These numbers come from 452 gate summaries in the Claude and Codex session logs, 11 October to 23 November, plus the logs of one agent run. The Mac is an M4 Pro with 10 performance cores, 4 efficiency cores and 24 GB of memory.

- **The release gate's time doubled.**
  - Weekly median: 9.4–10.1 minutes in October, 15.5 from the week of 2 November, 19.2 in the week of 16 November.
  - That last week splits into about 16 minutes on the overlap schedule and about 20 on the phased one. Sessions switch to phased after vitest times out running alongside the browser tests.
  - The browser-test step is almost all of the time: 8.2 minutes in October, 16.0 now. Every other step still takes about a minute or less.
- **Both suites grew by about three quarters in six weeks.**
  - Browser tests: 966 to 1,731.
  - Unit tests: 17,479 to 29,578, in 1,511 files.
  - Between two release gates on 1 November, the browser tests grew by 141 and the browser step by about six minutes.
- **Failures double the real cost.** Since 1 November, 47% of release runs and 31% of agent runs failed. The memory notes record a series of these as tests timing out under load, not real bugs, and each one cost a full rerun.
- **The sheer number of runs is what takes over the Mac.**
  - The week of 16 November had 19.2 hours of gate runs: 11.1 hours from 148 agent runs and 8.1 hours from 28 release gates.
  - October weeks had 2–7 hours.
  - Two gates overlapped in only 7% of runs.
- **Every agent run does all the unit tests.**
  - An agent run's median is about 5 minutes, and vitest takes about 3.8 of them: all 29.6k tests, even for a one-file change.
  - Gate runs per session: median 2, up to 18.
- **Where vitest's work goes.** One agent run took 240 s of wall time and about 3,040 s of worker time:

  | Part | Worker time |
  |---|---|
  | tests | 1,237 s |
  | import | 865 s |
  | environment | 741 s |
  | transform | 123 s |
  | setup | 73 s |

  The config gives every file jsdom. By a rough count, about two thirds of the 1,415 tracked unit-test files never touch a DOM.
- **What each browser test pays to sign in.**
  - 169 of the 190 spec files call `login()`.
  - `login()` loads `/login` and posts to `/api/auth/login`. That checks the password with bcryptjs at cost 12: about 200 ms on an idle core, on the server's event loop. It then loads `/` and waits for the composer.
  - Nobody has measured what this costs per test. No saved run has per-file or per-step timings of the whole suite.
  - Files run whole on one worker (`fullyParallel: false`). The largest, `images-motion.spec.ts`, is 5,926 lines.
- **Ruled out as causes.** Nextcloud's sync app was not running; only its Finder extension was. Spotlight has no entries for the repo.

## 4. Goals

1. An agent run takes about 2 minutes instead of about 5, and uses a fraction of the machine.
2. The release gate takes 10 minutes or less on an otherwise idle Mac, down from 16–20. It runs the same tests with the same assertions.
3. A failed release gate usually means a real problem. The load-related failures are designed out, not retried away.
4. The owner can keep using the Mac while a gate runs. Nothing swaps, some cores stay free, and two heavy runs never go at once.
5. It stays fast. Growth in test time shows up the day it lands, and new browser tests get written only where a browser is needed.

## 5. Non-goals

- Running gates anywhere but the Mac. The GitHub CI workflow stays as it is.
- Upgrading Vitest or Playwright as part of this work. vitest.dev now documents version 5, and Playwright 1.65 is parked because of failing e2e tests on Chromium 159.
- Pruning or rewriting what existing tests check. A test may move to another file and change how it signs in; nothing more.
- Vitest's `isolate: false` or its threads pool. State shared between files could hide failures.
- Clearing the 68 GB of finished worktrees in `.claude/worktrees`. That is separate housekeeping.

## 6. Anti-goals: failure even if it got faster

- A regression reaching `main` or production because a check got cheaper or moved somewhere cheaper.
- Speed bought by deleting, skipping or quarantining tests, loosening an assertion, raising a timeout, or retrying a failure until it passes. AGENTS.md already forbids each of these, and this work must not wear that down.
- Gate output that is harder to read. A selective run says what it ran and why. A run that falls back to everything says what triggered it.
- A Mac that feels worse: gate work pushed onto the efficiency cores, or more workers than memory allows.

## 7. Constraints

- Every rule in these AGENTS.md sections still holds: "Mandatory Verification", "Fallow Audit Gate", "Typecheck Gate", and "Build and Runtime Warning Discipline". In particular:
  - Never run `npm run check` or `npm test` while `npm run build` runs; the gate orders these.
  - One e2e run per worktree at a time.
  - Node 22; `scripts/gates.sh` puts it first on PATH.
- The flaky-test rule stands: find the cause. No blanket retry, no longer global timeout, no weaker assertion. A test leaves the gate only through `tests/e2e/quarantine.json`, by name, with its reason.
- The e2e harness gives each worker its own server, port (`E2E_PORT + N`) and SQLite file. Specs seed rows through the app's own services in the Playwright process. `tests/e2e/e2e-env.ts` and `tests/e2e/global-setup.ts` describe this.
- Claude and Codex sessions both run `scripts/gates.sh`, from the main checkout and from worktrees. At most two working sessions run at once (the owner's rule, 2026-11-17).
- While the Claude app is not in front, it clamps a session's processes to priority 4: efficiency cores and throttled I/O. `taskpolicy` cannot lift the clamp. The memory note `alfyai-dev-process-speed` has the details.
  - The app (`com.anthropic.claudefordesktop`) has no `NSAppSleepDisabled` setting, so App Nap is free to act on it. Whether App Nap is what causes the clamp has not been checked.
  - Agents never change system or app settings themselves; only the owner does.
- The docs check: these sessions have no Context7 or Svelte MCP, so use the official docs. vitest.dev now documents version 5, so check 4.1 behaviour against v4.vitest.dev or the installed package.

## 8. The design

### Part 0: Measure first, and keep measuring

Before anything else changes, one release gate runs on an otherwise idle Mac as the baseline. The gate also learns to report its own cost on every run. This work needs that to judge each part, and Part 5 needs it to stay fast.

- **Browser tests.** From the JSON report the gate already writes:
  - the time per spec file;
  - each worker's timeline, which shows who sat idle at the end;
  - the time spent signing in. Wrap the sign-in helpers in `test.step("sign in", …)` so the report carries that number.
- **Unit tests.** Vitest's per-file times, from its JSON reporter, and its summary split: environment, import, tests, transform, setup.
- **The Mac.**
  - Peak swap use and lowest free memory during the run, sampled every few seconds.
  - The gate's own scheduling priority, at the start and while it runs. When it shows the background clamp, the summary says so, so a slow run explains itself.
- **History.**
  - Each run appends its numbers, clamped or not, to a small history file in the repo's shared git directory (see Part 4's queue).
  - The release gate's summary shows its counts and times next to the previous release gate's.
  - It names the five slowest spec files.

Every later part is judged by these numbers, against the baseline.

**Measured runs.** These are the baseline, the re-measure before splitting spec files, the three final release gates and the three sample agent runs.
- A measured run counts only if its summary shows three things:
  - it ran alone, with the queue held and no other Playwright or vitest run going;
  - it was not clamped at any point;
  - no swap was in use when it started.
- Agents start these runs themselves whenever those conditions hold. They don't book time with the owner.
- A run that misses a condition is kept in the history, labelled as not counting, and repeated later.
- If the clamp keeps blocking measured runs, that is Part 4's case for asking the owner.

### Part 1: Agent runs become selective

- **Unit tests.** An agent run runs `vitest run --changed <base>`.
  - `<base>` is the merge-base of `HEAD` with `origin/main`, unless the agent names another ref.
  - Vitest runs the test files whose import graph contains a changed file, uncommitted changes included.
- **An always-run set.** Some tests read the repo's files instead of importing them: convention and cross-cutting tests, i18n validation, the gate's own tests. Following imports cannot see what they read, so an agent run always includes them.
  - About 136 tracked test files call `readFileSync`, `readdirSync` or a glob. Those that only read their own fixtures need nothing; the rest join the set.
  - Mark the set in a way the gate can find without a hand-kept list.
- **Falling back to everything.** A change to anything every test depends on runs the whole unit suite:
  - `package.json` and `package-lock.json`;
  - the Vitest and Vite configs;
  - `src/vitest-setup.ts` and `src/vitest-global-setup.ts`;
  - `drizzle/`, because the global setup migrates the template database;
  - `svelte.config.js` and `tsconfig.json`.

  Use `forceRerunTriggers`, whose default already covers `package.json` and the two configs. Confirm how 4.1 treats changes to setup files.
- **Say what it did.** The summary line says how many unit-test files ran, out of how many, and why: changed files, the always-run set, or the trigger that forced a full run.
- **Measure what the selection costs.** Working out which files are affected may take a while across 1,500 files. If it takes more than about 30 seconds, find a cheaper way before building on it.
- **Browser tests: same mechanism as today.** The agent names the specs for what it changed, and the run adds the `@smoke` tests of every other file. AGENTS.md gains one line: don't name specs you didn't touch "to be safe", because the release gate covers them.
- **Fail fast, in agent runs only.** A failed typecheck, lint, migration check, Fallow or build stops the steps still running, and the gate reports. `--no-fail-fast` keeps today's behaviour. The release gate always runs everything, so a single run reports every failure.
- **Re-tune the schedule.** With a small unit-test set, the browser tests probably need not wait for vitest. Decide from measured runs.

### Part 2: Cheaper browser tests

- **Sign in with a session.**
  - `login(page, email?, password?)` keeps its signature and its end state: on `/`, with the composer enabled.
  - It stops going through the form. In the Playwright process, it creates a session for that user through the app's own `createSession` (`src/lib/server/services/auth.ts`). It sets the `session` cookie on the page's context, with the attributes `setSessionCookie` uses, then goes to `/`.
  - The cookie points at a real session row, and the app's real hooks check it.
- **The form keeps its own tests.** A separate helper, with today's behaviour, serves every test about signing in:
  - `login.test.ts`;
  - wrong passwords, rate limits and two-step sign-in;
  - flows that sign out;
  - anything that calls `/api/auth/login` itself.

  About 14 spec files sign in with other credentials, and about a dozen files touch the auth API: sort each into one helper or the other. At least one `@smoke` test keeps a real form sign-in.
- **Split the long poles.**
  - After the sign-in change, measure again.
  - A spec file that keeps one worker busy well after the others finish gets split along its existing `describe` blocks. Its helpers are shared through a module, and no assertion changes.
  - `images-motion.spec.ts` is the likely first candidate, but the timeline decides.
- **Workers.** Re-tune the worker count within Part 4's limits. Eight workers were used in five release gates on 11–12 November: about 13.5 minutes, against 15.6 on six.

### Part 3: Cheaper unit tests

- **Node unless a file needs a DOM.** Unit tests run in Node. Only component tests and browser-side stores and helpers get jsdom. There are two ways to set this up; pick one:
  - two inline `test.projects`, with `extends: true` so the SvelteKit plugin and `resolve` still apply in 4.x;
  - Node as the default, with a `// @vitest-environment jsdom` comment on each DOM file.

  A file that needed jsdom without saying so fails loudly and gets marked. Nothing is silenced.
- **Resolve conditions.** `resolve.conditions` includes `browser` for every file today. Whether the Node tests keep it is the builder's call. Dropping it is closer to how server code runs in production, but it can change which build of a package a test gets. Every difference must be understood.
- **The expected effect.** Environment time falls by about the share of files that move, and each worker needs less memory.
- **Re-tune the release gate's schedule** from measured runs. If a lighter vitest on a few threads now finishes within the browser step, the overlap schedule comes back, and with it the 4 minutes that phased costs.

### Part 4: A polite Mac

- **One heavy run at a time.**
  - `gates.mjs` takes a lock before it starts. The lock and the history file live in the repo's shared git directory (`git rev-parse --git-common-dir`, the main checkout's `.git`).
  - Every worktree, Claude's under `.claude/worktrees` and Codex's under `~/.codex/worktrees`, shares that directory. A session can't commit unless it can write there.
  - `$TMPDIR` can't be used: a Codex session may have a temp folder of its own.
  - A second gate waits. It prints whose run it is waiting for and how long that run has been going.
  - A lock whose process is gone is taken over.
  - If a session can't take the lock, its gate says so on a line of its own and runs anyway. A Codex session must never be blocked by the queue.
  - AGENTS.md says a whole-suite or many-spec test run goes through the gate. Single files stay free.
- **Leave headroom.** Cap the gate's footprint so a few performance cores and enough memory always stay free for the owner's apps.
  - The big users are svelte-check's 6 GB heap, vitest's workers, and the browser workers. Don't run them all at full width at once.
  - Set the numbers from Part 0's samples. The aim is no swapping during any gate.
- **Lower priority, only if it earns its place.**
  - Try running the gate's processes at a lower priority (`nice`), so the owner's foreground apps win.
  - Keep it only if two things hold: a measured release gate on an idle Mac is no slower, and the timing-sensitive specs are no flakier with ordinary apps in front.
  - Never use background QoS (`taskpolicy -b` or `-c background`). It pins the work to the four efficiency cores.
- **The background clamp: count it first, then ask.**
  - After a week of Part 0's history, count how many gates were clamped, and how much slower and flakier they were.
  - If clamped gates are a real share, an agent brings the owner the numbers and a one-time fix, and the owner decides. One candidate: turning off App Nap for the Claude app (`defaults write com.anthropic.claudefordesktop NSAppSleepDisabled -bool YES`, undone with `defaults delete`). Another: a launchd job that runs gates outside the app's process tree.
  - Before proposing either, confirm with a controlled test that it actually lifts the clamp. Then measure again with this part's limits and priority in place, so an unclamped gate stays polite.

### Part 5: Keeping it fast

- **A rule for new browser tests**, in `tests/AGENTS.md`.
  - A new browser test is for what only a browser can check: layout and geometry, focus and keyboard, motion, and a flow across pages as the person sees it.
  - Logic, parsing, formatting and server behaviour go in unit tests.
  - When a new check fits an existing test's flow, extend that test rather than adding one that repeats the same sign-in and page load.
- **A number to defend.**
  - AGENTS.md records the release gate's target: 10 minutes on an idle Mac. The summary flags a run that goes over it.
  - Going over is treated like a build warning: fix it in the change that caused it, or in the next one.

### Part 6: The rules and notes

- **AGENTS.md, "Mandatory Verification":**
  - what an agent run selects, and when it falls back to everything;
  - fail fast;
  - the release gate as the only full check, run before anything is pushed or deployed;
  - the queue and the footprint caps;
  - the 10-minute target.
- **`tests/AGENTS.md`:** the two sign-in helpers and when to use which, the new-test rule, and how to split a spec file.
- **The header comment of `scripts/gates.mjs`.**
- **The memory note `alfyai-dev-process-speed`:** the final numbers.

## 9. Order of work

This order is the design session's call; the plan may refine it.

1. Part 0, and the baseline release gate on an idle Mac.
2. Part 1. Agent runs were 58% of last week's gate hours, so this frees the Mac soonest.
3. Parts 2 and 3, side by side. They touch different files: Part 2 the e2e helpers and specs, Part 3 the vitest config and the unit-test files. Two sessions can build them at once.
4. Part 2's splits, after measuring again.
5. Part 4. The queue could come earlier, but `gates.mjs` should change in one track at a time: Parts 0, 1 and 4, and the summary half of Part 5, all edit it.
6. Parts 5 and 6, with the final numbers. Then three release gates on an idle Mac, compared with the baseline.

## 10. How we'll know it worked

- **The release gate still runs the same tests.** Counts differ only by tests added in between. No assertion was loosened, no timeout raised, and nothing was skipped, deleted or quarantined to save time.
- **The release gate takes 10 minutes or less** on an idle Mac, in each of three runs.
- **Agent runs average about 2 minutes on three sample changes:** a server-only change, a component change, and an i18n string change.
- **A config change visibly falls back** to the whole unit suite.
- **The always-run set catches a planted break.** A missing Hungarian string, or a tool reason code with no words, fails an agent run that never imports the file it sits in.
- **The Mac holds up during a release gate:** swap does not grow, and a second gate started meanwhile waits its turn.
- **Codex shares the queue.** The first gate a Codex session runs after the change appears in the history file, having either taken the lock or said why it couldn't.
- **Two weeks later**, weekly gate hours and the release gate's failure rate are well below the numbers in section 3.

## 11. Left to the builder

- How the always-run set is marked, and how it is kept honest.
- Projects or per-file environment comments, and the Node tests' resolve conditions.
- The base ref for `--changed`, and how an agent overrides it.
- The footprint numbers, and whether `nice` earns its place.
- Which spec files to split, and where.
- The history file's format. Its place is decided: the shared git directory.
- The details of failing fast, such as what counts as "still running".
- Whether `login()` gains a `goto` option for tests that leave `/` at once. Only if the measurements say it is worth touching many specs.

## 12. Calls made in this design, for the owner to check

1. **Each browser test gets its own session, created directly.** The alternative is one shared signed-in state per worker; with it, a test that signs out could break the next one.
2. **Unit tests are picked automatically in agent runs, but browser specs are still named by the agent**, plus the smoke set.
3. **Fail fast in agent runs only.**
4. **Unit tests run in Node unless they need a DOM.**
5. **Lower priority only if it measurably helps.** Never the background class that confines work to the efficiency cores.
6. **The 10-minute target**, and treating a run over it like a build warning.
7. **The order of work**, with the browser-test and unit-test changes as parallel tracks.
8. **No Vitest 5 upgrade, no `isolate: false`, and no threads pool** in this round.
9. **The background clamp is counted first.** The owner is asked about a one-time fix only if a week of numbers shows clamped gates matter. Agents never change the setting themselves.
10. **Agents start the measured runs themselves**, whenever the gate can show it ran alone, unclamped and without swap. No booking time with the owner.
11. **The queue's lock and the history live in the shared git directory**, and fail open: a session that can't take the lock runs anyway and says so.
