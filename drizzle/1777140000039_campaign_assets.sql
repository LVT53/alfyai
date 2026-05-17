CREATE TABLE `campaign_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`uploaded_by_user_id` text NOT NULL,
	`source_asset_id` text,
	`asset_kind` text NOT NULL,
	`variant` text,
	`status` text NOT NULL DEFAULT 'draft',
	`original_filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL DEFAULT 0,
	`storage_path` text NOT NULL,
	`width` integer,
	`height` integer,
	`crop_x` real,
	`crop_y` real,
	`crop_width` real,
	`crop_height` real,
	`zoom` real,
	`crop_metadata_json` text,
	`created_at` integer NOT NULL DEFAULT (unixepoch()),
	`updated_at` integer NOT NULL DEFAULT (unixepoch()),
	FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `campaign_assets_status_idx` ON `campaign_assets` (`status`,`created_at`);
--> statement-breakpoint
CREATE INDEX `campaign_assets_uploaded_by_idx` ON `campaign_assets` (`uploaded_by_user_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `campaign_assets_source_idx` ON `campaign_assets` (`source_asset_id`,`variant`);
