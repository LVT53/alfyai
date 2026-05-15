CREATE TABLE `conversation_forks` (
	`id` text PRIMARY KEY NOT NULL,
	`fork_conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`source_conversation_id` text,
	`source_conversation_id_snapshot` text NOT NULL,
	`source_assistant_message_id` text,
	`source_assistant_message_id_snapshot` text NOT NULL,
	`copied_fork_point_message_id` text NOT NULL,
	`source_title` text NOT NULL,
	`fork_sequence` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`fork_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`copied_fork_point_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_forks_fork_conversation_unique_idx` ON `conversation_forks` (`fork_conversation_id`);
--> statement-breakpoint
CREATE INDEX `conversation_forks_source_assistant_idx` ON `conversation_forks` (`source_assistant_message_id_snapshot`,`fork_sequence`);
--> statement-breakpoint
CREATE INDEX `conversation_forks_source_conversation_idx` ON `conversation_forks` (`source_conversation_id_snapshot`,`fork_sequence`);
--> statement-breakpoint
CREATE INDEX `conversation_forks_user_created_idx` ON `conversation_forks` (`user_id`,`created_at`);
