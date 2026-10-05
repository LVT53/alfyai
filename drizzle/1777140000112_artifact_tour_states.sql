-- Slice 6 (first-open tours): one row per (user, kind, content) once a
-- kind's tour is completed or dismissed. No `conversation_id` and no
-- `artifact_id` on purpose: the row records that a KIND of thing was
-- explained, never where, so it can never become a trace of a chat
-- (decisions.md ruling 33). An incognito chat shows no tour at all, so no
-- row is ever written from one. `content_key` sits inside the unique index
-- so publishing a new campaign snapshot re-shows the tour once (a new key)
-- while an ordinary reopen does not.
CREATE TABLE `artifact_tour_states` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`artifact_type` text NOT NULL,
	`content_key` text NOT NULL,
	`status` text NOT NULL,
	`slide_count` integer NOT NULL,
	`last_slide` integer DEFAULT 0 NOT NULL,
	`completed_at` integer,
	`dismissed_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifact_tour_states_user_type_content_unique_idx` ON `artifact_tour_states` (`user_id`,`artifact_type`,`content_key`);
--> statement-breakpoint
CREATE INDEX `artifact_tour_states_user_type_idx` ON `artifact_tour_states` (`user_id`,`artifact_type`);
