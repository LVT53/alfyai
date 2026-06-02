ALTER TABLE `messages` ADD COLUMN `import_source` text;
--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`total_conversations` integer DEFAULT 0 NOT NULL,
	`processed_conversations` integer DEFAULT 0 NOT NULL,
	`error_log` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_jobs_user_status_idx` ON `import_jobs` (`user_id`,`status`,`updated_at`);
