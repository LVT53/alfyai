-- Content-free audit only; never durable model continuations.
CREATE TABLE `normal_chat_turns` (
 `segment_id` text PRIMARY KEY NOT NULL,
 `turn_id` text NOT NULL,
 `conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
 `owner_id` text NOT NULL,
 `message_id` text,
 `phase` text,
 `closing_attempted` integer DEFAULT 0 NOT NULL,
 `outcome` text,
 `stop_cause` text,
 `working_stop_cause` text,
 `recovery_count` integer DEFAULT 0 NOT NULL,
 `attempt_ids_json` text,
 `accounting_status` text DEFAULT 'pending' NOT NULL,
 `created_at` integer DEFAULT (unixepoch()) NOT NULL,
 `settled_at` integer
);
--> statement-breakpoint
CREATE INDEX `normal_chat_turns_scope_idx` ON `normal_chat_turns` (`conversation_id`, `turn_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `normal_chat_turns_message_idx` ON `normal_chat_turns` (`message_id`);
--> statement-breakpoint
CREATE TABLE `normal_chat_attempts` (
 `attempt_id` text PRIMARY KEY NOT NULL,
 `segment_id` text NOT NULL REFERENCES `normal_chat_turns`(`segment_id`) ON DELETE CASCADE,
 `phase` text NOT NULL,
 `provider_id` text,
 `model_id` text NOT NULL,
 `provider_model_name` text NOT NULL,
 `safe_stop_cause` text,
 `outcome` text,
 `input_tokens` integer,
 `output_tokens` integer,
 `total_tokens` integer,
 `cached_input_tokens` integer,
 `cache_hit_tokens` integer,
 `cache_miss_tokens` integer,
 `reasoning_tokens` integer,
 `usage_final` integer DEFAULT 0 NOT NULL,
 `cost_usd_micros` integer,
 `price_rule_id` text,
 `generation_time_ms` integer,
 `started_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `normal_chat_attempts_segment_idx` ON `normal_chat_attempts` (`segment_id`);
