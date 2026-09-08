ALTER TABLE `routing_regions` ADD `gtfs_url` text;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `gtfs_size_bytes` integer;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `gtfs_downloaded_at` integer;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `transit_status` text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `timezone` text;--> statement-breakpoint
CREATE INDEX `routing_regions_transit_status_idx` ON `routing_regions` (`transit_status`);
