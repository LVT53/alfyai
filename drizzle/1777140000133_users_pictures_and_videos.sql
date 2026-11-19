-- "Pictures and videos" (Settings > Profile): a person's own switch for whether
-- Alfy may make pictures and videos in their chats. On by default, which is what
-- every account did before the switch existed, so an account that is already
-- here keeps making them. Expand-only: one column, so undoing it is a drop.
ALTER TABLE `users` ADD `pictures_and_videos_enabled` integer DEFAULT true NOT NULL;
