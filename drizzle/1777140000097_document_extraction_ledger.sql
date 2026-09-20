CREATE TABLE `document_extraction_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text,
	`source_artifact_id` text,
	`chat_generated_file_id` text,
	`normalized_artifact_id` text,
	`origin` text DEFAULT 'upload' NOT NULL,
	`intake_route` text NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`current_attempt_id` text,
	`remote_handle_json` text,
	`hints_json` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`error_code` text,
	`error_message` text,
	`next_attempt_at` integer,
	`cancel_requested_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`chat_generated_file_id`) REFERENCES `chat_generated_files`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`normalized_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_jobs_source_artifact_unique_idx` ON `document_extraction_jobs` (`source_artifact_id`) WHERE `source_artifact_id` IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_jobs_chat_file_unique_idx` ON `document_extraction_jobs` (`chat_generated_file_id`) WHERE `chat_generated_file_id` IS NOT NULL;--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_claim_idx` ON `document_extraction_jobs` (`status`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_user_status_idx` ON `document_extraction_jobs` (`user_id`,`status`);--> statement-breakpoint
CREATE INDEX `document_extraction_jobs_conversation_idx` ON `document_extraction_jobs` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `document_extraction_job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`phase` text,
	`extractor` text,
	`resumed` integer DEFAULT 0 NOT NULL,
	`remote_handle_json` text,
	`worker_id` text,
	`claimed_at` integer,
	`heartbeat_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`error_code` text,
	`error_message` text,
	`retryable` integer DEFAULT 0 NOT NULL,
	`text_length` integer,
	`page_count` integer,
	`diagnostics_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `document_extraction_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `document_extraction_job_attempts_job_number_unique_idx` ON `document_extraction_job_attempts` (`job_id`,`attempt_number`);--> statement-breakpoint
CREATE INDEX `document_extraction_job_attempts_job_idx` ON `document_extraction_job_attempts` (`job_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `document_extraction_job_attempts_worker_idx` ON `document_extraction_job_attempts` (`worker_id`,`status`,`heartbeat_at`);--> statement-breakpoint
CREATE INDEX `artifacts_user_name_idx` ON `artifacts` (`user_id`,`name`);
