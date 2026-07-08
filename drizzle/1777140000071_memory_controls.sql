ALTER TABLE `users` ADD `memory_enabled` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `conversations` ADD `memory_incognito` integer DEFAULT false NOT NULL;
