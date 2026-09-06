CREATE TABLE `activity_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`message_id` text,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'done' NOT NULL,
	`duration_ms` integer,
	`model_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `activity_events_user_created_idx` ON `activity_events` (`user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `activity_events_kind_name_created_idx` ON `activity_events` (`kind`,`name`,`created_at`);
