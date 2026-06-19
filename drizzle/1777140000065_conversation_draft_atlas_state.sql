ALTER TABLE `conversation_drafts` ADD `atlas_mode` integer DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE `conversation_drafts` ADD `atlas_profile` text;
