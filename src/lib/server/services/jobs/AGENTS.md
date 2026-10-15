# Job engine

Parent: [services/AGENTS.md](../AGENTS.md). Decision: [ADR-0069](../../../../../docs/adr/0069-background-work-runs-on-one-job-engine.md). Design and plan: [`docs/plans/jobs-merge/`](../../../../../docs/plans/jobs-merge/).

All background work (Atlas research, document extraction, file production, and the next feature) runs here. A **kind** is defined once, in its own folder, and the engine owns every lifecycle transition and every scheduling decision. Nothing outside this folder changes a job's status, claims, beats, retries, cancels, recovers or schedules.

## The interface

Everything a caller uses is exported from [`index.ts`](./index.ts), which imports no kind and no handler:

- Define: `defineJobKind(definition)`; build a kind's tables with `jobColumns()` and `jobAttemptColumns()` (plus `liveClaimIndex` and `jobAttemptIndexes` for their indexes).
- Start and stop, once per process from `hooks.server.ts`: `startJobs(kinds)`, `stopJobs()`. `drain(kind)` runs the claimable jobs now (tests, scripts).
- Act: `enqueue`, `cancel`, `cancelAll`, `retry`, `reopen`, `recover`, `wake`, `runInline`, `waitForVerdict`; read: `describeJob`.

A kind's `JobKindDefinition` supplies only what is particular to it: tables, `enabled()`, `limits()`, `lease()`, an optional `claimable` condition, `phases`, `lostAttempt(reason)`, the pure `onFailure(failure, history)` policy, `userRetry`, `onTransition`, a lazily loaded `handler()` and `inline`. The handler gets a `JobRunContext`: `row`, `attempt: { id, number }`, `signal`, and the fenced `progress`, `write`, `succeed` and `fail`.

A kind's two tables are declared in `schema.ts` (with a hand-written, expand-only migration) from the builders; its definition and its handler live in its own folder:

```ts
// schema.ts
export const widgetJobs = sqliteTable(
	"widget_jobs",
	{
		...jobColumns({ userId: () => users.id, sqlNames: { retryable: "error_retryable" } }),
		title: text("title").notNull(), // the kind's domain columns
	},
	(table) => ({ liveClaimIdx: liveClaimIndex("widget_jobs_live_claim_idx", table) }),
);
export const widgetJobAttempts = sqliteTable(
	"widget_job_attempts",
	{
		...jobAttemptColumns({ jobId: () => widgetJobs.id }),
		extractor: text("extractor"), // the kind's own attempt columns: nullable or defaulted
	},
	(table) => ({ ...jobAttemptIndexes("widget_job_attempts", table) }),
);

// widget/widget-job.ts
export const widgetJob = defineJobKind({
	name: "widget",
	logPrefix: "[WIDGET]",
	tables: { jobs: widgetJobs, attempts: widgetJobAttempts },
	enabled: () => getConfig().widgetWorkerEnabled, // read live, before every claim and on every tick
	limits: () => ({ global: 2, perUser: 1 }), // counted over rows, across processes
	lease: () => ({ heartbeatMs: 15_000, staleAfterMs: 120_000 }),
	lostAttempt: () => ({ code: "widget_worker_lost", message: "The widget worker stopped before finishing." }),
	onFailure: (failure, { attempts }) =>
		attempts < 3 ? { requeue: true, delayMs: 0 } : { requeue: false, retryable: failure.retryable },
	handler: () => import("./widget-runner").then((module) => module.runWidget), // loaded on first claim
});
```

Where the kinds are defined (each in a file named for its domain, not a shared name): `atlas/research-job.ts`, `extraction/extraction-job.ts`, `file-production/production-job.ts`. All three run on the engine, started once from `hooks.server.ts`. The engine's own test kind is `testing/test-kind.ts`.

The rows `enqueue`, `cancel`, `retry`, `reopen` and the claim (`ctx.row`) hand back are read again after `onTransition` ran, in the same transaction, so they carry the domain columns the hook wrote (Atlas's `stage`) and a caller needs no second read.

## Files

| File | Owns |
|---|---|
| `columns.ts` | the lifecycle shape: column builders, the live partial index, the shape tables used for typing. Imports nothing from the app (`schema.ts` imports it) |
| `types.ts` | every type of the interface |
| `define.ts` | `defineJobKind`: validation and the one cast from a kind's tables to the shape |
| `ledger.ts` | every state change of a job and its attempts, each one transaction: enqueue, claim, the fenced writes, cancel, retry, reopen, and `applyFailure`, the only path from running to queued or failed |
| `recovery.ts` | taking an attempt back (stale, dead-worker, state-lost) and the scoped `recover` |
| `runner.ts` | one claimed attempt: the context, the heartbeat timer, the abort reasons, what the handler's end means |
| `scheduler.ts` | wake, drain, idle tick, backoff timer, boot, inline, stop; test helpers |
| `state.ts`, `events.ts`, `wait.ts` | the per-process state on `globalThis`, settle events, `waitForVerdict` |
| `worker-identity.ts` | worker ids `<slice>:<host>:<pid>:<boot-nonce>` and "is that process gone" |
| `testing/` | the test kind, the fixture database, the harness every engine test boots the engine with |

## Rules

- **One writer.** No code outside this folder writes a lifecycle column of a kind's jobs table, a lifecycle column of its attempts table, or inserts into either. A job is born through `enqueue` and an attempt through the claim. `one-writer.test.ts` scans the source and fails on a new writer; its `ALLOWED` list can only shrink. A kind writes its own domain columns freely, and its own extra attempt columns (`extractor`, `mode`…) inside the `apply` of `ctx.write`, `ctx.succeed` and `ctx.fail`, which run in the engine's fenced transaction; those columns must be nullable or have a default, because the claim inserts the attempt without them.
- **Every failure goes through `onFailure`.** `ctx.fail`, a handler that throws (`job_failed`), a handler that returns without a verdict (`no_verdict`), and the three take-backs all reach the kind's pure policy, which decides requeue or settle. File production never requeues (ADR-0005). The one exception is `recover`'s `queuedOlderThan`, where the caller asked for old queued jobs to fail and no attempt ever ran.
- **A policy must be bounded.** A requeue with no delay is claimable at once, so a policy that keeps requeueing a job whose handler never succeeds would spin. Atlas's lost-attempt limit and extraction's backoff are bounded; a drain also ends after claiming the same job ten times in a row (the next tick drains again), which is a safety net and not a substitute for a limit in `onFailure`.
- **No transaction across an `await`.** Every ledger function is one synchronous better-sqlite3 transaction (`db/write-lock.ts` takes the write lock at BEGIN). Callbacks that run inside one (`apply`, `find`, `onExisting`, `patch`, `allow`, `retryState`, `onTransition`) are synchronous; one that returns a promise is refused (by its type, or at run time for `apply`, `retryState` and `onTransition`, whose types an async function satisfies). `onTransition` and `apply` must not call the engine.
- **Every write an attempt makes is fenced**: the job is `running`, points at this attempt, the attempt is `running` under this worker id. A write that finds the claim gone changes nothing and says so; the runner then aborts the signal (`"cancelled"` if the job was cancelled, else `"lease-lost"`) and refuses everything the handler still writes. Never write around the fence.
- **The heartbeat is the runner's**, on a timer of its own, so the lease measures whether the process is alive and not how long a step takes. A beat that cannot be written is logged and survived until half the stale window has passed; nothing un-awaited may reject (Node 22 exits on an unhandled rejection).
- **Cancel reaches the run at once** in the process that has it, by aborting the signal after the commit. A handler reacts to `signal.reason`: remote cleanup on `"cancelled"`, never on `"lease-lost"` (the next attempt resumes the remote job from the checkpoint).
- **An abort listener a handler adds to `ctx.signal` must not throw.** Node's `EventTarget` turns a throw in a listener into an uncaught exception, which ends the process: catch inside it, and never let an async one reject.
- **A wake does nothing until `startJobs`.** `wake(kind)`, and the wake inside `enqueue`, `retry`, `reopen` and `recover`, only counts the request in a process that has not started the kind, so a script that reopens a job never becomes a second worker. `drain(kind)` is explicit and works without `startJobs`. Nothing is scheduled under vitest or `NODE_ENV=test` unless a test starts the engine on purpose.
- **Take-backs.** `stale` and `dead-worker` as in the design. The lost-state take-back (a running job whose current attempt row is missing or no longer running) has no age guard at boot, and everywhere else (boot follow-up, idle tick, between drains, `recover`) only takes rows nobody has touched for `staleAfterMs`.
- **Migrations are expand-only** (`ADD COLUMN`, `CREATE TABLE`, `CREATE INDEX`, `DROP INDEX`; no drop, no rename): the previous release keeps serving and claiming for up to two minutes after `db:prepare`. Legacy SQL names stay (`jobColumns({ sqlNames })`); a kind's table passes `userId: () => users.id` for the foreign key.
- **The engine imports no kind.** A kind's definition loads its handler lazily, so a read path never imports a renderer or the sandbox. `columns.ts` must never import `schema.ts`.
- **Scheduler state is on `globalThis`** under a `Symbol.for` key (`state.ts`): a double import and an HMR re-evaluation must find the same timers. Do not add a module-level binding for anything a second instance has to see.
- **Log prefixes** stay the kind's (`[ATLAS]`, `[EXTRACTION]`, `[FILE_PRODUCTION]`); an empty sweep or an idle tick logs nothing. Keep the event texts in `runner.ts` and `scheduler.ts` where a kind's logging test pins them.

## Testing

Engine tests boot the engine through [`testing/harness.ts`](./testing/harness.ts) (`bootEngine`): a migrated fixture database plus the test kind's two tables from hand-written DDL (not in `schema.ts`, so no migration), the module registry reset so the engine opens its own connection. `bootSecondProcess()` opens another, for tests of claims across processes. Scheduler and runner tests use fake timers installed after boot, and `startJobs(kinds, { startInNonServingContextForTests: true })`. A kind's slice tests its handler and policy through the engine (`drain(kind)`), and deletes the ledger, worker and wait tests the engine's tests now cover.
