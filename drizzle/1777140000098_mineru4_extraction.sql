ALTER TABLE `artifact_chunks` ADD `page_start` integer;--> statement-breakpoint
ALTER TABLE `artifact_chunks` ADD `page_end` integer;--> statement-breakpoint
INSERT OR IGNORE INTO `admin_config` (`key`, `value`, `updated_at`, `updated_by`)
SELECT 'MINERU_JOB_TIMEOUT_MS', `value`, `updated_at`, `updated_by`
FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';--> statement-breakpoint
DELETE FROM `admin_config` WHERE `key` = 'MINERU_TIMEOUT_MS';
