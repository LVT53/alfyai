-- The Memory page's Overview (Memory part 3): one paragraph per bank, written
-- by the local model when the person opens it, from the entries the page shows
-- as current. One row per bank and no history: a rewrite replaces it. It is
-- deleted whenever the bank's entries can change, by the triggers below, and a
-- read whose entries no longer match `entries_hash` deletes it too.
CREATE TABLE IF NOT EXISTS `memory_overviews` (
	`bank_id` text PRIMARY KEY NOT NULL REFERENCES `memory_banks`(`id`) ON DELETE CASCADE,
	`user_id` text NOT NULL REFERENCES `users`(`id`) ON DELETE CASCADE,
	`language` text NOT NULL,
	`text` text NOT NULL,
	`entries_hash` text NOT NULL,
	`written_from` integer NOT NULL,
	`current_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `memory_overviews_user_idx` ON `memory_overviews` (`user_id`);
--> statement-breakpoint
CREATE TRIGGER `memory_overview_bank_change`
AFTER UPDATE OF generation, epoch, status ON memory_banks
WHEN NEW.generation IS NOT OLD.generation OR NEW.epoch IS NOT OLD.epoch OR NEW.status IS NOT OLD.status
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_revocation`
AFTER INSERT ON memory_revocations
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_source_change`
AFTER UPDATE OF state, acknowledged_facts_json, asserted_at, explicit_edit_at ON memory_source_revisions
WHEN NEW.state IS NOT OLD.state OR NEW.acknowledged_facts_json IS NOT OLD.acknowledged_facts_json
	OR NEW.asserted_at IS NOT OLD.asserted_at OR NEW.explicit_edit_at IS NOT OLD.explicit_edit_at
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_source_delete`
AFTER DELETE ON memory_source_revisions
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=OLD.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_row_insert`
AFTER INSERT ON memory_published_rows
WHEN NEW.generation IS (SELECT generation FROM memory_banks WHERE id=NEW.bank_id)
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_row_update`
AFTER UPDATE ON memory_published_rows
WHEN NEW.generation IS (SELECT generation FROM memory_banks WHERE id=NEW.bank_id)
	OR OLD.generation IS (SELECT generation FROM memory_banks WHERE id=OLD.bank_id)
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id OR bank_id=OLD.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_row_delete`
AFTER DELETE ON memory_published_rows
WHEN OLD.generation IS (SELECT generation FROM memory_banks WHERE id=OLD.bank_id)
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=OLD.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_label_insert`
AFTER INSERT ON memory_fact_labels
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_label_update`
AFTER UPDATE ON memory_fact_labels
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=NEW.bank_id OR bank_id=OLD.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_label_delete`
AFTER DELETE ON memory_fact_labels
BEGIN
	DELETE FROM memory_overviews WHERE bank_id=OLD.bank_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_account_change`
AFTER UPDATE OF epoch, lifecycle_state, authority ON memory_accounts
WHEN NEW.epoch IS NOT OLD.epoch OR NEW.lifecycle_state IS NOT OLD.lifecycle_state
	OR NEW.authority IS NOT OLD.authority
BEGIN
	DELETE FROM memory_overviews WHERE user_id=OLD.user_id;
END;
--> statement-breakpoint
CREATE TRIGGER `memory_overview_memory_off`
AFTER UPDATE OF memory_enabled ON users
WHEN OLD.memory_enabled=1 AND NEW.memory_enabled=0
BEGIN
	DELETE FROM memory_overviews WHERE user_id=OLD.id;
END;
