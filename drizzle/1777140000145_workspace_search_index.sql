-- Workspace Search Stage B (docs/superpowers/specs/2026-11-23-workspace-search-revival-design.md,
-- section 6): message text and the text of documents and files go into two
-- trigram full-text indexes, so a word is found anywhere inside a longer word
-- ("ajánlat" in "szállásajánlatok") whatever its case and accents ("arviz",
-- "árvíz", "ÁrVíZ" all find "Árvíztűrő").
--
-- Contentless-delete tables (content='', contentless_delete=1) keep no copy of
-- the text and delete by row id alone, so a delete never has to repeat the old
-- values (an external-content table's 'delete' with values that differ from
-- what was indexed is SQLITE_CORRUPT_VTAB, which would break message edits,
-- chat deletes and erasure). The index row's rowid is the base row's rowid.
-- The app runs no VACUUM and its backups use SQLite's online backup API, which
-- keep row ids. A later migration that rebuilds `messages` or `artifacts` must
-- empty this index, refill it and create the triggers again (a test holds it:
-- src/lib/server/db/workspace-search-index-migration.test.ts), and nothing may
-- INSERT OR REPLACE into either table (REPLACE skips delete triggers).
-- `npm run search:index` checks the index against the tables and refills it.
--
-- What is indexed, with one condition used by every trigger and the fill:
-- * a message whose text is not empty (any role, as search has always read them);
-- * an artifact whose text is not empty and that is an upload or its extracted
--   text (source_document, normalized_document), a Skill Note, a generated file
--   (every generated_output: its type never changes after a write, while the
--   retrieval class and metadata that make it a listed file can), or a member
--   of the artifact family whose kind is not image, video, canvas or app (a
--   Document or Slides; a missing kind lists as a document). Never App code,
--   picture, video or canvas JSON, nor a work capsule (internal; search never
--   returned one). The search's own conditions still decide what it returns.
CREATE VIRTUAL TABLE `messages_fts` USING fts5(content, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1');
--> statement-breakpoint
CREATE VIRTUAL TABLE `artifacts_fts` USING fts5(content_text, content='', contentless_delete=1, tokenize='trigram remove_diacritics 1');
--> statement-breakpoint
INSERT INTO messages_fts(rowid, content)
SELECT rowid, content FROM messages
WHERE length(content) > 0;
--> statement-breakpoint
INSERT INTO artifacts_fts(rowid, content_text)
SELECT rowid, content_text FROM artifacts
WHERE length(content_text) > 0 AND (
	type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
	OR (type = 'artifact' AND coalesce(CASE WHEN json_valid(metadata_json) THEN json_extract(metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
);
--> statement-breakpoint
CREATE TRIGGER `messages_fts_insert`
AFTER INSERT ON messages
WHEN length(NEW.content) > 0
BEGIN
	INSERT INTO messages_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_update`
AFTER UPDATE OF content ON messages
WHEN NEW.content IS NOT OLD.content
BEGIN
	DELETE FROM messages_fts WHERE rowid = OLD.rowid AND length(OLD.content) > 0;
	INSERT INTO messages_fts(rowid, content) SELECT NEW.rowid, NEW.content WHERE length(NEW.content) > 0;
END;
--> statement-breakpoint
CREATE TRIGGER `messages_fts_delete`
AFTER DELETE ON messages
WHEN length(OLD.content) > 0
BEGIN
	DELETE FROM messages_fts WHERE rowid = OLD.rowid;
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_fts_insert`
AFTER INSERT ON artifacts
WHEN length(NEW.content_text) > 0 AND (
	NEW.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
	OR (NEW.type = 'artifact' AND coalesce(CASE WHEN json_valid(NEW.metadata_json) THEN json_extract(NEW.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
)
BEGIN
	INSERT INTO artifacts_fts(rowid, content_text) VALUES (NEW.rowid, NEW.content_text);
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_fts_update`
AFTER UPDATE OF content_text, type, metadata_json ON artifacts
WHEN NEW.content_text IS NOT OLD.content_text
	OR coalesce(length(NEW.content_text) > 0 AND (
		NEW.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
		OR (NEW.type = 'artifact' AND coalesce(CASE WHEN json_valid(NEW.metadata_json) THEN json_extract(NEW.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
	), 0) IS NOT coalesce(length(OLD.content_text) > 0 AND (
		OLD.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
		OR (OLD.type = 'artifact' AND coalesce(CASE WHEN json_valid(OLD.metadata_json) THEN json_extract(OLD.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
	), 0)
BEGIN
	DELETE FROM artifacts_fts WHERE rowid = OLD.rowid AND length(OLD.content_text) > 0 AND (
		OLD.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
		OR (OLD.type = 'artifact' AND coalesce(CASE WHEN json_valid(OLD.metadata_json) THEN json_extract(OLD.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
	);
	INSERT INTO artifacts_fts(rowid, content_text) SELECT NEW.rowid, NEW.content_text WHERE length(NEW.content_text) > 0 AND (
		NEW.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
		OR (NEW.type = 'artifact' AND coalesce(CASE WHEN json_valid(NEW.metadata_json) THEN json_extract(NEW.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
	);
END;
--> statement-breakpoint
CREATE TRIGGER `artifacts_fts_delete`
AFTER DELETE ON artifacts
WHEN length(OLD.content_text) > 0 AND (
	OLD.type IN ('source_document', 'normalized_document', 'skill_note', 'generated_output')
	OR (OLD.type = 'artifact' AND coalesce(CASE WHEN json_valid(OLD.metadata_json) THEN json_extract(OLD.metadata_json, '$.artifactType') END, 'document') NOT IN ('image', 'video', 'canvas', 'app'))
)
BEGIN
	DELETE FROM artifacts_fts WHERE rowid = OLD.rowid;
END;
