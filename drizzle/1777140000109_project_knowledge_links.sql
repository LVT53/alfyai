CREATE TABLE `project_knowledge_links` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`artifact_id`) REFERENCES `artifacts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `project_knowledge_links_project_artifact_unique` ON `project_knowledge_links` (`project_id`,`artifact_id`);
--> statement-breakpoint
CREATE INDEX `project_knowledge_links_user_project_idx` ON `project_knowledge_links` (`user_id`,`project_id`);
