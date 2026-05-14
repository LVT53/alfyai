CREATE TABLE `skill_note_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`action` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `skill_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_note_operations_session_turn_operation_idx`
	ON `skill_note_operations` (`session_id`, `assistant_message_id`, `operation_id`);
--> statement-breakpoint
CREATE INDEX `skill_note_operations_artifact_created_idx`
	ON `skill_note_operations` (`artifact_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `skill_note_checkpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`note_artifact_id` text NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`assistant_message_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`previous_body` text NOT NULL,
	`previous_metadata_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`note_artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `skill_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_note_checkpoints_note_created_idx`
	ON `skill_note_checkpoints` (`note_artifact_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `skill_note_checkpoints_session_created_idx`
	ON `skill_note_checkpoints` (`session_id`, `created_at`);
