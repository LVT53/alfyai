-- Image descriptions (docs/plans/image-generation, part 1: Alfy can see).
--
-- What a picture shows, in a few words, written once by the model that was
-- shown it, so a later turn carries the words instead of the pixels. One row
-- per artifact: uploads are deduplicated per person by hash, so the same photo
-- attached in a second chat is the same artifact and reuses the description.
-- The description is of the image alone, never of the chat it was attached
-- in, which is why the key is the artifact and nothing else.
--
-- It leaves with its picture (`artifact_id` cascades: both Clear Memory and
-- Clear Workspace hard-delete the artifact rows) and with its person.
CREATE TABLE `image_descriptions` (
	`artifact_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`description` text NOT NULL,
	`model_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `image_descriptions_user_idx` ON `image_descriptions` (`user_id`);
