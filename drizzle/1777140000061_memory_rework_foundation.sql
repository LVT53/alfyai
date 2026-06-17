CREATE TABLE `memory_projection_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`last_refreshed_at` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_projection_state_user_generation_scope_idx` ON `memory_projection_state` (`user_id`,`reset_generation`,`scope_type`,`scope_id`);
--> statement-breakpoint
CREATE INDEX `memory_projection_state_user_updated_idx` ON `memory_projection_state` (`user_id`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `memory_profile_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`projection_state_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`item_key` text NOT NULL,
	`category` text NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`statement` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`expires_at` integer,
	`deleted_at` integer,
	`suppressed_at` integer,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`projection_state_id`) REFERENCES `memory_projection_state`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_profile_items_user_generation_status_idx` ON `memory_profile_items` (`user_id`,`reset_generation`,`status`,`updated_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_profile_items_user_generation_item_key_idx` ON `memory_profile_items` (`user_id`,`reset_generation`,`item_key`);
--> statement-breakpoint
CREATE INDEX `memory_profile_items_user_category_idx` ON `memory_profile_items` (`user_id`,`category`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `memory_profile_item_provenance` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`label` text NOT NULL,
	`summary` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `memory_profile_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_profile_item_provenance_item_created_idx` ON `memory_profile_item_provenance` (`item_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `memory_profile_item_provenance_user_generation_idx` ON `memory_profile_item_provenance` (`user_id`,`reset_generation`);
--> statement-breakpoint
CREATE TABLE `memory_review_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`subject_key` text NOT NULL,
	`subject_label` text NOT NULL,
	`question` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`affected_item_ids_json` text DEFAULT '[]' NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_review_items_open_subject_idx` ON `memory_review_items` (`user_id`,`reset_generation`,`subject_key`) WHERE `status` = 'open';
--> statement-breakpoint
CREATE INDEX `memory_review_items_user_status_idx` ON `memory_review_items` (`user_id`,`reset_generation`,`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `memory_review_resolutions` (
	`id` text PRIMARY KEY NOT NULL,
	`review_item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`resolution_type` text NOT NULL,
	`edited_statement` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`review_item_id`) REFERENCES `memory_review_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_review_resolutions_review_idx` ON `memory_review_resolutions` (`review_item_id`);
--> statement-breakpoint
CREATE INDEX `memory_review_resolutions_user_generation_idx` ON `memory_review_resolutions` (`user_id`,`reset_generation`);
--> statement-breakpoint
CREATE TABLE `memory_dirty_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`scope_type` text DEFAULT 'global' NOT NULL,
	`scope_id` text DEFAULT '' NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`reason_metadata_json` text DEFAULT '{}' NOT NULL,
	`first_marked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_marked_at` integer DEFAULT (unixepoch()) NOT NULL,
	`claimed_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_dirty_ledger_pending_unique_idx` ON `memory_dirty_ledger` (`user_id`,`reset_generation`,`scope_type`,`scope_id`,`reason`) WHERE `status` = 'pending';
--> statement-breakpoint
CREATE INDEX `memory_dirty_ledger_user_status_idx` ON `memory_dirty_ledger` (`user_id`,`reset_generation`,`status`,`last_marked_at`);
--> statement-breakpoint
CREATE TABLE `memory_rework_telemetry` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reset_generation` integer DEFAULT 0 NOT NULL,
	`event_family` text NOT NULL,
	`event_name` text NOT NULL,
	`category` text,
	`reason` text,
	`status` text,
	`count` integer,
	`duration_ms` integer,
	`subject_id` text,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_rework_telemetry_user_family_created_idx` ON `memory_rework_telemetry` (`user_id`,`event_family`,`created_at`);
