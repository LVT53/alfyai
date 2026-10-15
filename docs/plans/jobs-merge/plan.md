# Job engine implementation plan

> **For agentic workers:** each slice below is one agent's brief. Work its tasks in order, test first (superpowers:test-driven-development), and tick the checkboxes in your report, not in this file.

**Goal:** Put every background job lifecycle (Atlas, document extraction, file production) on one engine in `src/lib/server/services/jobs/`, one kind per slice, with nothing changing for the person using the app.

**Architecture:** A deep module owns every lifecycle transition and scheduling decision over per-kind tables that share one lifecycle shape (built by its column builders). A kind supplies a definition: tables, switch, caps, lease, claim condition, phases, failure policy, Retry rule and a lazily loaded handler. Domain façades keep their names and contracts and are reimplemented on the engine.

**Tech stack:** SvelteKit 2 / Svelte 5, TypeScript, better-sqlite3 + Drizzle ORM (hand-written SQL migrations in `drizzle/` with `drizzle/meta/_journal.json`), Vitest, Playwright.

**Spec:** [`design.md`](design.md) (read it first; this plan argues from it and does not repeat its interface) and [ADR-0069](../../adr/0069-background-work-runs-on-one-job-engine.md).

## Global constraints

- Migrations are expand-only: `ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, `DROP INDEX`, and extraction's one word rewrite. No `DROP COLUMN`, no rename. The previous release keeps serving and claiming for up to 2 minutes after `db:prepare`.
- Migration tags are fixed: S2 `1777140000114_atlas_jobs_on_engine`, S3 `1777140000115_extraction_jobs_on_engine`, S4 `1777140000116_file_production_jobs_on_engine`. Each adds its journal entry (`idx` 127, 128, 129, `version` "7", `breakpoints` true). Run `npm run check:migrations`.
- No transaction is held across an `await`. better-sqlite3 transactions are synchronous, and `db/write-lock.ts` already takes the write lock at BEGIN.
- The browser receives exactly what it receives today: routes, DTOs (`FileProductionJob`, `DocumentExtractionJobDTO` with `canceled` and the phase words, `AtlasJobCard`), user-facing words and i18n keys.
- One writer: outside `services/jobs/`, no code writes a lifecycle column (design, "The lifecycle shape") of a kind table or any column of an attempts table except a kind's own extra columns.
- Every failure reaches the kind's `onFailure`. File production never requeues (ADR-0005).
- Each kind runs one job at a time per process. Caps are row counts.
- Log prefixes stay `[ATLAS]`, `[EXTRACTION]` and `[FILE_PRODUCTION]`. Message texts pinned by `worker-runner.logging.test.ts` files keep their words.
- Node 22 for installs: `export PATH=/opt/homebrew/opt/node@22/bin:$PATH` before `npm ci` (Node 26 breaks better-sqlite3).
- Gates: `npm run check` adds no diagnostic (dev's baseline is 0 errors, 17 warnings), `npx biome check src scripts tests` (not `npm run lint`), `npm test`, `npm run build`, `npm run check:artifact-chunks`, and Fallow with no new finding. Run them all once at the end with `scripts/gates.sh agent <out> --port <base> --workers 4 <specs>`. Never run `check` or `npm test` while a build runs.
- Agents commit in small steps on their slice branch, never push, and start their final report with their model ID.

## Review focus

The five conditions most likely to hurt someone that no task's happy-path tests reach. Each line's test is written into the task named.

1. **A deploy lands mid-job.** The old process claims, phases or cancels rows after `db:prepare`. After the restart every such row is taken back once, settles by its kind's policy, and no row keeps a legacy word or stays `running`. Tests: Tasks 9–10, Task 12, Tasks 15–16 (migration tests seeded in every legacy state, then the shim, then `startJobs`).
2. **A second process on the same database** (`scripts/backfill-extractions.ts` beside the server, the deploy overlap). No job runs twice, and caps count the other process's running rows. Test: Task 2 (`a second claimer never takes a running job`, `caps count rows of other workers`).
3. **A handler that hangs without progress** (a model call with no timeout). The lease stays alive because the process is alive, and Cancel still stops it at once in this process. Test: Task 4 (`cancel aborts a blocked handler at once`).
4. **SQLITE_BUSY on a beat or progress write.** No unhandled rejection and no process exit. The attempt is abandoned only after half the stale window without a successful beat. Test: Task 4 (`a failing beat writer never rejects unhandled`).
5. **Double clicks and races.** Retry pressed twice, Cancel then Retry at once, the same upload twice in parallel. One job and one consistent state. Tests: Task 2 (`parallel enqueues with one key make one job`), Task 3 (`retry twice requeues once`, `cancel and retry together leave one queued job`).

---

## Slice S1: the engine

Branch `jobs/s1-engine` from `feat/jobs-engine`. Nothing runs on the engine yet. The three ledgers keep working untouched, except `worker-identity.ts`'s import path.

**Files:**
- Create in `src/lib/server/services/jobs/`:
  - `index.ts`: the interface; imports no kind
  - `types.ts`
  - `columns.ts`: builders, the live index helper, and the shape tables used for typing
  - `define.ts`: `defineJobKind`
  - `ledger.ts`: every transition, each one transaction
  - `runner.ts`: runs one claimed attempt
  - `scheduler.ts`: state on `globalThis`, drains, ticks, timers, boot, inline
  - `events.ts`: in-process settle events
  - `wait.ts`
  - `worker-identity.ts`: `git mv` from `services/worker-identity.ts`, with its test if one exists
  - `testing/fixture.ts`
  - `testing/test-kind.ts`
  - `AGENTS.md`
- Tests: `columns.test.ts`, `enqueue-claim.test.ts`, `transitions.test.ts`, `recovery.test.ts`, `runner.test.ts`, `scheduler.test.ts`, `wait.test.ts`, `one-writer.test.ts`.
- Modify: the imports of `worker-identity` in `extraction/` and `file-production/`; `services/AGENTS.md` (one bullet pointing at `jobs/AGENTS.md`).

### Task 1: column builders, types and the test fixture

**Interfaces:**
- Produces:
  - `jobColumns(options?: { sqlNames?: Partial<Record<JobLifecycleProperty, string>>; statusDefault?: string }): JobColumns`
  - `jobAttemptColumns(options: { jobId: () => AnySQLiteColumn; sqlNames?: Partial<Record<"phase", string>> }): JobAttemptColumns`
  - `liveClaimIndex(name: string, table): IndexBuilder`, where the index is `(status, priority, created_at) WHERE status = 'queued' OR status = 'running'`.
  - Types `JobTable`, `JobAttemptTable`, `JobStatus`, `JobLifecycleProperty`, and every type in the design's interface block.
  - `JOB_LIFECYCLE_PROPERTIES` (the 18 property names in the design's table).
  - `createJobsFixture(prefix): JobsFixture`, which works like `extraction/testing/ledger-fixtures.ts`: a migrated temp file, then `CREATE TABLE test_jobs`/`test_job_attempts` from hand-written DDL. It returns `{ dbPath, sqlite, seedUser, seedJob(partial), seedAttempt(partial), readJob(id), readAttempts(jobId), cleanup }`.
  - `testJobs` and `testJobAttempts` (Drizzle tables built with the builders, plus a `label` text column and an `idemKey` text column with a unique `(user_id, idem_key)` index).

- [ ] Write `columns.test.ts`:
  - `jobColumns gives every lifecycle property`: `Object.keys(jobColumns())` sorted equals `JOB_LIFECYCLE_PROPERTIES` sorted.
  - `a legacy SQL name is kept`: build a table with `jobColumns({ sqlNames: { retryable: "error_retryable" } })` and check that `getTableConfig(table).columns.find(c => c.name === "error_retryable")` exists.
  - `the test kind's DDL matches its Drizzle tables`: for both tables, the `PRAGMA table_info` names equal the `getTableConfig(...)` column names.
- [ ] Run `npx vitest run src/lib/server/services/jobs/columns.test.ts`. It fails (no module).
- [ ] Implement `columns.ts`, `types.ts` and `testing/fixture.ts`. Move `worker-identity.ts` with `git mv` and fix its importers.
- [ ] Run the test. It passes, and so do `npx vitest run src/lib/server/services/extraction src/lib/server/services/file-production` (they use the moved identity).
- [ ] Commit: `Add the job engine's column builders and test fixture`.

### Task 2: enqueue and claim

**Interfaces:**
- Consumes Task 1.
- Produces:
  - `defineJobKind` (define.ts). It rejects a duplicate name, a phase list with duplicates, and a definition missing its handler or `onFailure`.
  - `enqueue`.
  - Internal `claimNext(kind, { workerId, jobId?, ignoreCaps? }): Claimed | null`, where `Claimed = { row, attempt: { id, number } }`.
  - `describeJob`.

The claim is one transaction:

1. Unless `ignoreCaps`, count `running` rows (all workers). Stop if the count reaches `limits().global`.
2. Select the per-user heads among claimable rows: `status = 'queued'`, `run_after` null or due, the kind's `claimable`, and `jobId` if given. Rank them `row_number() over (partition by user_id order by priority, created_at, rowid)`. Keep `rank = 1`, order by `priority, created_at, rowid`, and take at most 32. This is the extraction claim's query (`extraction/job-ledger.ts` `claimNextExtractionJob`) made generic.
3. For each head, skip the user if their running count reaches `perUser`. Otherwise the attempt number is `max(attempt_count, max(attempts.attempt_number)) + 1`.
4. Update the job, guarded by `status = 'queued'`, with `status running`, `currentAttemptId`, `attemptCount = n`, `startedAt = coalesce(startedAt, now)`, `runAfter null`, and error fields cleared. If no row changes, go on to the next head.
5. Insert the attempt: `running`, `workerId`, `claimedAt`, `heartbeatAt` and `startedAt` set to now.
6. Call `onTransition(tx, row, "running")`.

Enqueue is one transaction:

1. If `idempotency` is given, `find(tx)`. When it finds a row, `onExisting` decides: `reuse` returns it; `replace` deletes it (attempts cascade) and inserts; `insert` inserts.
2. Insert the row with lifecycle defaults, or with the born state.
3. On a unique violation, call `find` again and reuse the row it returns.
4. After the commit, wake the kind unless the job was born settled.

- [ ] Write `enqueue-claim.test.ts`. It uses the test kind; a recording handler appends `row.id` to an array and calls `ctx.succeed()`. Tests:
  - `enqueue inserts a queued job with lifecycle defaults`: `status queued`, `attemptCount 0`, `currentAttemptId null`, `priority 0`, `runAfter null`, `reused false`.
  - `born failed settles at once`, then `born succeeded settles at once`: status, `completedAt` and the error fields are as given, and `inspectJobsForTests().wakeRequests` is unchanged.
  - `idempotency reuse returns the existing row`.
  - `idempotency replace deletes the old job and its attempts`.
  - `idempotency insert lets the kind release a key first`: two rows, and the old key is rewritten.
  - `parallel enqueues with one key make one job` (Review focus 5): `Promise.all` of two enqueues gives one row, and one result has `reused: true`.
  - `drain runs jobs by priority then age`: priority 10 enqueued first and priority 0 second give the order `[p0, p10]`.
  - `one head per user: a busy user does not starve another`: seed a running row of user A from another worker, enqueue 40 jobs for A and then 1 for B, with `perUser 1`. The first job run is B's.
  - `caps count rows of other workers` (Review focus 2): seed `global` running rows with foreign worker ids. `drain` runs nothing.
  - `a second claimer never takes a running job` (Review focus 2): two `claimNext` calls with different worker ids over one queued row. Exactly one returns it.
  - `a future runAfter is not claimable`.
  - `the claim condition is honoured`: the test kind's `claimable` is `label is not null`.
  - `attempt numbers come from the attempts table`: a seeded job with `attempt_count 0` and an attempt row numbered 3. The claim makes attempt 4 and sets `attemptCount` to 4.
  - `describeJob says what a row allows`: `{ terminal, canCancel, canRetry }` for each status, under `userRetry` with and without `requireRetryable`.
- [ ] Run it and see it fail. Implement `define.ts`, `enqueue` and `claimNext` in `ledger.ts`, and a minimal `drain` in `scheduler.ts` (sequential: claim, run the handler with a bare context, repeat).
- [ ] Run it and see it pass. Commit: `Job engine: enqueue and fair claim`.

### Task 3: fenced transitions, cancel, retry and reopen

**Interfaces:**
- Consumes Task 2.
- Produces (in `ledger.ts`, all fenced by the ownership predicate in the design's "Leases and fencing"):
  - `beat`, `progress`, `write`, `succeed` and `fail`, each `(owned: { jobId, attemptId, workerId }, …)`.
  - The public `cancel`, `cancelAll`, `retry` and `reopen`.
  - `FailOutcome` (design).

- [ ] Write `transitions.test.ts`:
  - `progress moves forward only`: phases `["a","b","c"]`; `b` passes, `a` returns false and the phase stays `b`, and `b` again returns true (a beat).
  - `checkpoint survives a requeue and is cleared when the job settles`.
  - `succeed runs apply in the same transaction`: an `apply` that throws leaves the row `running` and the attempt `running`.
  - `succeed writes diagnostics on the attempt`.
  - `fail with a requeue decision keeps the error and sets runAfter`: the policy returns `{ requeue: true, delayMs: 5000 }`. The result is `status queued`, `errorCode` kept, `runAfter = now + 5 s`, the attempt `failed`, and `retryState` written.
  - `fail with a settle decision clears the checkpoint`.
  - `discardCheckpoint drops the checkpoint even on a requeue`.
  - `a late write after a take-back is refused`: the handler is held on a promise while the test takes the attempt back (Task 5's sweep, or the fixture marks the attempt failed). Then `succeed` returns false and the row is unchanged.
  - `cancel settles queued and running jobs`: attempt `cancelled` with code `cancelled`; error, checkpoint and `runAfter` cleared; `cancelRequestedAt` kept if already set.
  - `cancel of another user's job returns null`.
  - `cancelAll cancels a user's live jobs inside the where scope`.
  - `retry reopens a failed retryable job`: `queued`, error cleared, `attemptCount` unchanged, and the next attempt numbered `n + 1`.
  - `retry refuses a non-retryable job when requireRetryable`, and `retry respects allow`.
  - `retry twice requeues once` (Review focus 5): the second call returns null and the row is unchanged.
  - `cancel and retry together leave one queued job` (Review focus 5): `Promise.all([cancel, retry])` on a running job ends `cancelled` or `queued`, never with two attempts running.
  - `reopen follows from, allow, patch, keepCheckpoint and retryState`.
  - `retry and reopen wake the kind`.
- [ ] Run it and see it fail. Implement. Run it and see it pass. Commit: `Job engine: fenced transitions, cancel, retry, reopen`.

### Task 4: the runner

**Interfaces:**
- Consumes Task 3.
- Produces `runAttempt(kind, claimed, { workerId }): Promise<void>`. It builds `JobRunContext`, beats on a timer, aborts with `"cancelled"` or `"lease-lost"`, and maps the handler's result. A registry of this process's running attempts lets `cancel` abort at once.

Rules:

- A handler that throws becomes `fail({ code: "job_failed", message: error.message, retryable: true })`.
- A handler that returns without a verdict while its attempt still owns the job becomes `fail({ code: "no_verdict", message: "The job stopped without a result.", retryable: true })`.
- After an abort, a returning handler writes nothing.
- A beat whose write throws is logged with the kind's prefix (`Heartbeat write failed`), never rejects, and leads to an abort only once no beat has succeeded for `staleAfterMs / 2`.

- [ ] Write `runner.test.ts` with fake timers:
  - `the heartbeat timer beats while the handler is busy`: `heartbeatAt` advances each `heartbeatMs`.
  - `cancel aborts a blocked handler at once` (Review focus 3): with the handler awaiting forever, `cancel(...)` sets `ctx.signal.aborted` true and `signal.reason === "cancelled"` before any timer runs.
  - `a lost lease aborts with lease-lost at the next beat`.
  - `a failing beat writer never rejects unhandled` (Review focus 4): stub the beat to throw `SQLITE_BUSY`, and use `process.on("unhandledRejection")` to assert it is never called. There is no abort before `staleAfterMs / 2`, and one after.
  - `a throwing handler is a job_failed failure`: `onFailure` receives `{ code: "job_failed", retryable: true }`.
  - `returning without a verdict is a no_verdict failure`.
  - `a handler aborted for lease-lost that returns writes nothing`.
- [ ] Run, implement, run. Commit: `Job engine: attempt runner with beats and abort reasons`.

### Task 5: take-backs and scoped recovery

**Interfaces:**
- Consumes Task 4.
- Produces:
  - Internal `takeBack(kind, { reason: "stale" | "dead-worker" | "state-lost", staleBefore?, selfWorkerId?, isProcessAlive? }): { recovered, requeued }`.
  - The public `recover(kind, { where?, queuedOlderThan? })`.

- [ ] Write `recovery.test.ts`:
  - `a stale attempt is taken back through onFailure`: `onFailure` receives `lostAttempt("stale")`'s code and message, and the row follows the decision.
  - `a dead worker's attempt is taken back at boot`: a worker id with the same host, pid 999999 and `isProcessAlive` returning false.
  - `this process's attempts are never dead`, including an `-inline` id with this boot nonce.
  - `another host's or an old-format id waits for the stale window`.
  - `EPERM means alive`.
  - `a running job with no live attempt is taken back as state-lost`, for both a missing attempt row and an attempt not `running`.
  - `state-lost at boot takes back a fresh row`.
  - `state-lost on the idle tick leaves a fresh row alone and takes back an old one`: the age guard is `updated_at < now - staleAfterMs`. It applies to the follow-up sweep, the idle tick, the sweep between drains and `recover`, and not to boot.
  - `recover fails old queued jobs only inside its scope`, with code and message from the caller's options, defaulting to `worker_queue_timeout`.
  - `recover takes back stale and lost attempts inside its scope`.
- [ ] Run, implement, run. Commit: `Job engine: stale, dead-worker and lost-state take-backs`.

### Task 6: the scheduler

**Interfaces:**
- Consumes Tasks 2–5.
- Produces:
  - `startJobs(kinds, testOptions?: { startInNonServingContextForTests?: boolean; isProcessAlive?: (pid) => boolean })`.
  - `stopJobs`, `wake`, `drain`, `runInline`.
  - Test helpers `resetJobsForTests()` and `inspectJobsForTests(): { [kind]: { running, idleTickArmed, idleTickMs, backoffArmed, backoffFiresInMs, bootSweepArmed, wakeRequests, drainRuns } }`.

What it does is in the design's "The scheduler". Port the comments from `extraction/worker-runner.ts` and `file-production/worker-runner.ts` that explain each rule (non-serving context, `Symbol.for` state, the boot follow-up sweep, the one-second backoff margin, the live switch both ways).

- [ ] Write `scheduler.test.ts` with fake timers and `startInNonServingContextForTests`:
  - `a wake during a drain is honoured after it`.
  - `the switch off stops new claims and a running attempt finishes; on again resumes at the next tick`.
  - `a disabled kind gets only the idle tick`.
  - `the backoff timer fires a drain one second after the earliest runAfter`.
  - `the idle tick sweeps stale attempts only when a running row exists`.
  - `the boot follow-up sweep runs staleAfterMs after start`.
  - `startJobs twice and a module re-evaluation keep one scheduler`: `vi.resetModules()`, re-import, `startJobs` again, and still one idle tick per kind.
  - `nothing is scheduled outside a serving process unless started for tests`: wakes are counted and `drainRuns` stays 0.
  - `a wake before startJobs is counted and runs nothing`: run this with the serving check passing, as in a command-line script. `drain(kind)` still runs the work.
  - `stopJobs clears every timer and takes no new work`.
  - `runInline runs an eligible job past the caps within the budget`, and `runInline leaves an ineligible job queued`.
  - `an idle box logs nothing on a tick`: spy on `console`.
- [ ] Run, implement, run. Commit: `Job engine: scheduler, boot sweeps and inline runs`.

### Task 7: waiting for a verdict

**Interfaces:**
- Consumes `events.ts` (settle events emitted after a commit by `succeed`, `fail`, `cancel`, take-backs and born-settled enqueues).
- Produces `waitForVerdict`.

- [ ] Write `wait.test.ts`:
  - `resolves at once when this process settles the job`: no timer advance is needed.
  - `falls back to a 1 s poll for a row settled by another connection`.
  - `times out unsettled with the last status`.
  - `an aborted signal stops the wait`.
  - `a requeue is not a verdict`.
- [ ] Run, implement, run. Commit: `Job engine: waitForVerdict by event with a poll fallback`.

### Task 8: the interface, the one-writer scan and the folder rules

**Interfaces:**
- Produces `index.ts`, which exports exactly the design's interface plus the test helpers. `index.ts` imports no handler module (`defineJobKind` takes `handler: () => import(...)`).

- [ ] Write `one-writer.test.ts`. It scans every non-test `.ts`/`.svelte` file under `src/` outside `services/jobs/`, `testing/` folders and `*.test.ts`. A file fails when it names a kind table identifier (`fileProductionJobs`, `documentExtractionJobs`, `atlasJobs`, the attempts tables and any later `*Jobs` built with `jobColumns`) and either:
  - has `.set({` or `.values({` with a lifecycle key (`status`, `currentAttemptId`, `attemptCount`, `runAfter`, `nextAttemptAt`, `retryable`, `errorRetryable`, `errorCode`, `errorMessage`, `cancelRequestedAt`, `startedAt`, `completedAt`, `checkpoint`, `remoteHandleJson`, `retryState`, `heartbeatAt`, `workerId`), or
  - inserts into an attempts table, or `.set({` on one with a lifecycle key. A kind's own extra attempt columns (`extractor`, `resumed`, `textLength`, `pageCount`, `mode`, `renderer`, `runtime`) are allowed.

  `ALLOWED` lists, with a reason each:
  - `extraction/job-ledger.ts`, `extraction/reextract.ts`, `file-production/job-ledger.ts`, `file-production/read-model.ts` (legacy backfill), `atlas/job-ledger.ts`, `account-lifecycle/index.ts`: "moves to the engine in its kind's slice".
  - `conversation-forks.ts`: "copies settled rows into a fork: a snapshot, not a transition".

  A second test fails if `ALLOWED` names a file that no longer matches, so the list can only shrink.
- [ ] Run it. It passes on today's tree with that list; if it fails, the list was wrong, so fix the list and not the scan.
- [ ] Write `jobs/AGENTS.md` (the rules from the ADR's last consequence, the interface in one paragraph, and where each kind's definition lives) and the bullet in `services/AGENTS.md`.
- [ ] Run `scripts/gates.sh agent <scratchpad>/gates-s1 --port 5510 --workers 4` (no e2e spec is changed; the smoke set runs). All pass.
- [ ] Commit: `Job engine: public interface, one-writer scan and folder rules`.

## Review R1 (Opus, adversarial): leases, fencing, recovery and scheduling

Read S1's diff against the design. Hunt for:

- a write path missing the ownership predicate;
- a transaction around an `await`;
- a take-back that can run twice;
- a requeue that bypasses `onFailure`;
- a lost wake;
- a timer left armed after `stopJobs`;
- an unhandled rejection;
- a claim that breaks the caps across two connections;
- attempt-number collisions;
- `describeJob` disagreeing with `retry`.

Write a failing test for each real finding before fixing it.

---

## Slice S2: Atlas on the engine

Branch `jobs/s2-atlas` from `feat/jobs-engine` after S1 and R1 are merged. Specs: `tests/e2e/atlas-job-flow.spec.ts`, `tests/e2e/atlas-report-preview.spec.ts`, `tests/e2e/home-compact.spec.ts`.

### Task 9: Atlas tables and migration

**Files:**
- `drizzle/1777140000114_atlas_jobs_on_engine.sql`
- `drizzle/meta/_journal.json`
- `src/lib/server/db/schema.ts` (`atlasJobs` spreads `jobColumns({ sqlNames: { retryable: "error_retryable" } })`; new `atlasJobAttempts` built with `jobAttemptColumns`)
- `scripts/prepare-db.ts` (required table `atlas_job_attempts`)
- `src/lib/server/db/schema.test.ts`
- Test: `src/lib/server/db/atlas-jobs-engine-migration.test.ts`

Migration:
- `CREATE TABLE atlas_job_attempts` and its three indexes.
- `ALTER TABLE atlas_jobs ADD COLUMN` for `current_attempt_id`, `attempt_count integer DEFAULT 0 NOT NULL`, `run_after`, `priority integer DEFAULT 0 NOT NULL`, `phase`, `checkpoint_json` and `retry_state_json`.
- `CREATE INDEX atlas_jobs_live_claim_idx` (the live partial index).

- [ ] Test `the migration keeps live Atlas rows` (Review focus 1). Migrate a fixture to 113, seed `queued`, `running` (with a job-level `worker_id`) and `failed` rows, and apply the remaining migrations. The rows are intact, the new columns are at their defaults and the live index exists.
- [ ] Run, write the migration and schema, run. Commit: `Atlas jobs get the engine's lifecycle columns and attempts`.

### Task 10: the Atlas kind and its handler

**Files:**
- Create `atlas/research-job.ts`: the definition, plus the domain functions intake, link, deletes and the legacy title.
- Create `atlas/research-runner.ts`: the handler, moved from `worker-runner.ts`'s `executeNextAtlasJob` and `executeAtlasV3Job`.
- Modify `atlas/config.ts`: `ATLAS_HEARTBEAT_MS = 15_000`, `ATLAS_STALE_AFTER_MS = 120_000`, `ATLAS_MAX_LOST_ATTEMPTS = 3`.
- Test: `atlas/research-runner.test.ts`, ported from `worker-runner.test.ts`.

Definition values:
- `name "atlas"`, `logPrefix "[ATLAS]"`.
- `enabled`: `config.atlasWorkerEnabled ?? DEFAULT_ATLAS_WORKER_ENABLED`.
- `limits`: `{ global: getDefaultAtlasWorkerLimits().globalActiveLimit, perUser: DEFAULT_ATLAS_PER_USER_ACTIVE_LIMIT }`.
- `claimable`: `assistant_message_id is not null`.
- `lostAttempt` gives every reason `{ code: "atlas_worker_heartbeat_timeout", message: "Atlas worker heartbeat timed out before completion." }`.
- `onFailure`:
  - The lost-attempt code with `attempts < ATLAS_MAX_LOST_ATTEMPTS` gives `{ requeue: true, delayMs: 0 }`.
  - The same code at the limit gives `{ requeue: false, retryable: true }`.
  - Any other code gives `{ requeue: false, retryable: true }`, as today.
- No `userRetry`.
- `onTransition` keeps Atlas's domain columns as today's ledger wrote them:
  - `running`: stage `ask`, progress 0, details `{}`, `pipelineVersion` = `ATLAS_CURRENT_PIPELINE_VERSION`, `failure_metadata_json` null.
  - `queued`: stage `queued`, progress 0, details `{}`.
  - `failed`: stage `failed`.
  - `cancelled`: stage `cancelled`.

Handler:
- Its pipeline `heartbeat` callback becomes `ctx.write` of stage, progress and details. It throws `"Atlas job is no longer running."` on false, as today.
- Its title becomes `ctx.write`.
- Completion is `ctx.succeed({ apply })`, writing usage, source counts, output ids, stage and progress 100. Analytics and `notifyAtlasCompletion` run only when it returns true.
- Failures are `ctx.fail({ code: v3Error?.code ?? "atlas_pipeline_failed", message, retryable: true }, { apply: failure metadata })`.
- Do not thread `ctx.signal` into `atlas-v3/`. A cancel is noticed when the next `ctx.write` returns false, as today.

- [ ] Port each case of `worker-runner.test.ts` to `research-runner.test.ts` through `drain(atlasResearchJob)` with the pipeline mocked as it is today. Add:
  - `a lost Atlas attempt requeues twice then fails retryable`;
  - `a run on a cancelled job sends no push and records no analytics`;
  - `a row running at the cutover is taken back and requeued` (Review focus 1): Task 9's migrated fixture, then `startJobs([atlasResearchJob])`, gives the running row `queued` with attempt 1 of 3 recorded.
- [ ] Run, implement, run. Commit: `Atlas research jobs run on the job engine`.

### Task 11: the Atlas façade, startup and the old files

**Changes:**
- `atlas/index.ts` keeps every exported name except `ensureAtlasWorker` and `wakeAtlasWorker`.
  - `createOrReuseAtlasJob` and `submitAtlasJobIntake` become `enqueue` with `idempotency.find` (by `idempotency_key`) and `onExisting`. It returns `replace` for an unlinked failed or cancelled job; otherwise it writes the legacy title in tx and returns `reuse`.
  - `linkAtlasJobAssistantMessage` becomes a domain update followed by `wake`.
  - `cancelAtlasJob` becomes `cancel`.
  - `cancelActive…ForUser` becomes `cancelAll`, and `…ForConversation` becomes `cancelAll` with `where conversation_id`.
  - `delete…` stays as it is.
- `hooks.server.ts`: `startJobs([atlasResearchJob])` replaces `ensureAtlasWorker()`, with the same non-awaited `.catch`. On `sveltekit:shutdown`, call `stopJobs()`.
- `routes/api/chat/send/+server.ts`: drop the `wakeAtlasWorker()` call (link now wakes) and update `send.test.ts` and `hooks.server.test.ts`.
- Delete `atlas/job-ledger.ts` and `atlas/worker-runner.ts`. Keep `resolveAuditModelSelection` in `research-runner.ts` and move `getDefaultAtlasWorkerLimits` to `config.ts`, because the light definition file must not import the heavy runner.
- Remove `atlas/job-ledger.ts` from `one-writer.test.ts`'s `ALLOWED`.
- Write `docs/plans/jobs-merge/rollback-atlas.md`. A code rollback is safe: the old code reads `status`, `stage`, `worker_id` and `error_retryable`, which the engine still writes or ignores, and its boot requeues every running row.
- Grep for readers of `atlas_jobs.worker_id` and `heartbeat_at`. If any exists outside the old ledger, move it to the attempts table in this task.

- [ ] `atlas/index.test.ts` passes. Its only changes are mocks of the removed worker functions.
- [ ] Run `scripts/gates.sh agent <scratchpad>/gates-s2 --port 5520 --workers 4 tests/e2e/atlas-job-flow.spec.ts tests/e2e/atlas-report-preview.spec.ts tests/e2e/home-compact.spec.ts`. All pass.
- [ ] Commit: `Atlas façade on the job engine; old ledger and worker removed`.

---

## Slice S3: extraction on the engine

Branch `jobs/s3-extraction` from `feat/jobs-engine` after S1 and R1 are merged. It runs beside S2 and owns migration 115. Specs: `tests/e2e/knowledge.spec.ts`, `tests/e2e/file-drag-drop.spec.ts`, `tests/e2e/project-files.spec.ts`, `tests/e2e/chat-turn-files.spec.ts`.

### Task 12: the vocabulary migration, the shim and the reverse SQL

**Files:**
- `drizzle/1777140000115_extraction_jobs_on_engine.sql` and the journal.
- `schema.ts`:
  - `documentExtractionJobs` spreads `jobColumns({ sqlNames: { runAfter: "next_attempt_at", checkpoint: "remote_handle_json" } })` and keeps its domain columns.
  - Attempts use `jobAttemptColumns` plus `extractor`, `resumed`, `remote_handle_json`, `text_length` and `page_count`.
- `db/compat.ts`: `normalizeExtractionLifecycleWords()`, called from `ensureRuntimeSchemaCompatibility()`, which `hooks.server.ts` init awaits before `startJobs`.
- `docs/plans/jobs-merge/rollback-extraction.sql` and `.md`.
- `README.md`: one line on the shim and when it goes.
- Test: `src/lib/server/db/extraction-jobs-engine-migration.test.ts`.

Migration:
- `ADD COLUMN phase text` and `ADD COLUMN retry_state_json text`.
- `UPDATE … SET phase = status, status = 'running' WHERE status IN ('uploading','parsing','downloading','indexing')`.
- `canceled` becomes `cancelled` on jobs and on attempts.
- `retry_state_json = json_extract(hints_json, '$."$outage"')`, with the key removed from `hints_json` (null when nothing is left), for rows that have it.
- `CREATE INDEX document_extraction_jobs_live_claim_idx` (the live partial index; the old `claim_idx` stays until the cleanup).
- The shim runs the same `UPDATE`s, idempotently.

- [ ] Write `extraction-jobs-engine-migration.test.ts`:
  - `rows in every old word are rewritten`: one row in each of the 8 statuses, attempts `canceled`, and a hint with `$outage` and a caller key.
  - `the shim rewrites words the old process wrote after the migration` (Review focus 1).
  - `the shim is idempotent`.
  - `the reverse SQL restores the old words and $outage`, applying the rollback file to the migrated rows.
- [ ] Run, implement, run. Commit: `Extraction jobs store the engine's status words`.

### Task 13: the extraction kind, its handler and policy

**Files:**
- Create `extraction/extraction-job.ts` (the definition).
- Create `extraction/extraction-runner.ts` (the handler, from `worker-runner.ts`'s `executeStep`, `persistExtraction` and `bestEffortRemoteCancel`, plus the readback sink registry).
- Modify `retry-policy.ts`: state read from `retryState`, while the arithmetic is unchanged.
- Test: port the handler cases of `worker-runner.test.ts` and its logging test to `extraction-runner.test.ts` and `extraction-runner.logging.test.ts`.

Definition:
- `name "extraction"`, `logPrefix "[EXTRACTION]"`.
- `enabled`, `limits` and `lease` come from `getExtractionConfig()`: `maxConcurrency`, `perUserConcurrency`, `heartbeatMs`, `staleAttemptMs`.
- `phases ["uploading","parsing","downloading","indexing"]`.
- `lostAttempt` gives `stale_worker` and today's message.
- `onFailure` is `decideExtractionRetry` with the config values and the outage state from `retryState`.
- `userRetry`: `{ from: ["failed","cancelled"], allow: row => extractionDocumentAttempts(row.attemptCount, outage) < extractionAttemptCeiling(maxAttempts) }`.
- `inline.eligible`: `intakeRoute === "direct-text"`.

Handler:
- Progress becomes `ctx.progress({ phase, checkpoint: handle })`.
- The attempt's `extractor` and `resumed` are written with `ctx.write`. The attempt-level `remote_handle_json` is no longer written, because the job's checkpoint holds the handle; its column stays.
- On abort it calls the remote cancel only when `signal.reason === "cancelled"` and the extractor does not cancel on abort itself.
- Success is `ctx.succeed({ diagnostics, apply })`, which sets `normalized_artifact_id`, `hints_json` to null, and the attempt's `text_length` and `page_count`.
- Failures are `ctx.fail({ …, discardCheckpoint: failure.handleUnknown })`.

- [ ] Run, implement, run. Commit: `Document extraction runs on the job engine`.

### Task 14: the extraction façade, callers and the old files

**Changes:**
- `enqueueExtractionJob`: `enqueue` with `find` by source artifact or chat file and `reuse`. It is born settled for a dedupe hit or an unreadable file.
- `retryExtractionJob`: `reopen` from `failed` or `cancelled`, with the ceiling as `allow`, the hints as `patch`, `retryState` carrying `waits`, and the checkpoint kept. It stays a separate function from the engine's `retry` because it takes hints.
- `cancelExtractionJob`: `cancel`.
- `materializeLegacyExtractionJob`: `enqueue` born failed.
- `requeueExtractionJobForReextraction` (`reextract.ts`): `reopen` with its ceiling and per-user limit as `allow`, new hints as `patch`, the checkpoint cleared and `waits` carried. It keeps its result reasons (`not_found`, `active`, `attempt_ceiling`, `user_limit`).
- `startUploadExtraction` and `startGeneratedFileReadback`: `enqueue` (readback priority 10), then `runInline` for direct text within today's budget.
- `waitForExtractionJobVerdict({ jobId, userId, timeoutMs, signal })` keeps its name and returns `{ settled, job: DTO | null }` through `waitForVerdict`. Update its two callers (`chat-turn/preflight.ts`, `knowledge/upload-intake.ts`) and their tests.
- The read model maps `running` to its phase (`uploading` if none) and `cancelled` to `canceled`.
- `account-lifecycle/index.ts`: `cancelActiveDocumentExtractionForUser` becomes `cancelAll`.
- `scripts/backfill-extractions.ts` and its test take the new words.
- `hooks.server.ts`: `startJobs` gains the extraction kind; `ensureExtractionWorker` and `wakeExtractionWorker` go, and so do every caller's wakes (`retry` and `reextract` routes).
- Delete `job-ledger.ts`'s lifecycle functions (keep what is domain, renamed for what it does), `worker-runner.ts`, `job-wait.ts` and `state-machine.ts` (the phase order now lives in the definition), together with the tests the engine's tests now cover. Keep the domain tests.
- Update `boundary.test.ts`, `no-inline-extraction.test.ts`, `tests/cross-cutting/incognito-artifact-containment.test.ts` (same number of entries, new paths) and `.fallowrc.json`.
- Remove the S3 entries from `ALLOWED`.

- [ ] Run `scripts/gates.sh agent <scratchpad>/gates-s3 --port 5530 --workers 4 tests/e2e/knowledge.spec.ts tests/e2e/file-drag-drop.spec.ts tests/e2e/project-files.spec.ts tests/e2e/chat-turn-files.spec.ts`. All pass.
- [ ] Commit: `Extraction façade on the job engine; old ledger, worker and wait removed`.

---

## Slice S4: file production on the engine

Branch `jobs/s4-file-production` from `feat/jobs-engine` after S2 and S3 are merged, and **only after the orchestrator has told the upload-analysis session and heard whether it has work in flight in `file-production/`**. Specs: `tests/e2e/artifact-downloads.spec.ts`, `tests/e2e/artifact-delete.spec.ts`, `tests/e2e/pdf-preview-size.spec.ts`, `tests/e2e/chat-turn-files.spec.ts`, `tests/e2e/conversation-forks.spec.ts`, `tests/integration/file-production-journey.test.ts`.

### Task 15: file-production columns and migration

**Files:**
- `drizzle/1777140000116_file_production_jobs_on_engine.sql` and the journal.
- `schema.ts`:
  - `fileProductionJobs` spreads `jobColumns({ sqlNames: { phase: "stage" }, statusDefault: "succeeded" })`.
  - Attempts use `jobAttemptColumns({ sqlNames: { phase: "stage" } })` plus `mode`, `renderer` and `runtime`.
- Test: `src/lib/server/db/file-production-jobs-engine-migration.test.ts`.

Migration:
- `ADD COLUMN` for `attempt_count` (backfilled from `max(attempt_number)`), `run_after`, `priority`, `checkpoint_json`, `retry_state_json` and `started_at` (backfilled from the first attempt).
- `DROP INDEX file_production_jobs_live_claim_idx`, then create the live partial index on `(status, priority, created_at)` under the same name.

- [ ] Test `the migration keeps live file-production rows` (Review focus 1). Seed `succeeded` with files and warnings, `failed`, `queued`, and `running` claimed by a dead worker, then migrate. `attempt_count` equals each job's highest attempt number, `started_at` is its first attempt's, and the succeeded row's warnings still read through `currentAttemptId`.
- [ ] Run, implement, run. Commit: `File-production jobs get the engine's lifecycle columns`.

### Task 16: the file-production kind and handler

**Files:**
- Create `file-production/production-job.ts` (the definition).
- Create `file-production/production-runner.ts` (the handler, from `executeNextFileProductionJobStep`).
- Tests: port `worker-runner.logging.test.ts` and the handler cases from `worker-runner.scheduler.test.ts` (the scheduler cases are the engine's). Add `a row running at the cutover is taken back` (Review focus 1): Task 15's migrated fixture, then `startJobs([fileProductionJob])` with the dead worker's pid reported gone, gives that row `failed`, retryable, `worker_heartbeat_timeout`, and the queued row runs.

Definition:
- `name "file-production"`, `logPrefix "[FILE_PRODUCTION]"`.
- `enabled` comes from `getFileProductionWorkerConfig().workerEnabled`.
- `limits { global: 1 }`.
- `lease { heartbeatMs: FILE_PRODUCTION_HEARTBEAT_MS, staleAfterMs: staleAttemptMs }`.
- `lostAttempt`:
  - stale: `worker_heartbeat_timeout` with "File production worker stopped before finishing.";
  - dead-worker: the same code with "File production stopped when the server restarted.";
  - state-lost: `worker_state_lost` with "File production worker state was lost before finishing.".
- `onFailure` returns `{ requeue: false, retryable: failure.retryable }`.
- `userRetry { from: ["failed"], requireRetryable: true }`.

Handler:
- `execute` uses `ctx.signal`.
- It stores the outputs, then calls `ctx.succeed({ diagnostics: { [FILE_PRODUCTION_ATTEMPT_WARNINGS_KEY]: warnings }, apply })`. `apply` links the job's files and sets the chat files' reply message in the same transaction.
- Memory sync runs only when that returns true.

- [ ] Run, implement, run. Commit: `File production runs on the job engine`.

### Task 17: the file-production façade, callers and the old files

**Changes:**
- `createOrReuseFileProductionJob` (inside `submitFileProductionIntake`): `enqueue` with `find` by `(user, conversation, key)`.
  - `reuse "any"` reuses.
  - `reuse "usable"` reuses a usable job; otherwise it releases the key in tx (the `#superseded:` rename) and returns `insert`.
- `createFailedFileProductionJob`: `enqueue` born failed, with the same idempotency.
- `retryFileProductionJob`: `retry`.
- `regenerateFileProductionJob`: `reopen` from `succeeded`, with `allow` true only when `request_json` is present and no job-file row is left. `dismissed` resets in `patch`.
- `cancelFileProductionJob`: `cancel`.
- `dismissFileProductionJob` stays domain.
- `reconcileStaleFileProductionJobs`: `recover` with `where` (the conversation and, when given, its reply messages) and `queuedOlderThan` (`staleBefore`).
- The read model's legacy backfill: `enqueue` born succeeded. If the backfilled rows must keep their files' timestamps and born states cannot, keep it as a named `ALLOWED` exception with that reason.
- `atlas/output-files.ts` and `normal-chat-tools/index.ts`: the engine's `waitForVerdict` plus a DTO read replace `drainFileProductionWorker` and the wait helper.
- `account-lifecycle/index.ts`: `cancelActiveFileProductionForUser` becomes `cancelAll`.
- `hooks.server.ts`: `startJobs` with all three kinds. The `ensure…` and `wake…` functions are gone, including the `retry` and `regenerate` routes' wakes.
- Delete the lifecycle functions of `job-ledger.ts` (keep `linkProducedFileToJob` and `assignFileProductionJobsToAssistantMessage` in a file named for them), `worker-runner.ts` and `job-wait.ts`, with the tests the engine covers.
- Update `obsolete-surfaces.test.ts`, `mixed-output-groups.test.ts` and `.fallowrc.json`.
- `ALLOWED` ends with `conversation-forks.ts` alone, plus the backfill if kept.
- `file-production/AGENTS.md`: the `job-ledger.ts` and `worker-runner.ts` bullets point at the engine.
- ADR-0005 gets an implementation-status paragraph (its worker runs on ADR-0069's engine).
- Write `docs/plans/jobs-merge/rollback-file-production.md` (a code rollback is safe).

- [ ] `file-production/index.test.ts` and `tests/integration/file-production-journey.test.ts` pass, with changes only where they called removed worker functions.
- [ ] Run `scripts/gates.sh agent <scratchpad>/gates-s4 --port 5540 --workers 4` with the S4 specs. All pass. Fallow no longer reports `extraction/` and `file-production/` as mirrored directories.
- [ ] Commit: `File-production façade on the job engine; old ledger, worker and wait removed`.

## Review R2 (Opus, adversarial): the data path

Review migrations 114–116, the shim, the three rollback files and the cutover take-backs. Check them against a copy of a realistic database: seed every state of every kind, migrate, run the shim, `startJobs`, then roll back with each rollback file and start the old code's ledger functions against the result. A finding gets a failing test first.

## Ship

Run by the orchestrator.

1. Merge `feat/jobs-engine` into `dev` in the main checkout.
2. Run the release gate in a detached worktree: `scripts/gates.sh release <dir> --port 5600 --workers 6`, with `npm ci` under Node 22 and `mkdir -p data` first.
3. Push `dev`. The push includes the 45 local commits already on `dev`.
4. Deploy ai.dev with the staging command in the `alfyai-staging-verify-harness` memory. Read the script's output to the end. If it rolled back to the previous release after a failed health check, run `docs/plans/jobs-merge/rollback-extraction.sql` against the staging database before anything else.
   - If S4 was held (by the upload-analysis session or by the budget), S1 to S3 ship without it.
5. Live checks on the box:
   - status counts per kind before and after (no legacy word left, nothing stuck `running`);
   - a `.txt` upload (inline) and a PDF upload (MinerU), then Retry and Cancel on one of them;
   - a produced PDF (`/root/verify-pdf.mjs`), then Retry on a failed job and Regenerate on a deleted file;
   - an Atlas run to completion with its card and push, and a Cancel;
   - the service journal lines for each prefix.

## Budget

On 2026-10-15 the weekly limit was at 73% (resets 2026-10-19 09:00 UTC). Estimates, from the measured runs in the `alfyai-token-budget-pacing` memory:

| Step | Model | Weekly % |
|---|---|---|
| S1 | Sonnet | 3–5 |
| R1 | Opus | 2–3 |
| S2 | Sonnet | 2–3 |
| S3 | Sonnet | 3–5 |
| S4 | Sonnet | 3–5 |
| R2 | Opus | 2–3 |
| Ship, integration fixes, orchestrator | mixed | 3–5 |
| **Total** | | **18–29** |

So the whole run fits only at the low end. The orchestrator checks `get_usage` before each dispatch. It does not start a slice that would take the week past 94%; it deploys what is merged and reports the numbers instead.
