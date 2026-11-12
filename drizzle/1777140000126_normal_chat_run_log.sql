-- One anonymous, content-free record per Normal Chat model run, so that a model
-- failure is known whatever happens to the chat afterwards. No foreign keys and
-- no user, conversation or message id: the row survives the deletion of its
-- conversation, its message and its person, and it covers runs of incognito
-- chats (which have no ledger rows; their row has no segment id and no attempt
-- ids). `settled_at` stays NULL for a run that never reported an end.
CREATE TABLE `normal_chat_run_log` (
 `id` text PRIMARY KEY NOT NULL,
 `tracked` integer NOT NULL,
 `segment_id` text,
 `started_at` integer DEFAULT (unixepoch()) NOT NULL,
 `settled_at` integer,
 `outcome` text,
 `stop_cause` text,
 `working_stop_cause` text,
 `phase` text,
 `closing_attempted` integer DEFAULT 0 NOT NULL,
 `recovery_count` integer DEFAULT 0 NOT NULL,
 `saved` integer DEFAULT 0 NOT NULL,
 `first_byte_ms` integer,
 `first_thinking_ms` integer,
 `first_token_ms` integer,
 `generation_time_ms` integer,
 `attempts_json` text DEFAULT '[]' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `normal_chat_run_log_segment_idx` ON `normal_chat_run_log` (`segment_id`);
