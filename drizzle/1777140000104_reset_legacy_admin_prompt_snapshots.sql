-- MODEL_1_SYSTEM_PROMPT and MODEL_2_SYSTEM_PROMPT (and, on some deployments,
-- the global SYSTEM_PROMPT) can hold a full-text snapshot of an older
-- built-in AlfyAI prompt revision, captured back when the admin UI still
-- stored whole prompt bodies for these keys. The admin UI no longer surfaces
-- these hidden keys, so an admin who sees the
-- "[PROMPTS] ... legacy AlfyAI snapshot ..." warning in the logs has no way
-- to reset the value themselves.
--
-- src/lib/server/prompts.ts already treats such a snapshot as equivalent to
-- the built-in "alfyai-nemotron" key at read time
-- (normalizeSystemPromptReference / isLegacyAlfyAiPromptSnapshot): the
-- snapshot still names tools that were retired from the live prompt (see
-- RETIRED_TOOL_NAME_RE), and the text mentions "AlfyAI" near the top. This
-- migration performs the same resolution as a one-time data rewrite so the
-- stored value matches what it already resolves to, and the warning stops
-- firing once there is nothing left to normalize.
--
-- Predicate (mirrors isLegacyAlfyAiPromptSnapshot in SQL; LIKE-based
-- approximation of the \b...\b word-boundary regex checks, which is fine for
-- a one-time repair over known prompt snapshots):
--   key IN ('MODEL_1_SYSTEM_PROMPT', 'MODEL_2_SYSTEM_PROMPT', 'SYSTEM_PROMPT')
--   AND value mentions one of the retired tool names anywhere
--   AND value mentions "AlfyAI" within its first 400 characters
-- A row that is already 'alfyai-nemotron', empty, or a genuine custom prompt
-- without a retired tool name is left untouched, so this is idempotent and
-- safe to re-run.
UPDATE `admin_config`
SET `value` = 'alfyai-nemotron',
	`updated_at` = unixepoch()
WHERE `key` IN ('MODEL_1_SYSTEM_PROMPT', 'MODEL_2_SYSTEM_PROMPT', 'SYSTEM_PROMPT')
	AND `value` <> 'alfyai-nemotron'
	AND (
		`value` LIKE '%get_current_date%'
		OR `value` LIKE '%run_python_repl%'
		OR `value` LIKE '%evaluate_expression%'
		OR `value` LIKE '%generate_file%'
		OR `value` LIKE '%export_document%'
		OR `value` LIKE '%fetch_content%'
	)
	AND instr(substr(`value`, 1, 400), 'AlfyAI') > 0;
