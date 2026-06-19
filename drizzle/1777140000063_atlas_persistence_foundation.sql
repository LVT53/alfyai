CREATE TABLE `atlas_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`assistant_message_id` text,
	`action` text NOT NULL,
	`parent_atlas_job_id` text,
	`profile` text NOT NULL,
	`normalized_query_hash` text NOT NULL,
	`client_atlas_turn_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`progress_percent` integer DEFAULT 0 NOT NULL,
	`worker_id` text,
	`heartbeat_at` integer,
	`started_at` integer,
	`completed_at` integer,
	`cancel_requested_at` integer,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`local_source_count` integer DEFAULT 0 NOT NULL,
	`web_source_count` integer DEFAULT 0 NOT NULL,
	`accepted_source_count` integer DEFAULT 0 NOT NULL,
	`rejected_source_count` integer DEFAULT 0 NOT NULL,
	`file_production_job_id` text,
	`html_chat_generated_file_id` text,
	`pdf_chat_generated_file_id` text,
	`markdown_chat_generated_file_id` text,
	`error_code` text,
	`error_message` text,
	`error_retryable` integer DEFAULT false NOT NULL,
	`failure_metadata_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`parent_atlas_job_id`) REFERENCES `atlas_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`file_production_job_id`) REFERENCES `file_production_jobs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`html_chat_generated_file_id`) REFERENCES `chat_generated_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pdf_chat_generated_file_id`) REFERENCES `chat_generated_files`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`markdown_chat_generated_file_id`) REFERENCES `chat_generated_files`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atlas_jobs_idempotency_unique_idx` ON `atlas_jobs` (`idempotency_key`);
--> statement-breakpoint
CREATE INDEX `atlas_jobs_user_status_created_idx` ON `atlas_jobs` (`user_id`,`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `atlas_jobs_conversation_status_updated_idx` ON `atlas_jobs` (`conversation_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `atlas_jobs_parent_idx` ON `atlas_jobs` (`parent_atlas_job_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `atlas_jobs_assistant_message_idx` ON `atlas_jobs` (`assistant_message_id`);
--> statement-breakpoint
CREATE TABLE `atlas_round_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`round_number` integer NOT NULL,
	`checkpoint_version` integer DEFAULT 1 NOT NULL,
	`stage` text NOT NULL,
	`checkpoint_json` text DEFAULT '{}' NOT NULL,
	`curated_source_pool_json` text DEFAULT '[]' NOT NULL,
	`compressed_findings_json` text DEFAULT '{}' NOT NULL,
	`usage_json` text DEFAULT '{}' NOT NULL,
	`quality_diagnostics_json` text DEFAULT '{}' NOT NULL,
	`document_source_summary_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `atlas_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `atlas_round_checkpoints_job_round_unique_idx` ON `atlas_round_checkpoints` (`job_id`,`round_number`);
--> statement-breakpoint
CREATE INDEX `atlas_round_checkpoints_job_created_idx` ON `atlas_round_checkpoints` (`job_id`,`created_at`);
