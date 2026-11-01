-- Takes on the job engine (docs/plans/image-generation, part 2).
--
-- `image_cards` is one ask for pictures in one turn; `image_jobs` is one take
-- of a card, a job of the "image" kind on the job engine (the lifecycle columns
-- are the engine's, see services/jobs/columns.ts), with the kind's own columns
-- after them. `held_until` and `phase_at` are milliseconds; every other time
-- column is unix seconds, like every table. `cancel_interrupt` records which
-- kind of Stop was asked (1 = may interrupt our own running prompt, 0 = may
-- only delete a pending one). Expand-only: two new tables and their indexes.
CREATE TABLE `image_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`turn_id` text NOT NULL,
	`artifact_id` text,
	`title` text NOT NULL,
	`made_from` text NOT NULL,
	`source_count` integer DEFAULT 0 NOT NULL,
	`picked_take_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `image_cards_conversation_created_idx` ON `image_cards` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `image_jobs` (
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
	`card_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`tool_call_id` text,
	`origin` text NOT NULL,
	`retry_of` text,
	`request_json` text NOT NULL,
	`seed` integer NOT NULL,
	`held_until` integer,
	`hidden` integer DEFAULT 0 NOT NULL,
	`phase_at` integer,
	`queue_ahead` integer,
	`progress_percent` integer,
	`eta_seconds` integer,
	`result_file_id` text,
	`measures_json` text,
	`retried` integer DEFAULT 0 NOT NULL,
	`version_number` integer,
	`cancel_interrupt` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`card_id`) REFERENCES `image_cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`result_file_id`) REFERENCES `image_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `image_jobs_live_claim_idx` ON `image_jobs` (`status`,`priority`,`created_at`) WHERE "image_jobs"."status" = 'queued' or "image_jobs"."status" = 'running';
--> statement-breakpoint
CREATE INDEX `image_jobs_card_created_idx` ON `image_jobs` (`card_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE `image_job_attempts` (
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
	FOREIGN KEY (`job_id`) REFERENCES `image_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `image_job_attempts_job_number_unique_idx` ON `image_job_attempts` (`job_id`,`attempt_number`);
--> statement-breakpoint
CREATE INDEX `image_job_attempts_job_idx` ON `image_job_attempts` (`job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `image_job_attempts_worker_idx` ON `image_job_attempts` (`worker_id`,`status`,`heartbeat_at`);
