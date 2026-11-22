CREATE TABLE IF NOT EXISTS `image_search_displays` (
	`message_id` text NOT NULL REFERENCES `messages`(`id`) ON DELETE CASCADE,
	`image_key` text NOT NULL,
	`month` text NOT NULL,
	`outcome` text,
	PRIMARY KEY (`message_id`, `image_key`)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `image_search_displays_month_idx` ON `image_search_displays` (`month`);
