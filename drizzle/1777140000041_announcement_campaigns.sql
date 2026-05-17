CREATE TABLE `announcement_campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`status` text NOT NULL DEFAULT 'draft',
	`identity_key` text NOT NULL,
	`name` text NOT NULL,
	`campaign_version` text NOT NULL,
	`revision` integer NOT NULL,
	`release_version` text,
	`audience` text NOT NULL DEFAULT 'all',
	`created_by_user_id` text,
	`published_by_user_id` text,
	`published_snapshot_id` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	`published_at` integer,
	`archived_at` integer,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_campaigns_identity_key_unique` ON `announcement_campaigns` (`identity_key`);
--> statement-breakpoint
CREATE INDEX `announcement_campaigns_type_status_idx` ON `announcement_campaigns` (`type`,`status`,`published_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_campaigns_version_revision_unique_idx` ON `announcement_campaigns` (`type`,`campaign_version`,`revision`);
--> statement-breakpoint
CREATE INDEX `announcement_campaigns_status_updated_idx` ON `announcement_campaigns` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE `announcement_campaign_slides` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`layout_type` text NOT NULL,
	`semantic_role` text NOT NULL DEFAULT 'feature',
	`sort_order` integer NOT NULL,
	`title_en` text NOT NULL DEFAULT '',
	`title_hu` text NOT NULL DEFAULT '',
	`body_en` text NOT NULL DEFAULT '',
	`body_hu` text NOT NULL DEFAULT '',
	`action_label_en` text,
	`action_label_hu` text,
	`alt_text_en` text NOT NULL DEFAULT '',
	`alt_text_hu` text NOT NULL DEFAULT '',
	`desktop_crop_asset_id` text,
	`mobile_crop_asset_id` text,
	`action_destination` text,
	`setup_controls_json` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`campaign_id`) REFERENCES `announcement_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`desktop_crop_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`mobile_crop_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_slides_campaign_order_idx` ON `announcement_campaign_slides` (`campaign_id`,`sort_order`);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_campaign_slides_campaign_order_unique_idx` ON `announcement_campaign_slides` (`campaign_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `announcement_campaign_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`identity_key` text NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`campaign_version` text NOT NULL,
	`revision` integer NOT NULL,
	`release_version` text,
	`audience` text NOT NULL DEFAULT 'all',
	`published_by_user_id` text,
	`published_at` integer NOT NULL DEFAULT (unixepoch()),
	`archived_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `announcement_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`published_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_campaign_snapshots_identity_key_unique` ON `announcement_campaign_snapshots` (`identity_key`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_snapshots_campaign_idx` ON `announcement_campaign_snapshots` (`campaign_id`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_snapshots_type_published_idx` ON `announcement_campaign_snapshots` (`type`,`published_at`);
--> statement-breakpoint
CREATE TABLE `announcement_campaign_snapshot_slides` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`draft_slide_id` text,
	`layout_type` text NOT NULL,
	`semantic_role` text NOT NULL DEFAULT 'feature',
	`sort_order` integer NOT NULL,
	`title_en` text NOT NULL,
	`title_hu` text NOT NULL,
	`body_en` text NOT NULL,
	`body_hu` text NOT NULL,
	`action_label_en` text,
	`action_label_hu` text,
	`alt_text_en` text NOT NULL,
	`alt_text_hu` text NOT NULL,
	`desktop_crop_asset_id` text NOT NULL,
	`mobile_crop_asset_id` text NOT NULL,
	`action_destination` text,
	`setup_controls_json` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`snapshot_id`) REFERENCES `announcement_campaign_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `announcement_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`desktop_crop_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`mobile_crop_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_snapshot_slides_order_idx` ON `announcement_campaign_snapshot_slides` (`snapshot_id`,`sort_order`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_snapshot_slides_campaign_idx` ON `announcement_campaign_snapshot_slides` (`campaign_id`,`sort_order`);
--> statement-breakpoint
CREATE TABLE `announcement_campaign_user_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`completed_at` integer,
	`dismissed_at` integer,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `announcement_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `announcement_campaign_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `announcement_campaign_user_states_user_snapshot_unique_idx` ON `announcement_campaign_user_states` (`user_id`,`snapshot_id`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_user_states_user_campaign_idx` ON `announcement_campaign_user_states` (`user_id`,`campaign_id`);
--> statement-breakpoint
CREATE TABLE `announcement_campaign_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`campaign_id` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`event_type` text NOT NULL,
	`slide_id` text,
	`metadata_json` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`campaign_id`) REFERENCES `announcement_campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`snapshot_id`) REFERENCES `announcement_campaign_snapshots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`slide_id`) REFERENCES `announcement_campaign_snapshot_slides`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_events_campaign_event_idx` ON `announcement_campaign_events` (`campaign_id`,`event_type`,`created_at`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_events_user_campaign_event_idx` ON `announcement_campaign_events` (`user_id`,`campaign_id`,`event_type`);
--> statement-breakpoint
CREATE INDEX `announcement_campaign_events_slide_idx` ON `announcement_campaign_events` (`slide_id`);
