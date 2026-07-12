-- Slice A1 — Todoist is fully retired from the product. The `tasks` capability
-- is now served by CalDAV only. Delete every Todoist connection and its
-- encrypted secrets from the DB. The `provider` column is a plain TEXT column
-- (no native SQLite enum / no CHECK constraint enumerates providers — the value
-- set is enforced only in TypeScript via CONNECTION_PROVIDERS), so no DDL /
-- constraint rebuild is needed; this is a data-only, idempotent cleanup scoped
-- strictly to provider = 'todoist'.
--
-- Child rows first (connection_pending_writes references a connection), then the
-- parent user_connections rows.
DELETE FROM `connection_pending_writes` WHERE `provider` = 'todoist';
--> statement-breakpoint
DELETE FROM `connection_pending_writes`
WHERE `connection_id` IN (
	SELECT `id` FROM `user_connections` WHERE `provider` = 'todoist'
);
--> statement-breakpoint
DELETE FROM `user_connections` WHERE `provider` = 'todoist';
