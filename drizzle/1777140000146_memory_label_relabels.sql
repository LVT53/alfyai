CREATE TABLE IF NOT EXISTS `memory_label_relabels` (
	`bank_id` text NOT NULL REFERENCES `memory_banks`(`id`) ON DELETE CASCADE,
	`native_fact_id` text NOT NULL,
	`previous_kind` text,
	`previous_subject` text,
	`previous_origin` text NOT NULL,
	`kind` text,
	`subject` text,
	`changed` integer NOT NULL,
	`relabelled_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY (`bank_id`, `native_fact_id`)
);
