-- The person's IANA time zone ("Europe/Budapest"), which the model is told as
-- their local clock. Expand-only: one nullable column with no default, so every
-- existing person starts with no zone and the first browser they open saves its
-- own (until then the prompt keeps the server's date and says the zone is
-- unknown).
ALTER TABLE `users` ADD `time_zone` text;
