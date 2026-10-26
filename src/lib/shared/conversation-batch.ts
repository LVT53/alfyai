/**
 * The contract of `POST /api/conversations/batch`, shared by the route (and the
 * services behind it) and the browser's chunked call. One request names one
 * action and at most `CONVERSATION_BATCH_MAX_IDS` chats; the answer holds one
 * result per id, in the order the ids were sent.
 */

/** The most chats one request may name. The browser sends more in chunks. */
export const CONVERSATION_BATCH_MAX_IDS = 50;

export type ConversationBatchRequest =
	| { action: "delete"; ids: string[] }
	| { action: "move"; ids: string[]; projectId: string | null }
	| { action: "pin"; ids: string[]; pinned: boolean };

/** The server sends `not_found` or `failed`; the browser marks every id of a chunk whose request failed `unknown`. */
export type ConversationBatchFailure = "not_found" | "failed" | "unknown";

export type ConversationBatchResult<TConversation = never> =
	| { id: string; ok: true; conversation?: TConversation }
	| { id: string; ok: false; error: ConversationBatchFailure };
