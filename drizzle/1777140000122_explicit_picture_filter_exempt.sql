-- The explicit-picture filter (plan 2b Task 18) is on for every person; an
-- admin may exempt one person in the Users pane. Expand-only: one column with
-- a default, so every existing person stays filtered.
ALTER TABLE `users` ADD `explicit_picture_filter_exempt` integer DEFAULT false NOT NULL;
