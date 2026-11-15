-- A video take's length (docs/plans/ltx-video, slice 2). Expand-only: one
-- nullable column with no default, so every existing picture row reads as "this
-- is not a clip" and no row is rewritten. A clip's poster and thumbnail are
-- derived paths beside its `<id>.mp4` (`services/images/video-files.ts`), so
-- this is the only new storage the kind adds.
ALTER TABLE `image_files` ADD `duration_ms` integer;
