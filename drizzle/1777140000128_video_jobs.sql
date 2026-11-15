-- Video takes on the job engine (docs/plans/ltx-video, slice 4).
--
-- A video take is a job of the "video" kind: its own table and its own
-- attempts table, never a flag on `image_jobs`, because the kind has its own
-- engine, its own limits (one at a time: LTX and H3 cannot be resident
-- together) and its own deadline. The lifecycle columns are the engine's
-- (services/jobs/columns.ts), with the kind's own columns after them.
-- `phase_at` is milliseconds; every other time column is unix seconds.
-- `cancel_interrupt` records which kind of Stop was asked (1 = may interrupt
-- our own running prompt, 0 = may only delete a pending one). Expand-only:
-- two new tables and their indexes.
CREATE TABLE `video_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`run_after` integer,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`current_attempt_id` text,
	`retryable` integer DEFAULT false NOT NULL,
	`error_code` text,
	`error_message` text,
	`checkpoint_json` text,
	`retry_state_json` text,
	`cancel_requested_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`conversation_id` text NOT NULL,
	`artifact_id` text,
	`tool_call_id` text,
	`origin` text NOT NULL,
	`retry_of` text,
	`request_json` text NOT NULL,
	`seed` integer NOT NULL,
	`phase_at` integer,
	`queue_ahead` integer,
	`progress_percent` integer,
	`eta_seconds` integer,
	`result_file_id` text,
	`cancel_interrupt` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`result_file_id`) REFERENCES `image_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `video_jobs_live_claim_idx` ON `video_jobs` (`status`,`priority`,`created_at`) WHERE "video_jobs"."status" = 'queued' or "video_jobs"."status" = 'running';
--> statement-breakpoint
CREATE INDEX `video_jobs_conversation_created_idx` ON `video_jobs` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `video_job_attempts` (
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
	`retryable` integer DEFAULT false NOT NULL,
	`diagnostics_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `video_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_job_attempts_job_number_unique_idx` ON `video_job_attempts` (`job_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `video_job_attempts_job_idx` ON `video_job_attempts` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `video_job_attempts_worker_idx` ON `video_job_attempts` (`worker_id`,`status`,`heartbeat_at`);
