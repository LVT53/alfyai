CREATE TABLE `memory_quarantine_sessions` (
	`user_id` text PRIMARY KEY NOT NULL REFERENCES `memory_accounts`(`user_id`) ON DELETE CASCADE,
	`manifest_id` text NOT NULL REFERENCES `memory_migration_manifests`(`id`) ON DELETE CASCADE,
	`epoch` integer NOT NULL,
	`control_revision` integer NOT NULL,
	`cutoff` integer NOT NULL,
	`policy_version` text NOT NULL,
	`cohort_hash` text NOT NULL,
	`manifest_hash` text NOT NULL,
	`allowed_cohort_hash` text NOT NULL,
	`denied_source_ids_json` text NOT NULL,
	`cohort_count` integer NOT NULL,
	`start_request_id` text,
	`started_at` integer,
	`review_policy_version` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_quarantine_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL REFERENCES `memory_quarantine_sessions`(`user_id`) ON DELETE CASCADE,
	`message_id` text REFERENCES `messages`(`id`) ON DELETE SET NULL,
	`scope_key` text NOT NULL,
	`text_hash` text NOT NULL,
	`asserted_at` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`text` text,
	`decision` text,
	`decision_request_id` text,
	`decision_text_hash` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_quarantine_draft_text_idx` ON `memory_quarantine_drafts` (`user_id`,`scope_key`,`text_hash`);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_quarantine_draft_ordinal_idx` ON `memory_quarantine_drafts` (`user_id`,`message_id`,`ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `memory_quarantine_draft_request_idx` ON `memory_quarantine_drafts` (`user_id`,`decision_request_id`);
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_account_change`
AFTER UPDATE OF epoch, control_revision, lifecycle_state, history_choice, history_cutoff, history_policy_version, authority ON memory_accounts
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.control_revision IS NOT OLD.control_revision
	OR NEW.lifecycle_state IS NOT OLD.lifecycle_state OR NEW.history_choice IS NOT OLD.history_choice
	OR NEW.history_cutoff IS NOT OLD.history_cutoff OR NEW.history_policy_version IS NOT OLD.history_policy_version
	OR (OLD.authority IS NOT NEW.authority AND NEW.authority = 'legacy')
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_message_change`
AFTER UPDATE OF content, role, conversation_id, created_at, import_source, metadata_json ON messages
WHEN NEW.content IS NOT OLD.content OR NEW.role IS NOT OLD.role OR NEW.conversation_id IS NOT OLD.conversation_id
	OR NEW.created_at IS NOT OLD.created_at OR NEW.import_source IS NOT OLD.import_source OR NEW.metadata_json IS NOT OLD.metadata_json
BEGIN
	DELETE FROM memory_quarantine_drafts WHERE message_id=OLD.id AND decision IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_scope_change`
AFTER UPDATE OF user_id, project_id, memory_incognito ON conversations
WHEN NEW.user_id IS NOT OLD.user_id OR NEW.project_id IS NOT OLD.project_id OR NEW.memory_incognito IS NOT OLD.memory_incognito
BEGIN
	DELETE FROM memory_quarantine_drafts WHERE decision IS NULL AND message_id IN (
		SELECT id FROM messages WHERE conversation_id=OLD.id
	);
	UPDATE memory_quarantine_drafts SET message_id=NULL WHERE decision IS NOT NULL AND message_id IN (
		SELECT id FROM messages WHERE conversation_id=OLD.id
	);
END;

--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_message_delete`
BEFORE DELETE ON messages
BEGIN
	DELETE FROM memory_quarantine_drafts WHERE message_id=OLD.id AND decision IS NULL;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_disable`
AFTER UPDATE OF memory_enabled ON users
WHEN OLD.memory_enabled=1 AND NEW.memory_enabled=0
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_reset`
AFTER UPDATE OF reset_generation ON memory_reset_generations
WHEN OLD.reset_generation IS NOT NEW.reset_generation
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_source_revocation`
AFTER INSERT ON memory_revocations
WHEN NEW.source_id IS NOT NULL
BEGIN
	DELETE FROM memory_quarantine_drafts WHERE user_id=NEW.user_id AND decision IS NULL AND message_id IN (
		SELECT message_id FROM memory_source_revisions WHERE id=NEW.source_id AND user_id=NEW.user_id
	);
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_legacy_exclusion`
AFTER UPDATE OF status, deleted_at, suppressed_at ON memory_profile_items
WHEN (NEW.status IN ('deleted','retired','suppressed') AND OLD.status IS NOT NEW.status)
	OR OLD.deleted_at IS NOT NEW.deleted_at OR OLD.suppressed_at IS NOT NEW.suppressed_at
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_legacy_review`
AFTER INSERT ON memory_review_resolutions
WHEN NEW.resolution_type IN ('edit_fact','do_not_remember')
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_manifest_rewrite`
AFTER UPDATE OF manifest_json ON memory_migration_manifests
WHEN NEW.manifest_json IS NOT OLD.manifest_json
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE manifest_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_native_removal`
AFTER INSERT ON memory_actions
WHEN NEW.kind='remove' AND NEW.exclusion_acknowledged=1
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=NEW.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_quarantine_native_edit`
AFTER UPDATE OF intent_json ON memory_actions
WHEN NEW.kind='edit' AND json_valid(NEW.intent_json)
	AND json_extract(NEW.intent_json, '$.outcome')='accepted'
	AND (OLD.intent_json IS NULL OR NOT json_valid(OLD.intent_json)
		OR json_extract(OLD.intent_json, '$.outcome') IS NOT 'accepted')
BEGIN
	DELETE FROM memory_quarantine_sessions WHERE user_id=NEW.user_id;
END;
