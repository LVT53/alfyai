CREATE TABLE `routing_regions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`pbf_url` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`managed` integer DEFAULT true NOT NULL,
	`base_url` text,
	`host_port` integer,
	`container_name` text,
	`pbf_size_bytes` integer,
	`geocoder_status` text DEFAULT 'none' NOT NULL,
	`error` text,
	`requested_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	`last_used_at` integer,
	`ready_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routing_regions_slug_unique` ON `routing_regions` (`slug`);
--> statement-breakpoint
CREATE INDEX `routing_regions_status_idx` ON `routing_regions` (`status`);
