-- Picture files (docs/plans/image-generation, part 2: Alfy makes and changes
-- pictures).
--
-- One row per PNG Alfy keeps for a chat: the picture a change started from
-- (`input`), a render's result (`take`), or a copy the person drew on
-- (`marked`). The bytes live on disk under data/image-files/<conversation_id>/
-- (`storage_path` is relative to the working directory); the row says whose
-- they are and what they are.
--
-- `created_at` is unix seconds, like every table. The rows leave with their
-- chat and with their person (both cascade); `artifact_id` clears when the
-- Image item is deleted, and the files on disk are removed by the app.
CREATE TABLE `image_files` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`artifact_id` text,
	`role` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`has_alpha` integer DEFAULT 0 NOT NULL,
	`size_bytes` integer NOT NULL,
	`storage_path` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `image_files_conversation_created_idx` ON `image_files` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `image_files_artifact_idx` ON `image_files` (`artifact_id`);
--> statement-breakpoint
CREATE INDEX `image_files_user_idx` ON `image_files` (`user_id`);
