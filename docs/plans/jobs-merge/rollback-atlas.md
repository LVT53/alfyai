# Rolling back slice S2 (Atlas on the job engine)

Migration `1777140000114_atlas_jobs_on_engine`. It is expand-only: a new table (`atlas_job_attempts`), seven new columns on `atlas_jobs` (`current_attempt_id`, `attempt_count`, `run_after`, `priority`, `phase`, `checkpoint_json`, `retry_state_json`) and one partial index (`atlas_jobs_live_claim_idx`). Nothing was dropped or renamed.

**There is no data rollback.** Roll the code back and leave the migration in place. The previous release names only the columns it knew, and every new column is nullable or has a default (`src/lib/server/db/atlas-jobs-engine-migration.test.ts` replays the old ledger's statements against the migrated table). Its deletes still work: `atlas_job_attempts` cascades from `atlas_jobs`, and the foreign keys are enforced.

## What the previous release does with the rows the engine left

| Row the engine left | The previous release |
|---|---|
| `queued`, reply message linked (new, or put back by a take-back, with the `atlas_worker_heartbeat_timeout` error on it) | Claims it as it claims any queued row. `run_after` and `priority` are ignored; a take-back's `run_after` is the moment it was put back, so nothing waits. |
| `queued`, reply message not linked yet | Leaves it, as always. |
| `succeeded`, `failed`, `cancelled` | Reads them unchanged: `status`, `stage`, `error_code`, `error_message`, `error_retryable` (the engine's `retryable` property is the same column), the usage, source and output columns. |
| `running`, owned by the engine | **Stranded. See the next section.** |

## The one thing to do: requeue what the engine left running

The engine's kind clears the job-level `worker_id` and `heartbeat_at` on every transition (the fence ruling in `design.md`, "After the engine review": a process still running the old ledger can then never match a row on `worker_id`, and the old boot recovery cannot take it). That is also why the previous release's boot recovery, `UPDATE ... WHERE status = 'running' AND heartbeat_at < now`, does not see a row the engine is running: `NULL < now` is not true. The plan's line "its boot requeues every running row" holds for rows the previous release itself left (they carry a heartbeat), and not for rows the engine left.

So a job that was running when the code was rolled back stays `running` for good under the previous release: the card keeps showing it in progress, and it holds one of the two global Atlas slots (`ATLAS_GLOBAL_ACTIVE_LIMIT`) until someone clears it. Run this once, after the new process has stopped (or at any later time; the previous release never touches these rows):

```sql
-- Put back what the engine left running, the way the old boot recovery does.
UPDATE atlas_jobs
SET status = 'queued', stage = 'queued', progress_percent = 0,
    progress_details_json = '{}', worker_id = NULL, heartbeat_at = NULL,
    started_at = NULL,
    error_code = 'atlas_worker_heartbeat_timeout',
    error_message = 'Atlas worker heartbeat timed out before completion.',
    error_retryable = 1, updated_at = unixepoch()
WHERE status = 'running' AND heartbeat_at IS NULL;

-- Close the attempts those rows had; the previous release ignores the table.
UPDATE atlas_job_attempts
SET status = 'failed', finished_at = unixepoch(),
    error_code = 'atlas_worker_heartbeat_timeout',
    error_message = 'Atlas worker heartbeat timed out before completion.',
    retryable = 1, updated_at = unixepoch()
WHERE status = 'running';
```

`heartbeat_at IS NULL` is exact: a row with a heartbeat was written by the previous release and its own boot recovery handles it. Check afterwards with `SELECT status, count(*) FROM atlas_jobs GROUP BY status;` (no `running` row that is not being worked on).

If this ever matters more than the insurance it buys, the alternative is for `onTransition` to stamp `heartbeat_at` with the transition time instead of clearing it: the fence is `worker_id` (still cleared), the previous release's boot recovery then takes the row back, and only the case "an old process boots while the engine is running a job" (which the deploy never produces: `systemctl restart` stops one before it starts the other) would lose its protection.

## Rolling forward again

The first engine boot takes back whatever the previous release left `running` (a row with a job-level `worker_id` and no attempt is "state lost", taken back at boot with no age guard) and requeues it, once. Attempt numbers are one more than the highest in `atlas_job_attempts`, so attempts left from the first run never collide. If the SQL above was not run, orphaned `running` attempt rows stay `running` and harmless: no engine query reads an attempt whose job is not running under it.

## Not part of this rollback

`atlas_jobs.worker_id` and `atlas_jobs.heartbeat_at` stay in the table. Nothing reads them but the previous release; a later cleanup drops them once production has run this release.
