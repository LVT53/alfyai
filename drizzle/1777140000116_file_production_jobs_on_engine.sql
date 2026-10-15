-- File-production jobs move onto the job engine (docs/plans/jobs-merge, slice S4).
-- EXPAND-ONLY, because `db:prepare` runs while the previous release keeps serving
-- and claiming for up to two minutes: nothing is dropped or renamed, every new
-- column on `file_production_jobs` is nullable or has a default, and the old
-- release's statements (which name only the columns it knew) keep working on the
-- table. `file_production_job_attempts` already carries every column the engine
-- reads (it is where the engine's shape came from), so it is not touched; the
-- engine's `phase` is this table's `stage`, under its old SQL name.
--
-- The previous release's rollback is plain code: it ignores the columns below.
-- See `docs/plans/jobs-merge/rollback-file-production.md`.

-- Attempts so far. The engine numbers the next attempt one past the HIGHEST number
-- the attempts table holds and never less than this count, so a count the old
-- release never kept (it did not have the column) cannot collide with the unique
-- (job, number) index; the backfill below just gives the card a true count.
ALTER TABLE `file_production_jobs` ADD `attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Not claimable before this. File production never backs off (ADR-0005: a failed
-- job waits for the person's Retry), so the engine leaves it NULL.
ALTER TABLE `file_production_jobs` ADD `run_after` integer;
--> statement-breakpoint
-- Lower runs sooner. Every file-production job is 0.
ALTER TABLE `file_production_jobs` ADD `priority` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Resumable state and the retry policy's memory. File production uses neither;
-- the engine's shape has them.
ALTER TABLE `file_production_jobs` ADD `checkpoint_json` text;
--> statement-breakpoint
ALTER TABLE `file_production_jobs` ADD `retry_state_json` text;
--> statement-breakpoint
-- The first claim.
ALTER TABLE `file_production_jobs` ADD `started_at` integer;
--> statement-breakpoint
-- The backfill touches the new columns only. `attempt_count` is the highest attempt
-- number the job has; `started_at` is its first attempt's start. A job that never
-- ran keeps 0 and NULL.
UPDATE `file_production_jobs` SET `attempt_count` = coalesce((SELECT max(`attempt_number`) FROM `file_production_job_attempts` WHERE `file_production_job_attempts`.`job_id` = `file_production_jobs`.`id`), 0);
--> statement-breakpoint
UPDATE `file_production_jobs` SET `started_at` = (SELECT `started_at` FROM `file_production_job_attempts` WHERE `file_production_job_attempts`.`job_id` = `file_production_jobs`.`id` ORDER BY `attempt_number` ASC LIMIT 1);
--> statement-breakpoint
-- The index the claim and the idle tick read, widened from (status, created_at) to
-- the engine's (status, priority, created_at) under the same name. Two `=` terms
-- joined by `or`, not an `in (...)` list, so SQLite can see the index's own terms
-- in the query's. The previous release's queries filter on `status` and order by
-- `created_at`; they still read this index for the filter. `IF EXISTS`, because a
-- database whose index was dropped by hand must not stop the deploy here.
DROP INDEX IF EXISTS `file_production_jobs_live_claim_idx`;
--> statement-breakpoint
CREATE INDEX `file_production_jobs_live_claim_idx` ON `file_production_jobs` (`status`,`priority`,`created_at`) WHERE "file_production_jobs"."status" = 'queued' or "file_production_jobs"."status" = 'running';
