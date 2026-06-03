CREATE TABLE `provider_models` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`display_name` text NOT NULL,
	`max_model_context` integer,
	`compaction_ui_threshold` integer,
	`target_constructed_context` integer,
	`max_message_length` integer,
	`max_tokens` integer,
	`reasoning_effort` text,
	`thinking_type` text,
	`capabilities_json` text DEFAULT '{}' NOT NULL,
	`input_usd_micros_per_1m` integer DEFAULT 0 NOT NULL,
	`cached_input_usd_micros_per_1m` integer DEFAULT 0 NOT NULL,
	`cache_hit_usd_micros_per_1m` integer DEFAULT 0 NOT NULL,
	`cache_miss_usd_micros_per_1m` integer DEFAULT 0 NOT NULL,
	`output_usd_micros_per_1m` integer DEFAULT 0 NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_models_provider_id_name_unique` ON `provider_models` (`provider_id`,`name`);
