CREATE TABLE `user_skill_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`ownership` text DEFAULT 'user' NOT NULL,
	`display_name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`instructions` text NOT NULL,
	`activation_examples_json` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`duration_policy` text DEFAULT 'next_message' NOT NULL,
	`question_policy` text DEFAULT 'none' NOT NULL,
	`notes_policy` text DEFAULT 'none' NOT NULL,
	`source_scope` text DEFAULT 'current_conversation' NOT NULL,
	`creation_source` text DEFAULT 'user_created' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_skill_definitions_user_updated_idx` ON `user_skill_definitions` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `user_skill_definitions_user_name_idx` ON `user_skill_definitions` (`user_id`,`display_name`);
--> statement-breakpoint
CREATE INDEX `user_skill_definitions_user_enabled_idx` ON `user_skill_definitions` (`user_id`,`enabled`,`display_name`);
