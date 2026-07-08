CREATE TABLE `provider_model_price_windows` (
	`id` text PRIMARY KEY NOT NULL,
	`provider_model_id` text NOT NULL,
	`label` text NOT NULL,
	`days_of_week` text DEFAULT '0123456' NOT NULL,
	`start_minute` integer NOT NULL,
	`end_minute` integer NOT NULL,
	`input_usd_micros_per_1m` integer,
	`cached_input_usd_micros_per_1m` integer,
	`cache_hit_usd_micros_per_1m` integer,
	`cache_miss_usd_micros_per_1m` integer,
	`output_usd_micros_per_1m` integer,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`provider_model_id`) REFERENCES `provider_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `provider_model_price_windows_model_idx` ON `provider_model_price_windows` (`provider_model_id`);
