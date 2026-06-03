CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`base_url` text NOT NULL,
	`api_key_encrypted` text NOT NULL,
	`api_key_iv` text NOT NULL,
	`icon_asset_id` text,
	`rate_limit_fallback_enabled` integer DEFAULT 0 NOT NULL,
	`rate_limit_fallback_base_url` text,
	`rate_limit_fallback_api_key_encrypted` text,
	`rate_limit_fallback_api_key_iv` text,
	`rate_limit_fallback_model_name` text,
	`rate_limit_fallback_timeout_ms` integer DEFAULT 10000 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`icon_asset_id`) REFERENCES `campaign_assets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `providers_name_unique` ON `providers` (`name`);
