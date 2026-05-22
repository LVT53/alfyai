ALTER TABLE `conversations` ADD `sidebar_pinned` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `sidebar_sort_order` integer;
--> statement-breakpoint
CREATE INDEX `conversations_user_sidebar_idx` ON `conversations` (`user_id`,`sidebar_pinned`,`sidebar_sort_order`);
--> statement-breakpoint
ALTER TABLE `projects` ADD `sidebar_pinned` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX `projects_user_sidebar_idx` ON `projects` (`user_id`,`sidebar_pinned`,`sort_order`);
