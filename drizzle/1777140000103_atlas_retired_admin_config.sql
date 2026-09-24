-- Phase B of the v3-only Atlas consolidation: v1/v2 pipelines deleted,
-- ATLAS_PIPELINE removed, ATLAS_V3_VERIFIER_MODEL removed (resolved but never
-- called). Any admin_config row for one of these keys is now inert —
-- refreshConfig() only applies keys listed in ADMIN_CONFIG_KEYS, so a stale
-- row was already harmless — but this sweep removes them so the table does
-- not keep dead overrides an admin might mistake for live config.
-- Schema is unchanged: admin_config has no CHECK constraint on `key` (a plain
-- TEXT column, enforced only in TypeScript via ADMIN_CONFIG_KEYS), so this is
-- a data-only cleanup.
DELETE FROM `admin_config` WHERE `key` IN (
	'ATLAS_PIPELINE',
	'ATLAS_SEARCH_CONCURRENCY',
	'ATLAS_SEARCH_BATCH_DELAY_MS',
	'ATLAS_OVERVIEW_MAX_OUTPUT_TOKENS',
	'ATLAS_IN_DEPTH_MAX_OUTPUT_TOKENS',
	'ATLAS_EXHAUSTIVE_MAX_OUTPUT_TOKENS',
	'ATLAS_MAX_WRITER_PROMPT_CHARS',
	'ATLAS_V2_QUESTIONS_OVERVIEW',
	'ATLAS_V2_QUESTIONS_IN_DEPTH',
	'ATLAS_V2_QUESTIONS_EXHAUSTIVE',
	'ATLAS_V2_ROUNDS_OVERVIEW',
	'ATLAS_V2_ROUNDS_IN_DEPTH',
	'ATLAS_V2_ROUNDS_EXHAUSTIVE',
	'ATLAS_V2_MAX_WORDS_OVERVIEW',
	'ATLAS_V2_MAX_WORDS_IN_DEPTH',
	'ATLAS_V2_MAX_WORDS_EXHAUSTIVE',
	'ATLAS_V2_MAX_SOURCES_OVERVIEW',
	'ATLAS_V2_MAX_SOURCES_IN_DEPTH',
	'ATLAS_V2_MAX_SOURCES_EXHAUSTIVE',
	'ATLAS_V2_ENTAILMENT_BATCH',
	'ATLAS_V2_WRITER_CONCURRENCY',
	'ATLAS_V3_VERIFIER_MODEL'
);
