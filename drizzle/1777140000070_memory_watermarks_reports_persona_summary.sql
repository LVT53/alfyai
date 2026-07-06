CREATE TABLE `conversation_memory_watermarks` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`last_judged_sequence` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `memory_consolidation_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`summary_text` text NOT NULL,
	`actions_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_consolidation_reports_user_created_idx` ON `memory_consolidation_reports` (`user_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `memory_projection_state` ADD `persona_summary_text` text;
--> statement-breakpoint
ALTER TABLE `memory_projection_state` ADD `persona_summary_links_json` text DEFAULT '[]' NOT NULL;
--> statement-breakpoint
ALTER TABLE `memory_projection_state` ADD `persona_summary_updated_at` integer;
