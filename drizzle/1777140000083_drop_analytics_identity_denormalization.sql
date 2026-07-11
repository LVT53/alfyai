PRAGMA foreign_keys=OFF;
--> statement-breakpoint
-- Drop the denormalized identity columns (user_email, user_name) from the two
-- analytics rollups. Identity is now resolved from `users` at read time, so
-- these rollups are anonymous-by-construction (strengthens ADR-0029) and an
-- erased user can never be reidentified from a frozen email/name snapshot.
-- SQLite table rebuild: create the table WITHOUT the two columns, preserving
-- every other column (names + types + defaults), copy all rows, swap, and
-- recreate the indexes. Neither table has foreign keys, and nothing references
-- them by FK, so the rebuild is self-contained.

-- 1. usage_events
CREATE TABLE `__new_usage_events` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`conversation_title` text,
	`message_id` text NOT NULL,
	`model_id` text NOT NULL,
	`model_display_name` text,
	`provider_id` text,
	`provider_display_name` text,
	`provider_base_url` text,
	`provider_model_name` text,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`cached_input_tokens` integer DEFAULT 0 NOT NULL,
	`cache_hit_tokens` integer DEFAULT 0 NOT NULL,
	`cache_miss_tokens` integer DEFAULT 0 NOT NULL,
	`completion_tokens` integer DEFAULT 0 NOT NULL,
	`reasoning_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`usage_source` text DEFAULT 'estimated' NOT NULL,
	`generation_time_ms` integer,
	`billing_month` text NOT NULL,
	`cost_usd_micros` integer DEFAULT 0 NOT NULL,
	`price_rule_id` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_usage_events` (`id`, `user_id`, `conversation_id`, `conversation_title`, `message_id`, `model_id`, `model_display_name`, `provider_id`, `provider_display_name`, `provider_base_url`, `provider_model_name`, `prompt_tokens`, `cached_input_tokens`, `cache_hit_tokens`, `cache_miss_tokens`, `completion_tokens`, `reasoning_tokens`, `total_tokens`, `usage_source`, `generation_time_ms`, `billing_month`, `cost_usd_micros`, `price_rule_id`, `created_at`)
SELECT `id`, `user_id`, `conversation_id`, `conversation_title`, `message_id`, `model_id`, `model_display_name`, `provider_id`, `provider_display_name`, `provider_base_url`, `provider_model_name`, `prompt_tokens`, `cached_input_tokens`, `cache_hit_tokens`, `cache_miss_tokens`, `completion_tokens`, `reasoning_tokens`, `total_tokens`, `usage_source`, `generation_time_ms`, `billing_month`, `cost_usd_micros`, `price_rule_id`, `created_at` FROM `usage_events`;
--> statement-breakpoint
DROP TABLE `usage_events`;
--> statement-breakpoint
ALTER TABLE `__new_usage_events` RENAME TO `usage_events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_events_message_unique_idx` ON `usage_events` (`message_id`);
--> statement-breakpoint
CREATE INDEX `usage_events_user_month_idx` ON `usage_events` (`user_id`,`billing_month`);
--> statement-breakpoint
CREATE INDEX `usage_events_model_month_idx` ON `usage_events` (`model_id`,`billing_month`);
--> statement-breakpoint
-- 2. analytics_conversations
CREATE TABLE `__new_analytics_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`source` text DEFAULT 'live' NOT NULL,
	`billing_month` text NOT NULL,
	`conversation_created_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_analytics_conversations` (`id`, `conversation_id`, `user_id`, `title`, `source`, `billing_month`, `conversation_created_at`, `created_at`)
SELECT `id`, `conversation_id`, `user_id`, `title`, `source`, `billing_month`, `conversation_created_at`, `created_at` FROM `analytics_conversations`;
--> statement-breakpoint
DROP TABLE `analytics_conversations`;
--> statement-breakpoint
ALTER TABLE `__new_analytics_conversations` RENAME TO `analytics_conversations`;
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_conversations_conversation_unique_idx` ON `analytics_conversations` (`conversation_id`);
--> statement-breakpoint
CREATE INDEX `analytics_conversations_user_month_idx` ON `analytics_conversations` (`user_id`,`billing_month`);
--> statement-breakpoint
PRAGMA foreign_keys=ON;
