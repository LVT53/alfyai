PRAGMA foreign_keys=OFF;
--> statement-breakpoint
-- 1. Rebuild `projects` WITHOUT canonical_memory_project_id (removes the column,
--    its unique index, and its FK to memory_projects). Preserve all other
--    columns, the projects_user_sidebar_idx index, and child FKs that reference
--    projects(id) (they resolve by table name across the rename).
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`sidebar_pinned` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_projects` (`id`, `user_id`, `name`, `color`, `sidebar_pinned`, `sort_order`, `created_at`, `updated_at`)
SELECT `id`, `user_id`, `name`, `color`, `sidebar_pinned`, `sort_order`, `created_at`, `updated_at` FROM `projects`;
--> statement-breakpoint
DROP TABLE `projects`;
--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;
--> statement-breakpoint
CREATE INDEX `projects_user_sidebar_idx` ON `projects` (`user_id`,`sidebar_pinned`,`sort_order`);
--> statement-breakpoint
-- 2. Drop the inferred substrate: child (memory_project_task_links) then parent
--    (memory_projects). Nothing is backfilled — every field was derived from
--    folders / conversations / task states / summaries / checkpoints.
DROP TABLE `memory_project_task_links`;
--> statement-breakpoint
DROP TABLE `memory_projects`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
