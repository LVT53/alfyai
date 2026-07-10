/**
 * Central tuning constants for the Memory Judge module.
 *
 * These co-locate the intake caps that used to live inline in `index.ts` with
 * the post-turn trigger-tier constant that used to be a bare `>= 25` literal in
 * `chat-turn/finalize.ts`. Keeping them together makes the judge's operating
 * envelope discoverable in one place instead of scattered across finalize.ts,
 * runner.ts, and index.ts.
 */

/**
 * The three-tier post-turn trigger policy (explicit / marathon / idle) escalates
 * an ordinary turn to an IMMEDIATE marathon judge once this many messages sit
 * unjudged below the conversation watermark. Below it, the turn only schedules a
 * debounced idle pass. Owned by `judgeFinishedTurn` (dispatch.ts).
 */
export const MARATHON_UNJUDGED_THRESHOLD = 25;

/**
 * Maximum number of concurrently-open inferred review items. When this cap is
 * hit the judge drops further inferred candidates (telemetry: judge_review_cap_hit)
 * rather than flooding the review queue.
 */
export const REVIEW_OPEN_CAP = 10;

/** Auto-expiry window (days) applied to inferred review_needed items. */
export const REVIEW_EXPIRY_DAYS = 30;
