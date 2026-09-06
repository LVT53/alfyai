-- Skills moved from session-based activation (durable Skill Sessions with
-- milestones and note-write checkpoints) to on-demand loading: a catalogue
-- line in the per-turn packet plus a `use_skill` tool call or an explicit `$`
-- selection, both scoped to a single turn. Skill Sessions, their milestones,
-- and the note create/replace/append checkpoint trail no longer have a
-- producer, so their tables are dropped outright (only a handful of test
-- rows existed in any deployed database). Skill definitions, packs, and
-- variants (`user_skill_definitions`) are untouched — users and admins still
-- create/edit/enable/disable those in Settings.
--
-- Drop order is children-before-parents to respect the FK chain:
-- skill_note_checkpoints / skill_note_operations -> skill_sessions,
-- skill_session_milestones -> skill_sessions.
DROP TABLE IF EXISTS `skill_note_checkpoints`;
--> statement-breakpoint
DROP TABLE IF EXISTS `skill_note_operations`;
--> statement-breakpoint
DROP TABLE IF EXISTS `skill_session_milestones`;
--> statement-breakpoint
DROP TABLE IF EXISTS `skill_sessions`;
