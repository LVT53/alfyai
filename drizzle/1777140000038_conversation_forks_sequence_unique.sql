CREATE UNIQUE INDEX `conversation_forks_user_source_assistant_sequence_unique_idx` ON `conversation_forks` (`user_id`,`source_assistant_message_id_snapshot`,`fork_sequence`);
