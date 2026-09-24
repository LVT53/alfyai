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
-- Predicate (mirrors isLegacyAlfyAiPromptSnapshot in SQL). GLOB, not LIKE:
-- LIKE is case-insensitive and treats "_" as a one-character wildcard, so
-- '%generate_file%' would also match prose such as "generate files" in a
-- genuine custom prompt that the runtime check leaves alone, and this rewrite
-- would destroy it. GLOB is case-sensitive with a literal "_", and padding the
-- value with a space on each side lets '[^A-Za-z0-9_]' stand in for the
-- regex's \b word boundaries (JS \b without the u flag is ASCII [A-Za-z0-9_]),
-- including at the very start or end of the text:
--   key IN ('MODEL_1_SYSTEM_PROMPT', 'MODEL_2_SYSTEM_PROMPT', 'SYSTEM_PROMPT')
--   AND value names one of the retired tools as a whole identifier
--   AND the trimmed value names "AlfyAI" as a whole word in its first 400
--       characters
-- A row that is already 'alfyai-nemotron', empty, or a genuine custom prompt
-- without a retired tool identifier is left untouched, so this is idempotent
-- and safe to re-run.
UPDATE `admin_config`
SET `value` = 'alfyai-nemotron',
	`updated_at` = unixepoch()
WHERE `key` IN ('MODEL_1_SYSTEM_PROMPT', 'MODEL_2_SYSTEM_PROMPT', 'SYSTEM_PROMPT')
	AND `value` <> 'alfyai-nemotron'
	AND (
		(' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]get_current_date[^A-Za-z0-9_]*'
		OR (' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]run_python_repl[^A-Za-z0-9_]*'
		OR (' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]evaluate_expression[^A-Za-z0-9_]*'
		OR (' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]generate_file[^A-Za-z0-9_]*'
		OR (' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]export_document[^A-Za-z0-9_]*'
		OR (' ' || `value` || ' ') GLOB '*[^A-Za-z0-9_]fetch_content[^A-Za-z0-9_]*'
	)
	AND (
		' ' || substr(trim(`value`, ' ' || char(9, 10, 11, 12, 13)), 1, 400) || ' '
	) GLOB '*[^A-Za-z0-9_]AlfyAI[^A-Za-z0-9_]*';
