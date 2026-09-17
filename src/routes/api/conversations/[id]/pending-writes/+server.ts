import { json } from "@sveltejs/kit";
import { requireAuth } from "$lib/server/auth/hooks";
import {
	isPendingWriteExpired,
	listPendingWritesForConversation,
} from "$lib/server/services/connections/pending-writes";
import { getConversation } from "$lib/server/services/conversations";
import type { RequestHandler } from "./$types";

// GET /api/conversations/[id]/pending-writes — Issue 7.5. Read side of the
// inline write-confirm card: mirrors listConversationFileProductionJobs +
// its embedding in the conversation-detail read model, but as its own
// dedicated, user+conversation-scoped endpoint (connection_pending_writes
// isn't part of ConversationDetail). Returns only the fields already safe
// to show the user — the `preview` a write proposal already produced
// (write-guard, 4.1), never the raw op/content payload the write tool
// built (pending-writes.ts's `op`/`content` on PendingWriteRecord).
export const GET: RequestHandler = async (event) => {
	requireAuth(event);
	const userId = event.locals.user.id;
	const conversationId = event.params.id;

	const conversation = await getConversation(userId, conversationId);
	if (!conversation) {
		return json({ error: "Conversation not found" }, { status: 404 });
	}

	const records = await listPendingWritesForConversation(
		userId,
		conversationId,
	);

	return json({
		// PendingWriteRecord.createdAt is UNIX seconds (pending-writes.ts's
		// toRecord); every other client-facing timestamp (ChatMessage,
		// FileProductionJob) is epoch milliseconds — MessageArea's
		// getPendingWritesForMessage compares this against message.timestamp,
		// so it's converted to ms here at the API boundary rather than
		// leaking the seconds-vs-ms mismatch into client code.
		pendingWrites: records.map((record) => ({
			id: record.id,
			assistantMessageId: record.assistantMessageId,
			conversationId: record.conversationId,
			// A row past its TTL is still stored as "pending" — nothing sweeps
			// the table, the status only moves when a confirm walks into it.
			// Reported as-is, the card would offer Confirm and Cancel buttons
			// the server is guaranteed to refuse. Project the state the confirm
			// chokepoint would give it, using that same predicate, so a reload
			// shows "expired" immediately instead of after a pointless click.
			status:
				record.status === "pending" && isPendingWriteExpired(record.expiresAt)
					? "expired"
					: record.status,
			preview: record.preview,
			provider: record.provider,
			createdAt: record.createdAt * 1000,
		})),
	});
};
