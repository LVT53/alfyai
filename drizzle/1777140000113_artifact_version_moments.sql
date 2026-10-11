-- Versioning (ruling 76, docs/design/artifacts-versioning/versioning.md §4.4):
-- the two facts a version row could not derive, both nullable and not backfilled.
-- `started_at` is a typing burst's FIRST save (unix seconds): `created_at` moves
-- with every coalesced save, so without it a burst's start is lost. NULL on rows
-- written before this column (History then shows the last save only).
-- `label` is the reader's name for the version (at most 60 characters), NULL
-- when unnamed; a named version is never coalesced into, so its words stay put.
ALTER TABLE `artifact_versions` ADD `started_at` integer;
--> statement-breakpoint
ALTER TABLE `artifact_versions` ADD `label` text;
