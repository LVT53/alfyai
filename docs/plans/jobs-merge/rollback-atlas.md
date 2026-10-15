# Rolling back slice S2 (Atlas on the job engine)

Migration `1777140000114_atlas_jobs_on_engine`. It is expand-only: a new table (`atlas_job_attempts`), seven new columns on `atlas_jobs` (`current_attempt_id`, `attempt_count`, `run_after`, `priority`, `phase`, `checkpoint_json`, `retry_state_json`) and one partial index (`atlas_jobs_live_claim_idx`). Nothing was dropped or renamed.

**There is no data rollback.** Roll the code back and leave the migration in place. The previous release names only the columns it knew, and every new column is nullable or has a default (`src/lib/server/db/atlas-jobs-engine-migration.test.ts` replays the old ledger's statements against the migrated table). Its deletes still work: `atlas_job_attempts` cascades from `atlas_jobs`, and the foreign keys are enforced.

**There is no step to run either.** The engine's kind sets `heartbeat_at` to the time of every transition, so the previous release's boot recovery (`status = 'running' AND heartbeat_at < now`) requeues a row the engine left running like any other (details below).

## What the previous release does with the rows the engine left

| Row the engine left | The previous release |
|---|---|
| `queued`, reply message linked (new, or put back by a take-back, with the `atlas_worker_heartbeat_timeout` error on it) | Claims it as it claims any queued row. `run_after` and `priority` are ignored; a take-back's `run_after` is the moment it was put back, so nothing waits. |
| `queued`, reply message not linked yet | Leaves it, as always. |
| `succeeded`, `failed`, `cancelled` | Reads them unchanged: `status`, `stage`, `error_code`, `error_message`, `error_retryable` (the engine's `retryable` property is the same column), the usage, source and output columns. |
| `running`, owned by the engine | Requeues it at its boot, like a row it left itself (next section), and claims it again. |

## Why a job the engine left running is not stranded

The previous release's boot recovery is `UPDATE ... WHERE status = 'running' AND heartbeat_at < now`: it takes back every running row, because the process that held them is dead by then. The engine's kind clears the job-level `worker_id` on every transition (the fence ruling in `design.md`, "After the engine review": a process still running the old ledger can then never match a row on `worker_id`) and sets `heartbeat_at` to the time of the transition, so a row the engine is running carries the time it was claimed and that recovery finds it, as it finds a row the previous release left. The rollback therefore needs no SQL step for running rows: a `NULL` heartbeat would have stranded them (`NULL < now` is not true), and the engine does not leave one.

The card goes back to `queued` with the `atlas_worker_heartbeat_timeout` error on it, as it does after a restart of the previous release, and the job runs again from the start. Check afterwards with `SELECT status, count(*) FROM atlas_jobs GROUP BY status;` (no `running` row that is not being worked on).

What the stamp costs: the previous release's boot recovery does not look at `worker_id`, so a process on the old code that boots while the engine is running a job would requeue it, and the engine's run would find its claim gone and stop. The deploy never produces that (`systemctl restart` stops one process before it starts the next).

## Rolling forward again

The first engine boot takes back whatever the previous release left `running` (a row with a job-level `worker_id` and no attempt is "state lost", taken back at boot with no age guard) and requeues it, once. Attempt numbers are one more than the highest in `atlas_job_attempts`, so attempts left from the first run never collide. The attempts the engine had open when it was rolled back stay `running` in `atlas_job_attempts` (the previous release ignores the table) and are harmless: no engine query reads an attempt whose job is not running under it.

## Not part of this rollback

`atlas_jobs.worker_id` and `atlas_jobs.heartbeat_at` stay in the table. Nothing reads them but the previous release (its fence and its boot recovery); a later cleanup drops them once production has run this release.
