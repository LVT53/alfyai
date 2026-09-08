ALTER TABLE `routing_regions` ADD `extract_source` text;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `next_attempt_at` integer;--> statement-breakpoint
ALTER TABLE `routing_regions` ADD `resident` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `routing_regions_next_attempt_idx` ON `routing_regions` (`next_attempt_at`);
