-- The account epoch whose banks may hold facts from before bank config 2
-- (Memory part 3): such an account keeps today's Memory page until the label
-- migration verifies its labels and clears this. A new account, and a new
-- epoch after Clear Memory or erasure, starts on config 2 and is never marked.
ALTER TABLE `memory_accounts` ADD `labels_unverified_epoch` integer;
--> statement-breakpoint
UPDATE `memory_accounts` SET `labels_unverified_epoch` = `epoch`
WHERE EXISTS (
	SELECT 1 FROM `memory_banks`
	WHERE `memory_banks`.`user_id` = `memory_accounts`.`user_id`
		AND `memory_banks`.`epoch` = `memory_accounts`.`epoch`
);
