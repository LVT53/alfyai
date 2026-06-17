CREATE TABLE `memory_reset_generations` (
	`user_id` text PRIMARY KEY NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`advanced_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
