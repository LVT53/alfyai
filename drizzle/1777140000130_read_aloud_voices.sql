-- Personal voices for read aloud (Plan 3): a built-in voice plus five knob values
-- and a name, private to the person who made it, and three account settings on
-- `users`: the voice each language reads with and the speed a reading starts at.
--
-- Expand-only: one new table and three new columns, so undoing it is a drop.
-- `language` is the base voice's language when the voice was saved, so a voice
-- whose base was taken out of the list still knows which picker it belongs to.
-- A choice is a built-in voice key or one of the person's voice ids; NULL means
-- the language's default. The knob values are slider values; a Zonos control is
-- made from them only when a reading or a preview is made.
CREATE TABLE `read_aloud_voices` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`base_voice` text NOT NULL,
	`language` text NOT NULL,
	`pace` real DEFAULT 0 NOT NULL,
	`pitch` real DEFAULT 0 NOT NULL,
	`depth` real DEFAULT 0 NOT NULL,
	`energy` real DEFAULT 0 NOT NULL,
	`projection` real DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `read_aloud_voices_user_created_idx` ON `read_aloud_voices` (`user_id`,`created_at`);
--> statement-breakpoint
ALTER TABLE `users` ADD `read_aloud_en_voice` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `read_aloud_hu_voice` text;
--> statement-breakpoint
ALTER TABLE `users` ADD `read_aloud_speed` real DEFAULT 1 NOT NULL;
