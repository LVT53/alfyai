-- message-analytics-latency.sql
--
-- p50 / p95 latency report for recent chat turns, sourced from
-- `message_analytics` (src/lib/server/db/schema.ts).
--
-- SEMANTICS — read this before trusting the numbers:
--   * first_byte_ms, first_thinking_ms, first_token_ms are SERVER-SIDE marks:
--     milliseconds elapsed since turn start as measured on the AlfyAI
--     server, from src/lib/services/stream-timeline.ts's
--     SERVER_STREAM_TIMELINE_MARKS (FIRST_UPSTREAM_EVENT/MODEL_STREAM_REQUEST,
--     FIRST_THINKING, FIRST_VISIBLE_TOKEN respectively — see ADR-0042's "M1"
--     amendment). There is NO browser->server timing channel in this app, so
--     these numbers do NOT include browser/network transit time to the
--     client. They answer "how much of the wait is server-side prep vs
--     model reasoning/generation", not "what did the user's browser see".
--   * generation_time_ms is the existing end-to-end server generation
--     duration (wall clock from request start to stream completion).
--   * All four columns are nullable: first_thinking_ms is null for turns
--     with no reasoning; any column can be null for a turn that stopped or
--     errored before reaching that phase (see ADR-0042 amendment — a
--     stopped/errored turn still records whichever marks it reached). NULLs
--     are excluded from each column's own percentile calculation below
--     (an absent mark is not a zero-latency sample), so sample_count can
--     differ per metric row.
--
-- USAGE
--   sqlite3 <path-to-db> < scripts/sql/message-analytics-latency.sql
--   -- or, to change the lookback window, edit the `recent` CTE's
--   -- `created_at >= unixepoch() - N` clause below (default: last 7 days).
--
-- PERCENTILE METHOD — SQLite has no built-in PERCENTILE_CONT/PERCENTILE_DISC
-- aggregate. This uses the standard "nearest-rank" approximation: rank every
-- non-null sample for a column ascending via ROW_NUMBER(), then pick the
-- sample at rank = ceil(p * n) (n = sample count, p = 0.50 or 0.95), clamped
-- to at least rank 1. This is the nearest-rank definition most APM/
-- monitoring tools use for percentiles; it picks an actual observed sample
-- rather than interpolating between two, so results are exact and stable.
-- ceil(p * n) is computed with integer-only arithmetic — ceil(a/b) for
-- positive integers a, b is (a + b - 1) / b under SQLite's truncating
-- integer division — so this needs nothing beyond core SQLite window
-- functions (ROW_NUMBER/COUNT OVER, available since SQLite 3.25).

WITH recent AS (
	SELECT
		id,
		model,
		first_byte_ms,
		first_thinking_ms,
		first_token_ms,
		generation_time_ms
	FROM message_analytics
	-- Lookback window: last 7 days. Adjust as needed.
	WHERE created_at >= unixepoch() - (7 * 24 * 60 * 60)
),
ranked_first_byte AS (
	SELECT
		first_byte_ms AS value,
		ROW_NUMBER() OVER (ORDER BY first_byte_ms ASC) AS rn,
		COUNT(*) OVER () AS n
	FROM recent
	WHERE first_byte_ms IS NOT NULL
),
ranked_first_thinking AS (
	SELECT
		first_thinking_ms AS value,
		ROW_NUMBER() OVER (ORDER BY first_thinking_ms ASC) AS rn,
		COUNT(*) OVER () AS n
	FROM recent
	WHERE first_thinking_ms IS NOT NULL
),
ranked_first_token AS (
	SELECT
		first_token_ms AS value,
		ROW_NUMBER() OVER (ORDER BY first_token_ms ASC) AS rn,
		COUNT(*) OVER () AS n
	FROM recent
	WHERE first_token_ms IS NOT NULL
),
ranked_generation AS (
	SELECT
		generation_time_ms AS value,
		ROW_NUMBER() OVER (ORDER BY generation_time_ms ASC) AS rn,
		COUNT(*) OVER () AS n
	FROM recent
	WHERE generation_time_ms IS NOT NULL
)
-- nearest-rank(p, n) = MAX(1, (p_numerator * n + 99) / 100), integer division
-- i.e. ceil(p_numerator * n / 100) clamped to >= 1.
SELECT
	'first_byte_ms' AS metric,
	(SELECT COUNT(*) FROM ranked_first_byte) AS sample_count,
	(SELECT value FROM ranked_first_byte
		WHERE rn = MAX(1, (50 * n + 99) / 100)) AS p50_ms,
	(SELECT value FROM ranked_first_byte
		WHERE rn = MAX(1, (95 * n + 99) / 100)) AS p95_ms
UNION ALL
SELECT
	'first_thinking_ms',
	(SELECT COUNT(*) FROM ranked_first_thinking),
	(SELECT value FROM ranked_first_thinking
		WHERE rn = MAX(1, (50 * n + 99) / 100)),
	(SELECT value FROM ranked_first_thinking
		WHERE rn = MAX(1, (95 * n + 99) / 100))
UNION ALL
SELECT
	'first_token_ms',
	(SELECT COUNT(*) FROM ranked_first_token),
	(SELECT value FROM ranked_first_token
		WHERE rn = MAX(1, (50 * n + 99) / 100)),
	(SELECT value FROM ranked_first_token
		WHERE rn = MAX(1, (95 * n + 99) / 100))
UNION ALL
SELECT
	'generation_time_ms',
	(SELECT COUNT(*) FROM ranked_generation),
	(SELECT value FROM ranked_generation
		WHERE rn = MAX(1, (50 * n + 99) / 100)),
	(SELECT value FROM ranked_generation
		WHERE rn = MAX(1, (95 * n + 99) / 100));
