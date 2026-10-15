# Rolling back slice S4 (file production on the job engine)

Migration `1777140000116_file_production_jobs_on_engine`. It is expand-only: six new columns on `file_production_jobs` (`attempt_count`, `run_after`, `priority`, `checkpoint_json`, `retry_state_json`, `started_at`) and one index rebuilt under its old name (`file_production_jobs_live_claim_idx`, `(status, created_at)` before, `(status, priority, created_at)` now, both partial over the live statuses). Nothing was dropped or renamed, and `file_production_job_attempts` was not touched: it already had every column the engine reads. The engine's `phase` is this table's `stage` column under its old SQL name, so the previous release's `stage` writes land in the column the engine reads.

**There is no data rollback.** Roll the code back and leave the migration in place. The previous release names only the columns it knew, and every new column is nullable or has a default (`src/lib/server/db/file-production-jobs-engine-migration.test.ts` replays the old ledger's statements against the migrated table: its insert, its claim, its heartbeat, its completion, its Retry and its Cancel). The foreign keys still cascade: a job takes its attempts and its file links with it.

**There is no step to run either.** Both columns the previous release's recovery reads, `file_production_job_attempts.worker_id` and `heartbeat_at`, are written by the engine in the same form (`file-production:<host>:<pid>:<boot-nonce>` and the time of the last beat), so a row the engine left running is found by the old boot exactly as one the old worker left (next section).

## What the previous release does with the rows the engine left

| Row the engine left | The previous release |
|---|---|
| `queued` (new, or put back by Retry or Regenerate) | Claims it as it claims any queued row: the oldest by `created_at`, one at a time. `run_after` and `priority` are ignored; the engine never sets either for this kind. |
| `succeeded`, `failed`, `cancelled` | Reads them unchanged: `status`, `stage`, `error_code`, `error_message`, `retryable`, `dismissed`, the file links, and a succeeded job's warnings through `current_attempt_id` (the engine keeps that column pointing at the latest attempt after a job settles; the previous release read it the same way). |
| `running`, owned by the engine | Reclaims it at its boot (next section). |
| a cancelled job's attempt (`error_code = 'cancelled'`) | Ignores the code; it reads the attempt's status. |
| a `failed` job with `error_code = 'worker_heartbeat_timeout'` or `'worker_state_lost'` | The same two codes the previous release wrote itself; the card has its lines for both. |

The engine's handler turns an error nobody mapped into `worker_heartbeat_timeout` ("File production worker stopped before finishing.") and logs the real one, so no new error code reaches a card the previous release would show as raw text.

## Why a job the engine left running is not stranded

The previous release's boot runs two sweeps, and either finds the row:

1. The dead-worker reclaim: a running attempt whose worker id names this host, a process that no longer exists, and not this process. The engine's process is gone after the restart that rolled the code back, so its attempt is reclaimed at once: the job becomes `failed`, retryable, `worker_heartbeat_timeout`, "File production stopped when the server restarted." (the words the engine itself uses for the same case).
2. The stale sweep: a running attempt whose `heartbeat_at` is older than the stale window (two minutes by default), at boot and `staleAttemptMs` later, and on every idle tick while a row is running. The engine beats on a timer of its own, so a row it was running carries a recent beat and waits out the window; a row from another host does the same.

The card goes to `failed` with the Retry button, as it does after any restart of the previous release; Retry runs the job again from the start under the previous release's own claim. Check afterwards with `SELECT status, count(*) FROM file_production_jobs GROUP BY status;` (no `running` row that is not being worked on, and, since the old claim refuses to start while any row is `running`, no `queued` row that waits behind one).

## Rolling forward again

The first engine boot takes back whatever the previous release left `running` and does not own: a worker id of a process that is gone is reclaimed at once, a row with no live attempt is taken back as state-lost (retryable, `worker_state_lost`), and an attempt of another host waits for the stale window. Attempt numbers are one more than the highest in `file_production_job_attempts`, never less than `attempt_count`, so the attempts the previous release opened never collide with the engine's. `attempt_count` itself may lag (the previous release does not write it); nothing reads it but the engine's numbering, which takes the higher of the two.

## Not part of this rollback

Nothing is left to clean up for this kind. `file_production_job_attempts.mode`, `renderer` and `runtime` stay as they were (nullable, written by nothing today).
