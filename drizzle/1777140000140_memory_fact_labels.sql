CREATE TABLE IF NOT EXISTS `memory_fact_labels` (
	`bank_id` text NOT NULL REFERENCES `memory_banks`(`id`) ON DELETE CASCADE,
	`native_fact_id` text NOT NULL,
	`kind` text,
	`subject` text,
	`origin` text NOT NULL,
	`event_at` integer,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`bank_id`, `native_fact_id`)
);
