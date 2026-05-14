CREATE TABLE `skill_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`skill_ownership` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`pause_reason` text,
	`end_reason` text,
	`skill_display_name` text NOT NULL,
	`skill_description` text DEFAULT '' NOT NULL,
	`skill_instructions` text NOT NULL,
	`activation_examples_json` text DEFAULT '[]' NOT NULL,
	`duration_policy` text NOT NULL,
	`question_policy` text NOT NULL,
	`notes_policy` text NOT NULL,
	`source_scope` text NOT NULL,
	`skill_version` integer NOT NULL,
	`started_from` text NOT NULL,
	`started_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`paused_at` integer,
	`ended_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_sessions_user_conversation_updated_idx` ON `skill_sessions` (`user_id`,`conversation_id`,`updated_at`);
--> statement-breakpoint
CREATE INDEX `skill_sessions_conversation_status_idx` ON `skill_sessions` (`conversation_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_sessions_one_active_per_conversation_idx` ON `skill_sessions` (`conversation_id`) WHERE `status` = 'active';
--> statement-breakpoint
CREATE TABLE `skill_session_milestones` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`kind` text NOT NULL,
	`message_key` text NOT NULL,
	`message_params_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `skill_sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `skill_session_milestones_session_created_idx` ON `skill_session_milestones` (`session_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `skill_session_milestones_conversation_created_idx` ON `skill_session_milestones` (`conversation_id`,`created_at`);
