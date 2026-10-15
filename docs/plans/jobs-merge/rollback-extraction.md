# Rolling back slice S3 (document extraction on the job engine)

Migration `1777140000115_extraction_jobs_on_engine`. Unlike Atlas's and file production's, **this one is not undone by rolling the code back**: it rewrote data. The engine speaks five status words and the previous release's ledger spoke eight, and the previous release does not know the new ones. So rolling back is two steps, in this order: stop the new process, run [`rollback-extraction.sql`](rollback-extraction.sql), then start the previous release.

What the migration did, and what the SQL puts back:

| Migration | `rollback-extraction.sql` |
|---|---|
| `uploading`, `parsing`, `downloading`, `indexing` became `running`; the word moved to the new `phase` column | `running` becomes its `phase` again (`uploading` for a row with none) |
| `canceled` became `cancelled`, on jobs and on attempts | `cancelled` becomes `canceled` again, on both |
| the outage counter left `hints_json` (`$outage`) for `retry_state_json`; a `hints_json` left empty became `NULL` | `retry_state_json` goes back under `$outage` in the hints and is cleared |
| (the engine leaves `current_attempt_id` set on a settled job) | cleared on every job that is not in an active word, as the old ledger wrote it |

The two new columns (`phase`, `retry_state_json`) and the live index (`document_extraction_jobs_live_claim_idx`) stay: nothing in the previous release reads them, and every new column is nullable.

## When to run it

- A planned rollback of the release: after `systemctl stop`, before the previous release starts.
- **The deploy script rolled back by itself** (its health check failed and it flipped `current` back): the previous release is already serving. Stop its unit, run the SQL, start it again. The script cannot do this for you: the rollback logic belongs to the release being replaced, and that release cannot know a later one rewrote its words (design: "Migration and deploy"). Until the SQL has run, the previous release shows the new words to the person: a `cancelled` job reads as not yet finished and Retry refuses it, and a `running` job is not claimed or swept by the old stale sweep.

```sh
sqlite3 data/chat.db < docs/plans/jobs-merge/rollback-extraction.sql
```

It is one transaction (all of it applies or none of it), it is idempotent, and it only touches `document_extraction_jobs` and `document_extraction_job_attempts`. Check afterwards:

```sql
SELECT status, count(*) FROM document_extraction_jobs GROUP BY status;
SELECT status, count(*) FROM document_extraction_job_attempts GROUP BY status;
```

No job may be `running` or `cancelled`, and no attempt `cancelled`. Every other word is one the previous release reads. (`src/lib/server/db/extraction-jobs-engine-migration.test.ts` applies this file to a migrated database seeded in every old word and checks every column against the original.)

## What the previous release does with the rows the engine left

| Row the engine left | The previous release |
|---|---|
| `queued`, with `next_attempt_at` and the error kept | Claims it once the gate opens, as it always did. |
| An active word, with a `running` attempt of the new process's worker id | Its boot reclaims the attempt of a worker that no longer exists on this host and requeues it by its own retry policy, resuming the stored handle (`remote_handle_json`). |
| `succeeded`, `failed`, `canceled` | Reads them unchanged. |
| An attempt `cancelled` with the engine's error code `cancelled` | Ignored: the previous release reads the table's status, and the SQL restored that. The code string is historical. |

Two small differences from what the previous release itself would have left: a job the engine settled `failed` has no stored handle (the engine clears the checkpoint of a settled job; the previous release kept it when a stale reclaim ended the job), and a cancelled job's error is cleared (the previous release kept the last error on it).

## Rolling forward again

The new release's first start runs `normalizeExtractionLifecycleWords` (`src/lib/server/db/compat.ts`) before the engine starts. It re-applies the migration's rewrite, idempotently, so the old words the previous release wrote after the SQL ran become the engine's. The migration itself is recorded as applied and does not run again.

## Not part of this rollback

The shim and the two columns go in a later cleanup, once production has run this release.
