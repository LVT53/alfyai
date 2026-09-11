CREATE TABLE `home_suggestion_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`candidate_key` text NOT NULL,
	`event` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `home_suggestion_events_user_key_idx` ON `home_suggestion_events` (`user_id`,`candidate_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `home_suggestion_events_expires_idx` ON `home_suggestion_events` (`expires_at`);--> statement-breakpoint
CREATE INDEX `usage_events_user_created_idx` ON `usage_events` (`user_id`,`created_at`);
