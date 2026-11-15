-- The video item a take made, recorded so a retry appends to it instead of
-- creating a second Video (video runner, review A item 8).
--
-- Its own migration, not an edit to 1777140000128: that one has already run on
-- databases (a local one did), and Drizzle tracks by `when`, so an edited
-- migration never re-runs and the column would simply be missing. Expand-only:
-- one nullable column.
ALTER TABLE `video_jobs` ADD `created_artifact_id` text;
