import { eq } from "drizzle-orm";
import { db } from "$lib/server/db";
import { conversations, users } from "$lib/server/db/schema";

/**
 * Per-user + per-conversation memory controls.
 *
 * Two independent switches gate the memory subsystem:
 *  - users.memoryEnabled: the user's master toggle. When false, nothing is
 *    learned OR recalled for this user anywhere.
 *  - conversations.memoryIncognito: a per-conversation privacy mode. When true,
 *    that conversation is never fed to the memory pipeline AND never has memory
 *    or project context injected into its prompts.
 *
 * These helpers are the single source of truth for those gates so the write
 * side (judge intake, consolidation) and the read side (context injection) stay
 * consistent.
 */

export async function isUserMemoryEnabled(userId: string): Promise<boolean> {
	const [row] = await db
		.select({ memoryEnabled: users.memoryEnabled })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	// Default to enabled when the user row is missing — fail open rather than
	// silently dropping memory for a valid session.
	return row ? row.memoryEnabled : true;
}

export async function isConversationIncognito(
	conversationId: string,
): Promise<boolean> {
	const [row] = await db
		.select({ memoryIncognito: conversations.memoryIncognito })
		.from(conversations)
		.where(eq(conversations.id, conversationId))
		.limit(1);
	return row ? row.memoryIncognito : false;
}

/**
 * Whether memory should be captured/recalled for a specific conversation:
 * the user's master toggle is on AND the conversation is not incognito.
 * One query per flag; callers in hot paths should treat failures as "enabled"
 * (fail open) by catching, matching the defaults above.
 */
export async function isMemoryActiveForConversation(params: {
	userId: string;
	conversationId: string;
}): Promise<boolean> {
	const [userEnabled, incognito] = await Promise.all([
		isUserMemoryEnabled(params.userId),
		isConversationIncognito(params.conversationId),
	]);
	return userEnabled && !incognito;
}
