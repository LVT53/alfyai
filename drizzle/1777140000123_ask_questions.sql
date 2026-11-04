-- Ask me first (docs/plans/ask-me-first, Part 1 Task 2: Alfy stops a reply to
-- ask the person 1 to 3 questions and carries the same reply on from the
-- answer).
--
-- One row per question a reply paused on: the questions as Alfy sent them
-- (`questions_json`), the person's answer (`answer_json`), and what the resume
-- needs to carry the reply on (`resume_json`, written in the same UPDATE that
-- stamps `assistant_message_id`, cleared when the question settles or is
-- discarded). `status` is waiting, answering, answered, closed or discarded.
-- `assistant_message_id` stays NULL until the asking segment is saved, and
-- only a row that has one can be claimed by an answer.
--
-- `created_at`, `answered_at` and `settled_at` are unix seconds, like every
-- table. The rows leave with their chat, with the message that asked and with
-- their person (all three cascade).
CREATE TABLE `ask_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`assistant_message_id` text,
	`tool_call_id` text NOT NULL,
	`questions_json` text NOT NULL,
	`status` text DEFAULT 'waiting' NOT NULL,
	`answer_json` text,
	`resume_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`answered_at` integer,
	`settled_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assistant_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ask_questions_conversation_created_idx` ON `ask_questions` (`conversation_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `ask_questions_assistant_message_idx` ON `ask_questions` (`assistant_message_id`);
--> statement-breakpoint
CREATE INDEX `ask_questions_user_status_idx` ON `ask_questions` (`user_id`,`status`);
