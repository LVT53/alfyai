CREATE TABLE `browser_push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_failure_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_push_subscriptions_endpoint_unique_idx` ON `browser_push_subscriptions` (`endpoint`);
--> statement-breakpoint
CREATE INDEX `browser_push_subscriptions_user_updated_idx` ON `browser_push_subscriptions` (`user_id`,`updated_at`);
