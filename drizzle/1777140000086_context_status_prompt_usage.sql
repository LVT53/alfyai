PRAGMA foreign_keys=OFF;
--> statement-breakpoint
-- Context usage ring: report the real prompt size against the model's real
-- context window. Adds `prompt_tokens` (best-known prompt size for the last
-- completed turn) and `prompt_tokens_source` ('provider' when the provider
-- reported input tokens, 'estimated' otherwise) to conversation_context_status.
-- SQLite cannot change a column default in place, so the table is rebuilt to
-- also fix the stale `target_tokens` default (157286 = 0.6 x 262144) to match
-- DEFAULT_TARGET_CONSTRUCTED_CONTEXT_RATIO (0.9 x 262144 = 235929). Every
-- other column keeps its name, type and default; no index references the
-- table, and nothing references it by foreign key.
CREATE TABLE `__new_conversation_context_status` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`estimated_tokens` integer DEFAULT 0 NOT NULL,
	`prompt_tokens` integer DEFAULT 0 NOT NULL,
	`prompt_tokens_source` text DEFAULT 'estimated' NOT NULL,
	`max_context_tokens` integer DEFAULT 262144 NOT NULL,
	`threshold_tokens` integer DEFAULT 209715 NOT NULL,
	`target_tokens` integer DEFAULT 235929 NOT NULL,
	`compaction_applied` integer DEFAULT 0 NOT NULL,
	`compaction_mode` text DEFAULT 'none' NOT NULL,
	`routing_stage` text DEFAULT 'deterministic' NOT NULL,
	`routing_confidence` integer DEFAULT 0 NOT NULL,
	`verification_status` text DEFAULT 'skipped' NOT NULL,
	`layers_used_json` text,
	`working_set_count` integer DEFAULT 0 NOT NULL,
	`working_set_artifact_ids_json` text,
	`working_set_applied` integer DEFAULT 0 NOT NULL,
	`task_state_applied` integer DEFAULT 0 NOT NULL,
	`prompt_artifact_count` integer DEFAULT 0 NOT NULL,
	`recent_turn_count` integer DEFAULT 0 NOT NULL,
	`summary` text,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Existing rows only ever held the pre-request packet estimate, so seed
-- prompt_tokens from estimated_tokens as an 'estimated' value.
INSERT INTO `__new_conversation_context_status` (`conversation_id`, `user_id`, `estimated_tokens`, `prompt_tokens`, `prompt_tokens_source`, `max_context_tokens`, `threshold_tokens`, `target_tokens`, `compaction_applied`, `compaction_mode`, `routing_stage`, `routing_confidence`, `verification_status`, `layers_used_json`, `working_set_count`, `working_set_artifact_ids_json`, `working_set_applied`, `task_state_applied`, `prompt_artifact_count`, `recent_turn_count`, `summary`, `updated_at`)
SELECT `conversation_id`, `user_id`, `estimated_tokens`, `estimated_tokens`, 'estimated', `max_context_tokens`, `threshold_tokens`, `target_tokens`, `compaction_applied`, `compaction_mode`, `routing_stage`, `routing_confidence`, `verification_status`, `layers_used_json`, `working_set_count`, `working_set_artifact_ids_json`, `working_set_applied`, `task_state_applied`, `prompt_artifact_count`, `recent_turn_count`, `summary`, `updated_at` FROM `conversation_context_status`;
--> statement-breakpoint
DROP TABLE `conversation_context_status`;
--> statement-breakpoint
ALTER TABLE `__new_conversation_context_status` RENAME TO `conversation_context_status`;
--> statement-breakpoint
PRAGMA foreign_keys=ON;
