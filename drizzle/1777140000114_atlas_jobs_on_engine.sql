-- Atlas research jobs move onto the job engine (docs/plans/jobs-merge, slice S2).
-- EXPAND-ONLY, because `db:prepare` runs while the previous release keeps serving
-- and claiming for up to two minutes: nothing is dropped or renamed, every new
-- column on `atlas_jobs` is nullable or has a default, and the old release's
-- statements (which name only the columns it knew) keep working on the table.
--
-- `atlas_job_attempts`: one row per claim, the fencing token the engine checks on
-- every write a run makes. Atlas had no attempts before; its job-level `worker_id`
-- and `heartbeat_at` stay where they are, no longer written by the engine's
-- lifecycle (the kind clears them on every transition so a previous-release
-- process can never write through its old fence) and removed in a later cleanup.
CREATE TABLE `atlas_job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text,
	`worker_id` text,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`diagnostics_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `atlas_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atlas_job_attempts_job_number_unique_idx` ON `atlas_job_attempts` (`job_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `atlas_job_attempts_job_idx` ON `atlas_job_attempts` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `atlas_job_attempts_worker_idx` ON `atlas_job_attempts` (`worker_id`,`status`,`heartbeat_at`);
--> statement-breakpoint
-- The engine's lifecycle columns that Atlas did not have. A row that is `running`
-- at the cutover has no attempt (`current_attempt_id` NULL); the engine takes it
-- back at its first boot (state-lost) and requeues it, as the old boot recovery did.
ALTER TABLE `atlas_jobs` ADD `current_attempt_id` text;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `attempt_count` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `run_after` integer;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `priority` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `phase` text;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `checkpoint_json` text;
--> statement-breakpoint
ALTER TABLE `atlas_jobs` ADD `retry_state_json` text;
--> statement-breakpoint
-- The index the claim and the idle tick read. Two `=` terms joined by `or`, not
-- an `in (...)` list, so SQLite can see the index's own terms in the query's.
CREATE INDEX `atlas_jobs_live_claim_idx` ON `atlas_jobs` (`status`,`priority`,`created_at`) WHERE "atlas_jobs"."status" = 'queued' or "atlas_jobs"."status" = 'running';
