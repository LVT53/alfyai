# One job engine for background work — design

Written 2026-10-15 on `feat/jobs-engine` (from local `dev` = `11b0496d7`). The owner chose this work on 2026-10-14 ("a structured API") and on 2026-10-15 pre-approved the plan "as long as it follows the initial goal": build it with subagents, deploy to ai.dev and test every affected area there. Every decision below that is not a quote of the owner is marked **my call**. The decision record is [ADR-0069](../../adr/0069-background-work-runs-on-one-job-engine.md).

## Why

AlfyAI runs three kinds of durable background work, and each has its own copy of one job lifecycle: create or reuse, claim with a lease, heartbeat, report progress, complete, fail, retry, cancel, recover stale work, reclaim a dead worker's work, schedule the worker (wake, drain, idle tick, boot sweeps), and wait for a verdict. About 6,250 lines across `atlas/`, `extraction/` and `file-production/` (`job-ledger.ts`, `worker-runner.ts`, `job-wait.ts`). Fallow flags the last two as mirrored directories and finds a 215-line clone between their ledgers.

The owner's two goals:

1. **A lifecycle bug is fixed once**, not three times.
2. **The next background feature (scheduled tasks, for example) does not add a fourth copy.**

The copies have already drifted. These fixes reached one or two kinds and not the third:

| | Atlas | Document extraction | File production |
|---|---|---|---|
| Fencing token on every write a run makes | none: a per-process worker id, no attempt rows | attempt id + worker id | attempt id + worker id |
| Heartbeat | only when the pipeline reports progress | timer, progress writes, cancel poll | timer |
| Stale sweep while serving | none (boot only) | idle tick, empty drains, boot, boot follow-up | same |
| Dead-worker reclaim at boot | every running job is treated as dead | by host, pid and boot nonce | by host, pid and boot nonce |
| After a lost worker | requeued, with no limit | retry policy (backoff, ceiling) | failed, retryable (no automatic retry, ADR-0005) |
| A wake that arrives during a drain | dropped | remembered | remembered |
| Scheduler survives a module re-evaluation (HMR) | no | yes (`Symbol.for` state) | yes |
| Enable switch | read at boot and at wake | live both ways | live both ways |
| Caps | global 2, per user 1 (rows) | global, per user (rows), fair per-user heads, priority, backoff gate | global 1: any running row blocks the claim |
| Cancel reaches the run | at its next progress call | at the next heartbeat or cancel poll; remote job deleted | at the next heartbeat |
| Waiting for a verdict | none | a poll loop (a copy) | a poll loop (the original) |
| Status words | queued, running, succeeded, failed, cancelled | queued, uploading, parsing, downloading, indexing, succeeded, failed, **canceled** | queued, running, succeeded, failed, cancelled |

Lifecycle writers also live outside the ledgers:

- `extraction/reextract.ts` requeues a finished job with its own SQL.
- The file-production fork reconciler (`reconcileStaleFileProductionJobs`, called from `conversation-forks.ts`) is a third stale-recovery variant.
- Account erasure's quiesce (`account-lifecycle/index.ts`) cancels extraction and file-production jobs with raw SQL of its own (`cancelActiveDocumentExtractionForUser`, `cancelActiveFileProductionForUser`, each with its kind's spelling), and Atlas through its ledger.

A caller inventory (2026-10-15) found the rest of the outside surface small and façade-shaped: the claim, heartbeat, complete, fail and recovery functions have no caller outside their own folder.

## Goals, non-goals, anti-goals

**Goals**

- One module owns the whole lifecycle: every state change of a job and every scheduling decision. A kind supplies only what is particular to it.
- A new kind is a definition plus a table built from the engine's column builders. No lifecycle code is copied.
- Nothing changes for the person using the app: file cards, Atlas progress and its push notification, upload readiness, Retry, Cancel, Dismiss, Regenerate, Re-extract, exports that belong to no reply. Same routes, same payloads, same words.
- Production's live rows keep working through the deploy, and each slice has a written rollback.
- The kinds that lacked a fix get it: Atlas gains attempts, a fencing token, a heartbeat timer, the periodic sweep, dead-worker reclaim, the wake-during-drain fix, the HMR-safe scheduler and a live switch.

**Non-goals**

- More parallelism. Each kind still runs one job at a time per process; the caps stay row counts (**my call**: keeps load on MinerU, the sandbox and the models exactly as today).
- A shared jobs table or JSON payloads (see Storage).
- Scheduled tasks themselves.
- A separate worker process, Redis, BullMQ or any queue system (ADR-0005's in-process SQLite worker stands).
- Changing ADR-0005: file production still never retries by itself.
- The ChatGPT import (see "The ChatGPT import" below).
- Routing regions (`routing/region-manager.ts`, table `routing_regions`). It is a durable state machine with attempts, `next_attempt_at` and backoff, but its row is a region, a resource with a lifecycle of its own (download, build, ready, idle-stopped), not a queue of jobs, and it has no lease or worker. Its build steps are a natural engine kind if they are ever rewritten; not in this run.

**Anti-goals** (a failure even if everything works)

- A "storage adapter per kind" in which each kind still writes its own lifecycle SQL. That is three copies behind a new name.
- Writing a job's status in two places (a mirror column, a shadow table).
- Any change to what the browser receives.
- A migration the old process cannot survive: deploys run `db:prepare` while the previous release keeps serving (and its workers keep claiming) for up to two minutes, through step 7b's stream drain in `scripts/deploy-dev.sh` and `scripts/deploy.sh`.

## The design

### The module

`src/lib/server/services/jobs/`, a deep module. Callers learn a small interface; behind it sit claiming and leases, attempts and fencing, heartbeats and abort reasons, progress, the retry decision path, stale recovery, dead-worker reclaim, lost-state recovery, wake and drain, the idle tick and its live-switch supervision, backoff timers, boot sweeps, HMR-safe scheduler state and verdict waiting.

The seam is the **kind definition**. Three adapters exist from day one (Atlas, extraction, file production), and the engine's own tests add a fourth (a test kind), so the seam is real.

### The interface

The shape the builder implements. Names may be refined; the behaviour and the small surface may not grow without a reason written in the plan.

```ts
// src/lib/server/services/jobs/index.ts: the only import path for every caller.

/** A kind is defined once, in its own folder (atlas/, extraction/, file-production/). */
export function defineJobKind<J extends JobTable, A extends JobAttemptTable>(
	definition: JobKindDefinition<J, A>,
): JobKind<J>;

export interface JobKindDefinition<J extends JobTable, A extends JobAttemptTable> {
	/** "atlas" | "extraction" | "file-production": worker ids, logs, tests. Stored nowhere. */
	name: string;
	/** Kept from today: "[ATLAS]", "[EXTRACTION]", "[FILE_PRODUCTION]". */
	logPrefix: string;
	/** The kind's two tables, built with jobColumns() and jobAttemptColumns(). */
	tables: { jobs: J; attempts: A };
	/** Re-read before every claim and on every tick. false = take no new work. */
	enabled(): boolean;
	/** Counted over rows, so they hold across processes. */
	limits(): { global: number; perUser?: number };
	/** heartbeatMs: how often a running attempt proves it is alive.
	 *  staleAfterMs: how long without a beat before the attempt is reclaimed. */
	lease(): { heartbeatMs: number; staleAfterMs: number };
	/** An extra claim condition. Atlas: the reply message is linked. */
	claimable?(jobs: J): SQL;
	/** Progress phases in order. A report may repeat a phase or move forward, never back. */
	phases?: readonly string[];
	/** The failure an attempt gets when the engine takes it back. */
	lostAttempt(reason: "stale" | "dead-worker" | "state-lost"): { code: string; message: string };
	/** Pure: what a failure does to the job. Called for every failure, whatever its source. */
	onFailure(failure: JobFailure, history: { attempts: number; state: unknown; nowMs: number }): FailureDecision;
	/** Which settled jobs the user's Retry may reopen, and whether this one may. */
	userRetry?: { from: ReadonlyArray<"failed" | "cancelled">; requireRetryable?: boolean; allow?(row: Row<J>): boolean };
	/** Domain columns kept in step with a transition, in the same transaction (Atlas: stage). */
	onTransition?(tx: Tx, row: Row<J>, to: JobStatus): void;
	/** The work. Loaded on first claim, so a read path never imports a renderer or the sandbox. */
	handler(): Promise<JobHandler<J>>;
	/** Extraction's direct-text runs: a job that may run inside the request that made it. */
	inline?: { eligible(row: Row<J>): boolean };
}

export type JobHandler<J extends JobTable> = (ctx: JobRunContext<J>) => Promise<void>;

export interface JobRunContext<J extends JobTable> {
	/** The row as claimed. */
	row: Row<J>;
	attempt: { id: string; number: number };
	/** Aborted at once when this process cancels the job, and at the next beat when the
	 *  lease is gone. signal.reason is "cancelled" or "lease-lost". After an abort the
	 *  handler stops; anything it still writes is refused. */
	signal: AbortSignal;
	/** Fenced. Moves the phase and/or replaces the checkpoint; counts as a beat.
	 *  false = this attempt no longer owns the job. */
	progress(update: { phase?: string; checkpoint?: unknown }): Promise<boolean>;
	/** Fenced domain write mid-run (Atlas: stage, progress, title). Counts as a beat.
	 *  This and the `apply` of `succeed` and `fail` may also write the kind's own extra
	 *  attempt columns (by `attempt.id`); lifecycle columns are only ever the engine's. */
	write(apply: (tx: Tx) => void): Promise<boolean>;
	/** Fenced. Settles the job succeeded and runs `apply` in the same transaction. */
	succeed(options?: { diagnostics?: unknown; apply?: (tx: Tx) => void }): Promise<boolean>;
	/** Fenced. Runs the kind's onFailure and writes its decision, with `apply` in the same transaction. */
	fail(failure: JobFailure, options?: { apply?: (tx: Tx) => void }): Promise<FailOutcome>;
}

export interface JobFailure {
	code: string;
	message: string;
	retryable: boolean;
	retryAfterMs?: number;
	diagnostics?: unknown;
	/** The checkpoint points at something that no longer exists (extraction: handleUnknown). */
	discardCheckpoint?: boolean;
}

export type FailureDecision =
	| { requeue: true; delayMs: number; code?: string; retryable?: boolean; state?: unknown }
	| { requeue: false; retryable: boolean; code?: string; state?: unknown };

export interface FailOutcome {
	/** false: the attempt no longer owned the job and nothing was written. */
	applied: boolean;
	requeued: boolean;
	runAfter: Date | null;
}

/* Starting, once per process, from hooks.server.ts init; stopping on sveltekit:shutdown
 * (no new claims, timers cleared; a running attempt is left to heartbeat recovery, ADR-0005). */
export function startJobs(kinds: readonly JobKind[]): Promise<void>;
export function stopJobs(): void;
/** Runs every claimable job of the kind now, one at a time, in the caller's async context.
 *  For tests and scripts; the scheduler drains on its own. */
export function drain(kind: JobKind): Promise<void>;

/* Callers. Every transition that leaves claimable work wakes the kind itself. */
export function enqueue<J>(kind: JobKind<J>, input: EnqueueInput<J>): Promise<{ row: Row<J>; reused: boolean }>;
export function cancel<J>(kind: JobKind<J>, jobId: string, scope: { userId: string }): Promise<Row<J> | null>;
export function cancelAll<J>(kind: JobKind<J>, scope: { userId: string; where?: (jobs: J) => SQL }): Promise<number>;
export function retry<J>(kind: JobKind<J>, jobId: string, scope: { userId: string }): Promise<Row<J> | null>;
export function reopen<J>(kind: JobKind<J>, jobId: string, input: ReopenInput<J>): Promise<Row<J> | null>;
export function wake(kind: JobKind): void;
export function waitForVerdict(kind: JobKind, jobId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ settled: boolean; status: JobStatus | null }>;
export function runInline(kind: JobKind, jobId: string, options: { budgetMs: number; signal?: AbortSignal }): Promise<void>;
/** Scoped recovery for a reader that must not show stuck work (the file-production fork snapshot). */
export function recover<J>(kind: JobKind<J>, options: { where?: (jobs: J) => SQL; queuedOlderThan?: Date }): Promise<{ recovered: number }>;
/** Pure facts for read models: terminal, may cancel, may retry. */
export function describeJob<J>(kind: JobKind<J>, row: Row<J>): { terminal: boolean; canCancel: boolean; canRetry: boolean };

/* Building a kind's tables. */
export function jobColumns(options?: JobColumnOptions): JobColumns;
export function jobAttemptColumns(options: JobAttemptColumnOptions): JobAttemptColumns;

export interface EnqueueInput<J> {
	/** The domain columns, userId included. Lifecycle columns are the engine's. */
	values: DomainInsert<J>;
	priority?: number;
	runAfter?: Date;
	/** Born settled: a request that failed validation, or a dedupe hit that is already done. */
	born?: { status: "failed"; code: string; message: string; retryable: boolean } | { status: "succeeded" };
	/** Race-safe idempotency, all in one transaction: find the job this request repeats and
	 *  say what to do with it. "insert" lets the kind release a key first (file production's
	 *  `#superseded:` rename) by writing in tx before it answers. */
	idempotency?: {
		find(tx: Tx): Row<J> | null;
		onExisting(tx: Tx, existing: Row<J>): "reuse" | "replace" | "insert";
	};
}

export interface ReopenInput<J> {
	userId: string;
	from: readonly JobStatus[];
	/** Checked in the transaction (file production: no file left and a request kept). */
	allow?(tx: Tx, row: Row<J>): boolean;
	/** Domain columns written in the same transaction (extraction: new hints). */
	patch?(row: Row<J>): Partial<DomainInsert<J>>;
	/** Cleared by default; extraction's re-extract and file production's regenerate both clear it. */
	keepCheckpoint?: boolean;
	/** The retry policy's memory, rewritten (extraction carries `waits` and clears `since`). */
	retryState?(state: unknown): unknown;
}
```

Fourteen functions, two column builders and one definition shape are the interface. Everything below is implementation.

### Storage: the kind tables share one lifecycle shape (my call)

Each kind keeps its own table and its own attempts table. The engine is written once, over any pair of tables built from its column builders, so there is one copy of every lifecycle query and many tables can run on it.

The planning session leaned towards one shared `jobs` table with domain rows keyed by job id. I rejected it for this run, for four reasons found in the code:

1. **The deploy window.** `db:prepare` runs while the previous release still serves and still claims (deploy step 7 before the 7b drain and the cutover). Copying rows into a new table at migration time misses whatever the old process does in the next two minutes, so a shared table needs a startup top-up that copies rows a second time: a runtime migration, which AGENTS.md forbids outside `db/compat.ts`.
2. **The read side.** Outside the three folders, six server modules query these tables directly (account lifecycle, home summary, the conversation list, the send route, forks, `read_generated_file`), so do two scripts, seven e2e specs that seed file-production rows and about 45 unit-test files. A shared table rewrites every one into a join and every fixture into two inserts. Keeping the tables leaves them untouched.
3. **Deletion.** The domain rows cascade differently (a file-production or Atlas job goes with its conversation; an extraction job survives with its conversation set to null). A shared table needs triggers to keep its rows 1:1 with three differently cascading tables.
4. **Rollback.** With the columns the old code reads still the ones the engine writes, a file-production or Atlas slice rolls back as plain code. A shared table makes every rollback a data restore.

What it costs: an engine generic over table pairs, and per-kind indexes. Both are written once. If a future kind ever wants a payload-only job with no table of its own, a generic table can be added as one more binding without touching the interface.

**The lifecycle shape.** Every kind's jobs table carries these columns, built by `jobColumns()`. The TypeScript property names are fixed; a kind may keep a legacy SQL name, so no existing column is renamed.

| Property | SQL name (default) | Type | Meaning |
|---|---|---|---|
| `id` | `id` | text PK | the job id |
| `userId` | `user_id` | text NOT NULL, FK users cascade | whose job: caps, fairness, scope |
| `status` | `status` | text NOT NULL | `queued`, `running`, `succeeded`, `failed`, `cancelled` |
| `phase` | `phase` | text | progress phase while running; left as it was when the job settles |
| `priority` | `priority` | integer NOT NULL default 0 | lower runs sooner |
| `runAfter` | `run_after` | timestamp | not claimable before this (backoff) |
| `attemptCount` | `attempt_count` | integer NOT NULL default 0 | attempts so far |
| `currentAttemptId` | `current_attempt_id` | text | the latest attempt; still set after the job settles |
| `retryable` | `retryable` | boolean NOT NULL default false | |
| `errorCode`, `errorMessage` | `error_code`, `error_message` | text | |
| `checkpoint` | `checkpoint_json` | text | resumable state: survives requeues, cleared when the job settles or is cancelled |
| `retryState` | `retry_state_json` | text | the retry policy's own memory |
| `cancelRequestedAt`, `startedAt`, `completedAt`, `createdAt`, `updatedAt` | same, snake case | timestamp | `startedAt` is the first claim |

Legacy SQL names kept: Atlas `retryable` is `error_retryable`; extraction `runAfter` is `next_attempt_at` and `checkpoint` is `remote_handle_json`; file production `phase` is `stage`. Every other missing column is added (`ALTER TABLE … ADD COLUMN`, safe for the old process).

`jobAttemptColumns()` builds the attempts table: `id`, `jobId` (FK to the kind's jobs table, cascade), `attemptNumber` (unique with `jobId`), `status` (`running`, `succeeded`, `failed`, `cancelled`), `phase` (file production keeps the SQL name `stage`), `workerId`, `claimedAt`, `heartbeatAt`, `startedAt`, `finishedAt`, `errorCode`, `errorMessage`, `retryable`, `diagnosticsJson`, `createdAt`, `updatedAt`; indexes on `(job_id, attempt_number)` unique, `(job_id, created_at)` and `(worker_id, status, heartbeat_at)`. A kind adds its own extra columns (extraction: `extractor`, `resumed`, `remote_handle_json`, `text_length`, `page_count`; file production: `mode`, `renderer`, `runtime`).

Each jobs table also gets the live partial index the claim and the idle tick read: `(status, priority, created_at) WHERE status = 'queued' OR status = 'running'`, spelled with `or` because SQLite only uses a partial index whose terms it can see in the query (measured in `file_production_jobs_live_claim_idx`'s comment).

Typing (left to the builder, suggested): declare one "shape" table from the same builders and use it as the engine's static type for every kind's table, so engine queries are ordinary Drizzle queries with no per-query casts. Drizzle renders SQL from the runtime column objects, so a legacy SQL name is honoured.

### Lifecycle

| From | To | Who | Notes |
|---|---|---|---|
| (new) | queued | `enqueue` | or born `failed` / `succeeded` |
| queued | running | the claim | a new attempt; `attemptCount` + 1; `startedAt` set once; error cleared |
| running | running | `progress`, `write`, a beat | fenced; phase only forward |
| running | succeeded | `succeed` | `completedAt`; error and checkpoint cleared; `retryState` kept |
| running | queued | `fail`, or the engine taking the attempt back, when `onFailure` requeues | `runAfter = now + delay`; error kept so the card can say it is retrying; checkpoint kept unless `discardCheckpoint` |
| running | failed | the same, when `onFailure` settles | `completedAt`; checkpoint cleared |
| queued, running | cancelled | `cancel`, `cancelAll` | attempt closed `cancelled`; error, checkpoint and `runAfter` cleared |
| failed, cancelled | queued | `retry` (the kind's `userRetry`) | error, `runAfter`, `cancelRequestedAt`, `completedAt` cleared; attempt numbers keep counting |
| any settled | queued | `reopen` (a kind's own rule) | file production's Regenerate, extraction's Re-extract |
| queued | failed | `recover` with `queuedOlderThan` | file production's fork snapshot only |

`currentAttemptId` always names the latest attempt (the file-production read model reads a succeeded job's warnings through it). The attempt number is one more than the highest number in the attempts table, not `attemptCount + 1`, so a count the old process left behind can never collide with the unique index; `attemptCount` is then set equal to it.

### Leases and fencing

- A claim opens an attempt with a worker id `<kind>:<host>:<pid>:<boot-nonce>` (`worker-identity.ts` moves into `jobs/`). Inline runs use `<kind>-inline:…` with the same boot nonce.
- Every write an attempt makes is fenced in one transaction: the job is `running`, its `currentAttemptId` is this attempt, the attempt is `running` and carries this worker id. A late write by a run that lost its lease changes nothing and reports `false`.
- The runner beats on a timer of its own (`heartbeatMs`, at least 250 ms), independent of the handler, so the lease measures whether the process is alive, not how long a step takes. `progress` and `write` also count as beats.
- A beat that finds the claim gone aborts the attempt's signal: `"cancelled"` when the job is cancelled, `"lease-lost"` otherwise. A beat whose write fails (`SQLITE_BUSY`) is logged and the run continues; if no beat has succeeded for half of `staleAfterMs`, the runner aborts with `"lease-lost"`. Nothing un-awaited may reject unhandled (one did once, and Node 22 exits on it).
- No transaction is held across an `await` (better-sqlite3 transactions are synchronous; `write-lock.ts` already makes every one take the write lock at BEGIN).

The engine takes an attempt back in three ways, all through one transition that closes the attempt as failed with the kind's `lostAttempt(reason)` code and hands that failure to `onFailure`:

1. **stale**: a running attempt whose last beat is older than `staleAfterMs`. Run at boot, again `staleAfterMs` after boot (the attempts the restart itself orphaned look healthy at boot), on the idle tick when a running row exists, and between empty drains at most once per tick.
2. **dead-worker**: at boot, a running attempt whose worker id names this host, a pid that no longer exists, and not this process. An id in an older format, or from another host, waits for the stale path. `EPERM` from `kill(pid, 0)` means alive.
3. **state-lost**: a running job whose current attempt row is missing or no longer running (every Atlas row that is running at the cutover, since Atlas has no attempts today). At boot it takes back every such row, since nothing of this process is running yet. Everywhere else (the follow-up sweep, the idle tick, between drains, a scoped `recover`) it takes back only rows whose `updated_at` is older than `staleAfterMs`, as the file-production fork reconciler does today, so a row another writer has just made is left alone (**my call**, from the builder check: an e2e spec seeds such a row into a live server).

### Failures and retries

One path. `ctx.fail`, a handler that throws (mapped to `{ code: "job_failed", retryable: true }` unless the kind's handler maps its own errors first), and the three take-backs all reach the kind's `onFailure`, a pure function the engine calls inside the transaction with the attempt count and the policy's `retryState`.

- **File production** (ADR-0005): never requeues. The job settles `failed` with the failure's own `retryable`; a take-back is retryable (`worker_heartbeat_timeout`, "File production worker stopped before finishing." / "File production stopped when the server restarted."; lost state is `worker_state_lost`).
- **Extraction**: today's `decideExtractionRetry`, unchanged: exponential backoff with jitter, `retryAfterMs`, the attempt budget, the outage window and its separate budget. Its outage memory moves from the reserved `$outage` key in `hints_json` to `retry_state_json`. A take-back is `stale_worker`.
- **Atlas** (**my call**): a pipeline failure settles `failed` and retryable, as today. A take-back requeues at once while the job has had fewer than 3 attempts, then settles `failed`, retryable, `atlas_worker_heartbeat_timeout`. Today it requeues forever, so a job that kills the process would be retried at every restart.

The user's **Retry** reopens through `userRetry`: file production from `failed` when retryable; extraction from `failed` or `cancelled` while the job has document attempts left under its ceiling (`extractionAttemptCeiling`, discounted by outage waits). **Reopen** carries the two rules that are not a Retry: file production's Regenerate (a succeeded job with no file left and a request kept) and extraction's Re-extract (a settled job, the ceiling, the per-user limit on re-extractions in flight, new hints, the outage window cleared and `waits` carried). `extraction/reextract.ts` stops writing lifecycle columns itself.

### Cancel

`cancel` settles a queued or running job `cancelled` in one transaction (attempt closed `cancelled` with code `cancelled`; error, checkpoint and `runAfter` cleared; `cancelRequestedAt` kept if set). When this process is running that attempt, its signal aborts at once with `"cancelled"` (today the run waits for its next heartbeat or progress call). A handler reacts to the reason: extraction asks the backend to delete its remote job on `"cancelled"` (unless the extractor already does on abort) and never on `"lease-lost"`, because the next attempt resumes that remote job from the checkpoint. File production's renderers and sandbox already take the signal. The Atlas pipeline does not (**my call**: threading it through `atlas-v3/` is a separate job), so Atlas notices a cancel at its next `ctx.write`, which returns false, as it does today at its next heartbeat callback.

`cancelAll` is the same transition over a user's queued and running jobs, optionally narrowed by a domain condition (Atlas: one conversation). Account erasure's quiesce (ADR-0030) calls it for each kind, replacing the raw cancel SQL in `account-lifecycle/index.ts`; conversation cleanup calls it for Atlas before deleting the conversation's Atlas rows, as today. An in-process attempt of a cancelled job aborts at once, which today's raw updates could not do.

### The scheduler

One state object per process on `globalThis` under a `Symbol.for` key, so a double import and an HMR re-evaluation both find it. Per kind:

- **Drain**: one loop, one job at a time. It claims until nothing is claimable; between empty drains it runs the stale sweep at most once per idle tick; a sweep that requeued work continues the loop. A wake during a drain is remembered and honoured after it.
- **Idle tick**: one unref'd interval per kind, `heartbeatMs × 2` clamped to 5–60 s. It also supervises the enable switch in both directions: off stops arming work (a running attempt finishes and reports), on does a full start with sweeps. One aggregate query answers "anything to do, and if not yet, when" over the live partial index; an idle box does one index probe per kind per tick and logs nothing.
- **Backoff timer**: at most one per kind, armed for the earliest future `runAfter` plus one second (timestamps have one-second resolution), at most an hour per hop.
- **Boot** (`startJobs`): per enabled kind, dead-worker reclaim, the stale sweep, the follow-up sweep after `staleAfterMs`, the idle tick, a drain. A disabled kind gets only the idle tick, which notices the switch.
- **Wake**: every transition that leaves claimable work (enqueue, requeue, retry, reopen, a linked Atlas reply) wakes its kind after the commit. Callers stop calling wake functions. A wake does nothing in a process that never called `startJobs`: it is only counted (**my call**: `scripts/backfill-extractions.ts` reopens jobs from the command line and must never become a second worker, a bug it once had). `drain` is the explicit way to run work in such a process.
- **Inline**: `runInline` claims one eligible job by id, past the caps, and runs it in the caller's async context under the inline worker id; the caller waits at most `budgetMs` and the run finishes in the background if the budget runs out.
- **Not serving** (vitest, `NODE_ENV=test`, the build's analysis): nothing is scheduled and wakes are counted and dropped, unless a test starts the engine on purpose. Test helpers reset and inspect the state as today's do.

### Reading state and waiting

Read models keep selecting their own columns; nothing about the tables they read changes except the new columns and extraction's status words. They use `describeJob` for derived facts (may retry, may cancel) instead of re-deriving them.

`waitForVerdict` resolves when the job settles or the timeout passes. It listens to the engine's in-process settle events and polls the row once a second as a fallback, so a verdict written by the same process arrives at once instead of on the next 100 ms poll. Both current wait helpers (`file-production/job-wait.ts`, `extraction/job-wait.ts`) go.

### What each kind keeps

| Kind | Stays in its folder |
|---|---|
| Atlas (`atlas/`) | the kickoff identity and title, the reply-message link (which now wakes the kind), the claim condition, the v3 pipeline handler, checkpoints, usage and output ids written on success, analytics and the push notification after a success that applied, conversation and user deletes, the read model |
| Extraction (`extraction/`) | intake (`startUploadExtraction`, readback), the extractor handler with its phases and remote handle as checkpoint, the retry policy and ceilings, hints, legacy materialisation (an enqueue born `failed`), the readback sink, Re-extract's rule, inline direct text, the read model and its DTO (which keeps `canceled` and the phase words) |
| File production (`file-production/`) | intake and validation (born-failed jobs), idempotency keys with the `usable` rule and key release, the execution handler (renderers, sandbox, storage, memory sync), produced-file links and the chat files' reply message on success (in `succeed`'s transaction), warnings as attempt diagnostics, Dismiss, Regenerate's rule, export jobs that belong to no reply (`ARTIFACT_EXPORT_JOB_ORIGIN`), job-to-reply assignment, the fork snapshot's scoped `recover`, the read model and legacy backfill |

Each kind's definition lives in a file named for its domain (`atlas/research-job.ts`, `extraction/extraction-job.ts`, `file-production/production-job.ts`), not a shared name, so Fallow sees no mirrored directories. The domain folders lose `job-ledger.ts`, `worker-runner.ts` and `job-wait.ts`; what remains of a ledger is domain transitions only, in files named for what they do.

### Migration and deploy

Each kind moves in its own slice with its own migration, and every migration is expand-only, so the old process survives the two-minute window:

- **Atlas**: `CREATE TABLE atlas_job_attempts`; `ALTER TABLE atlas_jobs ADD COLUMN` for `current_attempt_id`, `attempt_count`, `run_after`, `priority`, `phase`, `checkpoint_json`, `retry_state_json`; the live partial index. The job-level `worker_id` and `heartbeat_at` columns stop being written and stay until a later cleanup. Running Atlas rows at the cutover have no attempt and are taken back as state-lost, which requeues them (today's boot behaviour).
- **Extraction**: `ADD COLUMN phase`, `ADD COLUMN retry_state_json`; then the one data rewrite of this work: active statuses become `running` with the word in `phase`, `canceled` becomes `cancelled` (jobs and attempts), and `$outage` moves out of `hints_json` into `retry_state_json`. The rewrite is in the migration because `db:prepare` stays the real migration path (AGENTS.md). The old process may write the old words in the window, so `db/compat.ts` (the one sanctioned home for a bounded startup shim, noted in the README) re-applies the same idempotent statements once at startup, before `startJobs`. It is removed in the cleanup after production has run this release.
  - What the old process does in the window, checked against its code: an attempt it is running fails its own ownership check at its next heartbeat (the row now says `running`), aborts as "claim lost" without a verdict and keeps the remote handle; the new process reclaims it as a dead worker's and resumes it from the checkpoint. A claim it makes writes a phase word and a cancel writes `canceled`; the shim rewrites both. For up to two minutes its read model shows the new words and its Retry refuses a `cancelled` job.
  - If the deploy's health check fails and the script rolls back to the previous release automatically, the old code meets rewritten rows. The deploy step watches for that and then runs `rollback-extraction.sql` by hand (**my call**: the rollback logic belongs to the release being replaced, so this deploy cannot add a hook to it).
- **File production**: `ADD COLUMN` for `attempt_count` (backfilled from the attempts table), `run_after`, `priority`, `checkpoint_json`, `retry_state_json`, `started_at`; the live partial index widened to `(status, priority, created_at)`. Since the engine numbers attempts from the attempts table, an `attempt_count` the old process left behind cannot collide.
- Every slice writes `docs/plans/jobs-merge/rollback-<kind>.md`: Atlas and file production roll back as code (the old code reads the columns the engine writes and ignores the new ones); extraction's needs a reverse SQL file (`running` + phase back into status, `cancelled` back to `canceled`, `retry_state_json` back into `hints_json.$outage`), tested against a copy of a migrated database.
- Later, not in this run: drop Atlas's dead columns, remove the compat shim, after production has run the release.

### The ChatGPT import

Not included (**my call**). `import_jobs` is a progress and audit row, not this lifecycle: `POST /api/chat/import` awaits the whole import in the request; nothing claims, leases, heartbeats, retries, cancels or recovers it; nothing exposes the row to the browser (the import dialog fakes its progress and ignores the job id). Making it a kind would be new behaviour (a worker, a poll, a progress route), not a merge. It has a defect worth a separate small fix: a restart mid-import leaves the row `processing` forever, and the detached embedding and summary work it starts is lost.

### The domain façades stay

`atlas/index.ts`, `extraction/index.ts` and `file-production/index.ts` keep their function names and contracts, so routes, chat-turn code, forks, Atlas's output step and the façade-level tests (`file-production/index.test.ts` alone is 111 KB) are the regression net, not something to rewrite. Each façade function is reimplemented on the engine. The worker functions (`ensure…Worker`, `wake…Worker`, `drain…Worker`) become `startJobs`, the engine's own waking, and `drain`; a façade may keep a one-line delegate where many tests call it.

Structure the code already pins, which the slices keep or update in the same commit:

- The ledger side stays import-light: `extraction/boundary.test.ts`, `file-production/obsolete-surfaces.test.ts` and `mixed-output-groups.test.ts` read source text to keep worker, renderer and extractor imports out of the read path. The engine's `index.ts` imports no kind's handler; a kind's definition loads its handler lazily.
- Path-keyed lists: `tests/cross-cutting/incognito-artifact-containment.test.ts` (names `extraction/{job-ledger,read-model,worker-runner}.ts`; it also fails if its exemption list grows), `.fallowrc.json` (file-production façade entries), `src/lib/shared/extraction-status.test.ts`, `scripts/prepare-db.ts` (required tables and columns), `account-lifecycle/user-scoped-tables.ts`.
- `src/lib/shared/extraction-status.ts` keeps `canceled` and the phase words as the DTO's vocabulary; only the stored words change, and the extraction read model maps them.
- `scripts/backfill-extractions.ts` queries the extraction tables directly and moves with the extraction slice.
- `conversation-forks.ts` copies settled file-production job and job-file rows into a fork (and refuses a fork while a job is live). Copying a settled row is a snapshot, not a transition: it is the one named exception in the one-writer scan.
- `atlas/output-files.ts` calls `drainFileProductionWorker` and the file-production wait helper; the Atlas slice leaves those calls on the file-production façade, and the file-production slice replaces them with the engine's wake and `waitForVerdict`.

### Observability

The engine logs with the kind's prefix, keeping today's events and message texts where tests pin them (`worker-runner.logging.test.ts` in extraction and file production): worker started, paused, claimed, attempt failed, requeued until a time, will not be retried, reached max attempts, reclaimed stale attempts (count, reason), reclaimed attempts from a dead worker, cancel honoured, released without a verdict, heartbeat write failed, drain failed, idle tick failed. An empty sweep logs nothing.

### Testing

- The engine is tested at its interface with a test kind whose two tables come from the same builders, created in the test database by the test (not in `schema.ts`, so no migration). Claim order, caps and fairness; fencing of late writes; beats and abort reasons; the three take-backs through `onFailure`; requeue and the backoff timer; cancel's immediate abort; retry and reopen; idempotent enqueue (reuse, replace, insert, born states); a wake during a drain; the switch both ways; an HMR re-evaluation; `waitForVerdict` by event and by poll; `runInline` past the caps.
- A kind slice deletes the ledger, worker and wait tests the engine's tests now cover (replace, don't layer), keeps its domain tests, and tests its handler and policy through the engine.
- A source scan keeps one writer: no file outside `services/jobs/` writes a lifecycle column of a kind table or of its attempts table (`status`, `currentAttemptId`, `attemptCount`, `runAfter`, `checkpoint`, `retryState`, `heartbeatAt`, `workerId` and the rest of the shape), with born rows going through `enqueue`. A kind's own extra columns are its to write.
- Each slice runs `scripts/gates.sh agent` with the e2e specs of its area; the integration branch runs the release gate before the deploy.

## Slices and order (my call)

| Slice | What | Shippable alone because |
|---|---|---|
| S1 | `services/jobs/` (engine, builders, test kind, `worker-identity.ts` moved, `jobs/AGENTS.md`) | nothing runs on it yet |
| review | Opus adversarial review of S1: leases, fencing, recovery, scheduler | |
| S2 | Atlas on the engine, with its migration | Atlas runs end to end on the engine |
| S3 | Extraction on the engine, with its migration, compat shim and rollback SQL | uploads run end to end on the engine |
| S4 | File production on the engine, with its migration | file cards run end to end on the engine |
| review | Opus review of the three migrations, the shim and the rollbacks | |
| ship | merge into `dev`, release gate, push, deploy to ai.dev, live checks | |

S2 and S3 run side by side after S1's review (disjoint folders; each owns its own migration number). S4 waits until the upload-analysis session (`Add analysis of uploaded files in the sandbox`), which may change `file-production/`, has been told and has said whether it has work in flight there. If S4 is held (by that session or by the budget), S1 to S3 ship to ai.dev on their own (**my call**): each slice leaves the app whole.

Atlas's lease is constants in `atlas/config.ts` (heartbeat 15 s, stale after 120 s, the file-production defaults), not new admin keys (**my call**: a new setting is a five-file change under AGENTS.md, and nobody has asked to tune Atlas's lease). Extraction keeps writing its diagnostic attempt columns (`extractor`, `resumed`, `text_length`, `page_count`) through `write` and `apply`. It stops writing the attempt-level copy of the remote handle, which nothing reads now that the job's checkpoint holds it (**my call**); the column stays.

## Risks

- **The engine's generic table typing** stalls an agent in Drizzle's types. Mitigation: the shape-table approach above, and S1's brief names it.
- **A behaviour drift hidden by a passing suite.** Mitigation: replace-don't-layer keeps the domain tests; each slice runs its area's e2e specs; the live checks on ai.dev drive a real upload, a real file and a real Atlas run.
- **Extraction's vocabulary rewrite.** The only data rewrite. Mitigation: SQL plus the startup shim for the window, a reverse script, a test on a copy of a migrated database, and the Opus review.
- **Budget.** The weekly limit was at 72% on 2026-10-15 (resets 2026-10-19 09:00 UTC). Estimated cost per slice is in the plan; the run pauses rather than starting a slice the week cannot finish.

## Left to the builder

The file split inside `services/jobs/`; the exact Drizzle typing technique; one idle-tick interval per kind or one shared; the test kind's table names; log texts that no test pins; the internal names of anything not in the interface above.
