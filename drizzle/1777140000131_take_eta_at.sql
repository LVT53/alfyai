-- When a picture or video take is expected to be done (milliseconds), written
-- by the runner's estimate (`services/images/take-eta.ts`) and counted down by
-- the card. It replaces `eta_seconds`, the seconds left at the moment of a
-- write, which stood still between progress events and could rise. Expand-only:
-- one nullable column per table. `eta_seconds` stays in the tables, unread and
-- no longer written, for a later contract migration.
ALTER TABLE `image_jobs` ADD `eta_at` integer;
--> statement-breakpoint
ALTER TABLE `video_jobs` ADD `eta_at` integer;
