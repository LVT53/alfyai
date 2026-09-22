import { eq, or, type SQL } from "drizzle-orm";
import { conversations } from "$lib/server/db/schema";

/**
 * Which conversations a CONTEXT read may see, in one place.
 *
 * This is the conversation-side twin of `getArtifactOwnershipScope`
 * (`knowledge/store/core.ts`), and it exists for the same reason. Incognito is
 * a promise the composer makes in plain words — "nothing here is remembered" —
 * and the privacy policy calls the mode "saved-but-untracked": the chat is kept
 * so the user can revisit it, and it is never used to personalize future
 * replies. Until this helper existed that promise was enforced on the memory
 * WRITE side only (the judge refuses to learn from an incognito turn), and the
 * READ side had a hole: `memory_context` in `history` mode searched every
 * conversation the user owned, so from an ordinary chat the model could pull
 * back the title, the summary and the raw user messages of an incognito one —
 * including whatever the user typed there precisely because it would not be
 * remembered.
 *
 * So every cross-conversation read whose result can reach a MODEL goes through
 * this condition, rather than each of them remembering a `memoryIncognito`
 * term of its own. Add it to the `where` of any query that joins or selects
 * `conversations` for a user and is not pinned to one conversation.
 *
 * What is deliberately NOT behind it:
 *
 *  - UI listings the user reads themselves — the sidebar, workspace search,
 *    the home screen. Incognito hides a chat from the assistant, not from the
 *    person who had it; the sidebar even marks it with a badge.
 *  - the conversation's own page, and any query pinned to a single
 *    conversation id, which is this same boundary spelled directly.
 *  - administration: deletion, export, erasure. Those must see every row the
 *    user owns, or an incognito conversation would become undeletable.
 */
export type ConversationContextScopeOptions = {
	/**
	 * The conversation being served. Its own rows stay in scope even when it is
	 * incognito: incognito hides a chat from the user's OTHER chats, never from
	 * itself, and inside it history, continuity and recall keep working.
	 */
	conversationId?: string | null;
};

/**
 * The `where` term that excludes every incognito conversation but the one
 * asking. Pass it to `and(...)` beside the query's own conditions.
 *
 * The CURRENT setting governs, as it does everywhere else incognito is read
 * (`memory-controls.ts`, `getArtifactOwnershipScope`, `listUserChatFilesElsewhere`):
 * the flag lives on the chat, not on the rows it produced, and turning it off
 * re-admits that chat's earlier turns exactly as it re-admits its earlier files.
 */
export function buildConversationContextScopeCondition(
	options: ConversationContextScopeOptions = {},
): SQL {
	const notIncognito = eq(conversations.memoryIncognito, false);
	const currentConversationId = options.conversationId?.trim();
	if (!currentConversationId) return notIncognito;
	return or(notIncognito, eq(conversations.id, currentConversationId)) as SQL;
}
