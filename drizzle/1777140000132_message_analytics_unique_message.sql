-- One timing row per message. schema.ts has declared
-- `message_analytics_message_unique_idx` since the table was written, but no
-- migration created it, so the writer's `onConflictDoNothing()` only ever met the
-- random primary key and a message saved twice kept two rows (the admin user
-- list, which counts calls through a join on this table, counted it twice).
--
-- Duplicates first. Each message keeps the row written last (the highest rowid)
-- and loses the others: that is the row every reader showed (the dashboard's
-- map kept the last row it read, the usage read took the last by rowid), so no
-- number on a page changes. Then the index.
--
-- Safe to run again, and on a database that already has the index: with one
-- row per message the DELETE matches nothing, and IF NOT EXISTS keeps the
-- index there is. The migrator runs both statements in one transaction, so an
-- index that fails leaves every row where it was.
DELETE FROM `message_analytics`
WHERE `rowid` NOT IN (
	SELECT MAX(`rowid`) FROM `message_analytics` GROUP BY `message_id`
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `message_analytics_message_unique_idx` ON `message_analytics` (`message_id`);
