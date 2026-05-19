ALTER TABLE `messages` ADD COLUMN `message_sequence` integer;
--> statement-breakpoint
WITH ranked_messages AS (
	SELECT
		`rowid` AS `message_rowid`,
		ROW_NUMBER() OVER (
			PARTITION BY `conversation_id`
			ORDER BY `created_at` ASC, `rowid` ASC
		) AS `conversation_sequence`
	FROM `messages`
)
UPDATE `messages`
SET `message_sequence` = (
	SELECT `conversation_sequence`
	FROM ranked_messages
	WHERE ranked_messages.`message_rowid` = `messages`.`rowid`
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_conversation_sequence_unique_idx` ON `messages` (`conversation_id`,`message_sequence`) WHERE `message_sequence` IS NOT NULL;
--> statement-breakpoint
CREATE INDEX `messages_conversation_order_idx` ON `messages` (`conversation_id`,`message_sequence`,`created_at`);
