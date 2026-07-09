ALTER TABLE `connection_pending_writes` ADD `conversation_id` text REFERENCES `conversations`(`id`) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE `connection_pending_writes` ADD `assistant_message_id` text REFERENCES `messages`(`id`) ON DELETE set null;
--> statement-breakpoint
CREATE INDEX `connection_pending_writes_conversation_idx` ON `connection_pending_writes` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `connection_pending_writes_assistant_message_idx` ON `connection_pending_writes` (`assistant_message_id`,`created_at`);
