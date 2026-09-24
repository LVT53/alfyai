-- Owner-approved one-off recency backfill (2026-09). Past project-folder
-- moves and conversation renames bumped `conversations.updated_at` before the
-- companion code fixes in this same change stopped that
-- (`moveConversationToProject` / `updateConversationTitle` in
-- src/lib/server/services/conversations.ts). Any conversation touched by one
-- of those organizational actions before the fix landed can still carry an
-- inflated `updated_at` that no longer reflects when anything was actually
-- said in it, so it out-ranks genuinely active chats in the sidebar's
-- recency sort and the home page's "recent" rail (both order by this same
-- column).
--
-- This resets `updated_at` back to the conversation's own last real message
-- time. `conversations.updated_at` and `messages.created_at` are both
-- Drizzle `mode: "timestamp"` columns (see src/lib/server/db/schema.ts) —
-- plain unix-seconds integers — so no unit conversion is needed between them.
--
-- Only `messages.role IN ('user', 'assistant')` rows count as real turns.
-- Those are the only two values `createMessage()`
-- (src/lib/server/services/messages.ts) ever persists (`MessageRole = "user"
-- | "assistant"`), and the ChatGPT import path
-- (src/lib/server/services/chatgpt-import/parser.ts) already drops
-- "system"/"tool"-authored nodes before rows reach the `messages` table.
-- Filtering by role here is a defense-in-depth guard, not a workaround for
-- real data — it also keeps the `MAX(...)` subquery from ever handing a NULL
-- to this NOT NULL column if some future or historical path ever landed a
-- non-turn row. There is no separate draft/deleted-message flag to exclude:
-- drafts live in a different table (`conversation_drafts`) and deleted
-- messages are hard-deleted, so neither ever reaches this query.
--
-- Conversations with no qualifying messages (including brand-new/prepared
-- conversations nothing was ever sent into) are left untouched: the `EXISTS`
-- guard uses the same role filter as the `MAX(...)` computation, so a
-- conversation with only non-turn rows is skipped rather than having its
-- `updated_at` set to NULL.
--
-- Only genuinely inflated rows are rewritten: `updated_at` must be more than
-- 15 minutes (900 s) past the last real message. A normal turn always leaves
-- `updated_at` a few seconds after its last message (`touchConversation` runs
-- at turn completion, after the assistant message row is created), and a prod
-- dry run showed most conversations differing by <= 60 s for exactly that
-- reason; those are left alone, as are rows whose `updated_at` is at or
-- before their last message. Only the organizational bumps this backfill
-- targets (typically hours to days later) cross the threshold.
--
-- Idempotent: a rewritten row ends with `updated_at` equal to its last real
-- message time, which no longer satisfies the `> ... + 900` guard, so
-- re-running this migration is a no-op.
UPDATE `conversations`
SET `updated_at` = (
	SELECT MAX(m.created_at)
	FROM `messages` m
	WHERE m.conversation_id = `conversations`.`id`
		AND m.role IN ('user', 'assistant')
)
WHERE EXISTS (
	SELECT 1
	FROM `messages` m
	WHERE m.conversation_id = `conversations`.`id`
		AND m.role IN ('user', 'assistant')
)
AND `updated_at` > (
	SELECT MAX(m.created_at)
	FROM `messages` m
	WHERE m.conversation_id = `conversations`.`id`
		AND m.role IN ('user', 'assistant')
) + 900;
