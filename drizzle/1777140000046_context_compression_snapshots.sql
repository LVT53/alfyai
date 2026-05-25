CREATE TABLE `context_compression_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`trigger` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`model_id` text NOT NULL,
	`source_start_message_id` text NOT NULL,
	`source_end_message_id` text NOT NULL,
	`source_start_message_sequence` integer NOT NULL,
	`source_end_message_sequence` integer NOT NULL,
	`snapshot_json` text DEFAULT '{}' NOT NULL,
	`source_coverage_json` text DEFAULT '{}' NOT NULL,
	`source_refs_json` text DEFAULT '[]' NOT NULL,
	`estimated_tokens` integer DEFAULT 0 NOT NULL,
	`source_token_estimate` integer DEFAULT 0 NOT NULL,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_start_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_end_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `context_compression_snapshots_conversation_created_idx` ON `context_compression_snapshots` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `context_compression_snapshots_conversation_status_idx` ON `context_compression_snapshots` (`conversation_id`,`status`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `context_compression_snapshots_conversation_source_end_idx` ON `context_compression_snapshots` (`conversation_id`,`source_end_message_sequence`);
--> statement-breakpoint
CREATE INDEX `context_compression_snapshots_user_conversation_idx` ON `context_compression_snapshots` (`user_id`,`conversation_id`);
